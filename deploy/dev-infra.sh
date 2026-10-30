#!/usr/bin/env bash
# Development infrastructure on Podman: data stores, Keycloak, the gateway, the S3 and SMTP mocks, optional
# observability, one-shot init jobs, tenants and other operator tasks.
source "$(dirname "$0")/lib/common.sh"

usage() {
  cat >&2 <<'U'
usage: deploy/dev-infra.sh <command>
  up [--obs]                 start the infrastructure (and observability), migrate, apply the schema
  down | reset [--yes]       stop everything / stop and delete all volumes
  status | logs <service>    container status / follow a service's logs
  migrate | schema           re-run Postgres migrations + seed / Neo4j constraints and indexes
  tenant create <t_id> "<name>" | list | check|suspend|resume|delete|remove <t_id>
  tenant user <t_id> <username> [role ...]     local Keycloak user for a tenant
  quota <tenant> [metric=value ...]            show or change a tenant's limits
  token [user]               access token for a dev user (default dev-admin)
  doctor                     check Podman, compose, cgroups, ports and Node
U
  exit 2
}

# d4-ops (apps/ops): in its image with the secrets mounted, or on local Node from the working
# tree with D4_OPS=local (no image rebuild while developing it).
ops() {
  if [[ "${D4_OPS:-}" == local ]]; then
    node_env ops
    pn turbo run build --filter '@d4/ops...' >/dev/null
    load_env host
    (cd .. && NEO4J_HOSTS="$(cd deploy && neo4j_hosts localhost)" NEO4J_SECRETS_DIR="$PWD/deploy/secrets" node apps/ops/dist/main.js "$@")
  else
    compose run --rm --no-deps db-migrate "$@"
  fi
}

# A tenant's own Neo4j: started here (no service gets the container engine's socket), password in
# deploy/secrets; the control plane then registers it, applies the schema and seeds it.
tenant_create() {
  local id="${1:-}" name="${2:-}"
  [[ "$id" =~ ^t_[a-z0-9][a-z0-9_]{1,30}$ && -n "$name" ]] || die 'usage: dev-infra.sh tenant create t_<id> "<name>"' 2
  local c="d4-neo4j-$id" secret="secrets/neo4j-$id" port=7701
  [[ -s "$secret" ]] || { umask 077; openssl rand -hex 16 > "$secret"; }
  if ! "$ENGINE" container exists "$c" 2>/dev/null && ! "$ENGINE" inspect "$c" >/dev/null 2>&1; then
    while [[ -n "$(port_owner "$port")" ]]; do port=$((port + 1)); done
    "$ENGINE" run -d --name "$c" --label "d4.tenant=$id" --network d4 --restart unless-stopped \
      -p "127.0.0.1:$port:7687" -v "$c-data:/data" -v "$c-plugins:/plugins" \
      -e NEO4J_AUTH="neo4j/$(cat "$secret")" -e NEO4J_PLUGINS='["apoc"]' \
      -e NEO4J_dbms_security_procedures_unrestricted='apoc.*' -e NEO4J_dbms_security_procedures_allowlist='apoc.*' \
      -e NEO4J_db_transaction_timeout=30s -e NEO4J_server_memory_heap_initial__size=256m -e NEO4J_server_memory_heap_max__size=384m \
      -e NEO4J_server_memory_pagecache_size=64m -e NEO4J_db_memory_transaction_total_max=128m \
      -e NEO4J_server_jvm_additional='-XX:MaxDirectMemorySize=128m -XX:MaxMetaspaceSize=192m -XX:ReservedCodeCacheSize=64m -Xss512k' \
      --memory 900m --cpus 1 docker.io/library/neo4j:5.26-community >/dev/null
    say "Started $c on 127.0.0.1:$port"
  fi
  ops tenant create "$id" --name "$name" --bolt "bolt://$c:7687" --secret "file:neo4j-$id"
  say "Restart local api/worker processes (deploy/dev.sh) so they learn the new host port."
}

doctor() {
  local ok=1
  check() { if eval "$2" >/dev/null 2>&1; then printf '  ok    %s\n' "$1"; else printf '  FAIL  %s (%s)\n' "$1" "$3"; ok=0; fi; }
  check "podman 5+" "[[ \$(podman version --format '{{.Client.Version}}') == 5.* ]]" "install Podman 5"
  check "podman compose" "podman compose version" "install docker-compose v2 or podman-compose"
  check "rootless podman" "[[ \$(podman info --format '{{.Host.Security.Rootless}}') == true ]]" "run as your user"
  check "cgroup v2 cpu+memory delegated" "grep -qw memory /sys/fs/cgroup/user.slice/user-\$(id -u).slice/user@\$(id -u).service/cgroup.controllers" "enable systemd delegation"
  check "podman.socket active" "systemctl --user is-active podman.socket" "systemctl --user enable --now podman.socket"
  check "node 24 (local runs only)" "[[ \$(node -v) == v24.* ]]" "optional: install Node 24"
  for p in "$GATEWAY_PORT" 5432 7687 6379 8333 8025 1025; do
    local o; o=$(port_owner "$p"); [[ -z "$o" ]] || is_container_owner "$o" || { printf '  WARN  port %s used by %s\n' "$p" "$o"; }
  done
  [[ $ok == 1 ]]
}

case "${1:-}" in
  up)
    profile=(); svcs=("${INFRA_SERVICES[@]}")
    [[ "${2:-}" == --obs ]] && { profile=(--profile observability); svcs+=("${OBS_SERVICES[@]}"); }
    o=$(port_owner "$GATEWAY_PORT"); [[ -z "$o" ]] || is_container_owner "$o" || die "Port $GATEWAY_PORT (the gateway) is used by '$o'. Stop it first."
    compose "${profile[@]}" up -d --build --wait "${svcs[@]}"
    compose run --rm --build db-migrate
    compose run --rm neo4j-schema
    "$SELF" status ;;
  down)   compose --profile observability --profile tools down --remove-orphans ;;
  reset)
    [[ "${2:-}" == --yes ]] || { read -r -p "Delete all D4 volumes (databases, objects)? [y/N] " a; [[ "$a" == [yY] ]] || exit 1; }
    compose --profile observability --profile tools down -v --remove-orphans ;;
  status) compose --profile observability ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}' ;;
  logs)   compose logs -f "${@:2}" ;;
  migrate) compose run --rm --build db-migrate ;;
  schema)  compose run --rm neo4j-schema ;;
  tenant)
    case "${2:-}" in
      create) tenant_create "${@:3}" ;;
      remove)
        [[ -n "${3:-}" ]] || die 'usage: dev-infra.sh tenant remove t_<id>' 2
        ops tenant delete "$3"
        "$ENGINE" rm -f "d4-neo4j-$3" >/dev/null 2>&1 && say "Stopped d4-neo4j-$3 (volume d4-neo4j-$3-data kept)." || true ;;
      user) D4_CONTAINER_ENGINE="$ENGINE" ./keycloak/tenant-user.sh "${@:3}" ;;
      list|check|suspend|resume|delete) ops tenant "${@:2}" ;;
      *) usage ;;
    esac ;;
  quota) ops quota "${@:2}" ;;
  token)
    curl -fsS -d client_id="$OIDC_CLIENT_ID" -d grant_type=password -d username="${2:-dev-admin}" \
      -d password="$DEV_USER_PASSWORD" "$OIDC_ISSUER/protocol/openid-connect/token" \
      | sed -E 's/.*"access_token":"([^"]+)".*/\1/' ;;
  doctor) doctor ;;
  *) usage ;;
esac
