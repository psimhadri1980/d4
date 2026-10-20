#!/usr/bin/env bash
# Local stack helper. Works without Node installed: everything builds inside Docker.
set -euo pipefail
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"
cd "$(dirname "$SELF")"

# Docker Desktop's CLI is not always on PATH.
if ! command -v docker >/dev/null; then
  export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
fi
dc() { docker compose -f docker-compose.yml "$@"; }

# Local Node (optional; only the web-* commands use it). pnpm runs at the version pinned in package.json.
node_env() {
  for d in /opt/homebrew/bin /usr/local/bin; do [[ -x "$d/node" ]] && export PATH="$d:$PATH"; done
  command -v node >/dev/null || { echo "Node.js >= 20.11 is required for $1" >&2; exit 1; }
  PNPM_VERSION=$(sed -nE 's/.*"packageManager": *"pnpm@([^"]+)".*/\1/p' ../package.json)
}
pn() { (cd .. && NPM_CONFIG_UPDATE_NOTIFIER=false npx -y "pnpm@$PNPM_VERSION" "$@"); }
# How a process outside the compose network reaches each tenant's Neo4j: the local tenant's
# `neo4j` plus every container started by tenant-create (label d4.tenant), as host:port via $1.
neo4j_hosts() {
  local out="neo4j=$1:7687" name port
  while read -r name port; do [[ -n "$name" ]] && out+=",$name=$1:$port"; done < <(
    docker ps --filter label=d4.tenant --format '{{.Names}} {{.Ports}}' | sed -nE 's/^([^ ]+) .*:([0-9]+)->7687\/tcp.*/\1 \2/p')
  echo "$out"
}
# The operator's tenant tool: inside the API image with the secrets mounted, or on local Node
# from the working tree with D4_TENANT_CLI=local (no image rebuild needed while developing).
tenant_cli() {
  if [[ "${D4_TENANT_CLI:-}" == local ]]; then
    node_env tenant
    pn turbo run build --filter '...@d4/jobs' >/dev/null
    (cd .. && POSTGRES_URL=postgres://d4:d4-local-dev@localhost:5432/d4 NEO4J_PASSWORD=d4-local-dev \
      NEO4J_HOSTS="$(cd deploy && neo4j_hosts localhost)" NEO4J_SECRETS_DIR="$PWD/deploy/secrets" node packages/jobs/dist/tenant-cli.js "$@")
  else
    dc run --rm --no-deps -w /repo/packages/jobs db-migrate node dist/tenant-cli.js "$@"
  fi
}
port_5173_owner() { { lsof -nP -iTCP:5173 -sTCP:LISTEN -Fc 2>/dev/null || true; } | sed -n 's/^c//p' | head -1; }

case "${1:-help}" in
  up)       dc up -d --build --wait web && "$SELF" status ;;
  up-obs)   D4_OTEL_ENDPOINT=http://otel-collector:4318 dc --profile observability up -d --build --wait && "$SELF" status ;;
  down)     dc --profile observability --profile tools down ;;
  reset)    dc --profile observability --profile tools down -v ;;
  status)   dc --profile observability ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}' ;;
  logs)     dc logs -f "${@:2}" ;;
  migrate)  dc run --rm --build db-migrate ;;
  schema)   dc run --rm neo4j-schema ;;
  # Operator: show or change a tenant's limits, e.g. `quota t_local elements=200000 jobsPerDay=unlimited`.
  quota)    dc run --rm --no-deps db-migrate node dist/set-quota.js "${@:2}" ;;
  test)     dc --profile tools run --rm --build test ;;
  # Browser tests (Playwright) against the running stack; report in apps/e2e/results/report.
  e2e)      dc --profile tools run --rm --build e2e "${@:2}" ;;
  # Web app on local Node with hot reload at :5173 (stops the web container, which uses that port).
  web-local)
    node_env web-local
    dc stop web >/dev/null 2>&1 || true
    [[ -d ../node_modules ]] || pn install --frozen-lockfile
    pn turbo run build --filter '@d4/web^...'
    # D4_API_URL=http://localhost:3100 points the web app at api-local instead of the container.
    # --force: re-bundle @d4/core and @d4/metamodel, which Vite caches; restart after changing packages/*.
    VITE_API_URL="${D4_API_URL:-http://localhost:3000}" pn --filter @d4/web exec vite --host 127.0.0.1 --port 5173 --strictPort --force ;;
  # API on local Node with reload, on :3100 next to the container (which keeps :3000), using the
  # data stores and Keycloak in Docker. Pair with: D4_API_URL=http://localhost:3100 deploy/dev.sh web-local
  api-local)
    node_env api-local
    [[ -d ../node_modules ]] || pn install --frozen-lockfile
    pn turbo run build --filter '@d4/api^...'
    API_PORT=3100 POSTGRES_URL=postgres://d4:d4-local-dev@localhost:5432/d4 NEO4J_HOSTS="$(neo4j_hosts localhost)" NEO4J_SECRETS_DIR="$PWD/secrets" \
      NEO4J_USER=neo4j NEO4J_PASSWORD=d4-local-dev OIDC_ISSUER=http://localhost:8080/realms/d4 OIDC_AUDIENCE=d4-api \
      REDIS_URL=redis://localhost:6379 S3_ENDPOINT=http://localhost:8333 JOB_QUEUE=d4-jobs-local RENDER_QUEUE=d4-render-local WEBHOOK_ALLOW_PRIVATE=true \
      pn --filter @d4/api exec tsx watch src/main.ts ;;
  # Job worker on local Node for api-local's queue (d4-jobs-local), using the Docker data stores.
  worker-local)
    node_env worker-local
    [[ -d ../node_modules ]] || pn install --frozen-lockfile
    pn turbo run build --filter '@d4/worker^...'
    POSTGRES_URL=postgres://d4:d4-local-dev@localhost:5432/d4 NEO4J_HOSTS="$(neo4j_hosts localhost)" NEO4J_SECRETS_DIR="$PWD/secrets" NEO4J_PASSWORD=d4-local-dev \
      REDIS_URL=redis://localhost:6379 S3_ENDPOINT=http://localhost:8333 JOB_QUEUE=d4-jobs-local RENDER_QUEUE=d4-render-local WEBHOOK_ALLOW_PRIVATE=true \
      SMTP_URL=smtp://localhost:1025 WORKER_HEALTH_PORT=3102 SCHEDULER_INTERVAL_MS=${D4_SCHEDULER_INTERVAL_MS:-0} WEBHOOK_INTERVAL_MS=${D4_WEBHOOK_INTERVAL_MS:-0} WEBHOOK_ALLOW_PRIVATE=true BACKUP_HOUR_UTC=-1 \
      pn --filter @d4/worker exec tsx watch src/main.ts ;;
  # Web checks on local Node: unit tests, typecheck, lint and a production build.
  web-check)
    node_env web-check
    [[ -d ../node_modules ]] || pn install --frozen-lockfile
    pn turbo run build test typecheck lint --filter @d4/web ;;
  # Browser tests against the local web server from web-local (API and Keycloak stay in Docker).
  e2e-local)
    [[ -n "$(port_5173_owner)" && "$(port_5173_owner)" != com.docke* ]] || { echo "Start deploy/dev.sh web-local first" >&2; exit 1; }
    # With D4_API_URL (as given to web-local), test setup also talks to that API. The webhook test's
    # receiver is published on :3199 so worker-local can reach it.
    dc --profile tools run --rm --build --no-deps -p 3199:3199 -e E2E_HOOK_PORT=3199 -e E2E_HOOK_URL=http://localhost:3199/d4-hook \
      -e E2E_WEB_TARGET=host.docker.internal:5173 \
      -e E2E_API_URL="${D4_API_URL:-http://localhost:3000}" e2e "${@:2}" ;;
  # Renderer for api-local's render queue (d4-render-local). Chromium needs the Playwright image,
  # so this builds the renderer image from the current tree and runs it once, not as the service.
  renderer-local)
    dc build renderer
    docker run --rm --name d4-renderer-local --add-host host.docker.internal:host-gateway \
      -e POSTGRES_URL=postgres://d4:d4-local-dev@host.docker.internal:5432/d4 -e NEO4J_HOSTS="$(neo4j_hosts host.docker.internal)" \
      -v "$PWD/secrets:/run/d4-secrets:ro" -e NEO4J_SECRETS_DIR=/run/d4-secrets \
      -e NEO4J_PASSWORD=d4-local-dev -e REDIS_URL=redis://host.docker.internal:6379 -e S3_ENDPOINT=http://host.docker.internal:8333 \
      -e SMTP_URL=smtp://host.docker.internal:1025 -e RENDER_QUEUE=d4-render-local d4-renderer:local ;;
  # Builds and (re)starts the web container from the current tree, e.g. after committing.
  web-deploy)
    owner=$(port_5173_owner)
    if [[ -n "$owner" && "$owner" != com.docke* ]]; then
      echo "Port 5173 is used by '$owner' (web-local?). Stop it first." >&2; exit 1
    fi
    dc up -d --build --wait web && "$SELF" status ;;
  # Operator: a new tenant with its own Neo4j. Starts the container here (no service gets Docker
  # access), writes its password to deploy/secrets, then lets the control plane register it, apply
  # the schema, seed the metamodel and a default workspace. Usage: tenant-create t_acme "Acme Ltd"
  tenant-create)
    id="${2:-}"; name="${3:-}"
    [[ "$id" =~ ^t_[a-z0-9][a-z0-9_]{1,30}$ && -n "$name" ]] || { echo 'usage: dev.sh tenant-create t_<id> "<name>"' >&2; exit 2; }
    c="d4-neo4j-$id"; secret="secrets/neo4j-$id"
    [[ -s "$secret" ]] || { umask 077; openssl rand -hex 16 > "$secret"; }
    if ! docker inspect "$c" >/dev/null 2>&1; then
      port=7701; while lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null 2>&1 || docker ps --format '{{.Ports}}' | grep -q ":$port->"; do port=$((port + 1)); done
      docker run -d --name "$c" --label "d4.tenant=$id" --network d4_default --restart unless-stopped \
        -p "127.0.0.1:$port:7687" -v "$c-data:/data" -v "$c-plugins:/plugins" \
        -e NEO4J_AUTH="neo4j/$(cat "$secret")" -e NEO4J_PLUGINS='["apoc"]' \
        -e NEO4J_dbms_security_procedures_unrestricted='apoc.*' -e NEO4J_dbms_security_procedures_allowlist='apoc.*' \
        -e NEO4J_db_transaction_timeout=30s -e NEO4J_server_memory_heap_initial__size=256m -e NEO4J_server_memory_heap_max__size=384m \
        -e NEO4J_server_memory_pagecache_size=64m -e NEO4J_db_memory_transaction_total_max=128m \
        -e NEO4J_server_jvm_additional='-XX:MaxDirectMemorySize=128m -XX:MaxMetaspaceSize=192m -XX:ReservedCodeCacheSize=64m -Xss512k' \
        --memory 900m --cpus 1 neo4j:5.26-community >/dev/null
      echo "Started $c on 127.0.0.1:$port"
    fi
    tenant_cli create "$id" --name "$name" --bolt "bolt://$c:7687" --secret "file:neo4j-$id"
    echo "Restart api-local/worker-local (if running) so they learn the new host port." ;;
  # Operator: tenant list | check <id> | suspend <id> | resume <id> | delete <id>
  tenant) tenant_cli "${@:2}" ;;
  # Operator: marks a tenant deleted and stops its Neo4j container. The data volume is kept.
  tenant-remove)
    id="${2:-}"; [[ -n "$id" ]] || { echo 'usage: dev.sh tenant-remove t_<id>' >&2; exit 2; }
    tenant_cli delete "$id"
    docker rm -f "d4-neo4j-$id" >/dev/null 2>&1 && echo "Stopped d4-neo4j-$id (volume d4-neo4j-$id-data kept)." || true ;;
  # Local Keycloak: a dev user for a tenant (default role admin), e.g. tenant-user t_acme acme-admin
  tenant-user) ./keycloak/tenant-user.sh "${@:2}" ;;
  # Prints an access token for a dev user (default dev-admin).
  token)
    curl -fsS -d client_id=d4-web -d grant_type=password -d username="${2:-dev-admin}" \
      -d password=d4-local-dev localhost:8080/realms/d4/protocol/openid-connect/token \
      | sed -E 's/.*"access_token":"([^"]+)".*/\1/' ;;
  # Runs the d4 CLI in a container against the local API; paths are relative to the repo root.
  cli)
    TOKEN=$("$SELF" token)
    dc --profile tools run --rm --build --no-deps -e D4_TOKEN="$TOKEN" -e D4_API_URL=http://api:3000 \
      -v "$(cd .. && pwd):/work" -w /work test node /repo/packages/cli/dist/main.js "${@:2}" ;;
  # Imports the illustrative UBS banking model into the default workspace.
  sample)   "$SELF" cli import samples/ubs-banking.yaml -w default ;;
  smoke)
    curl -fsS localhost:3000/healthz && echo
    curl -fsS localhost:3000/readyz && echo
    TOKEN=$(curl -fsS -d client_id=d4-web -d grant_type=password -d username=dev-admin \
      -d password=d4-local-dev localhost:8080/realms/d4/protocol/openid-connect/token \
      | sed -E 's/.*"access_token":"([^"]+)".*/\1/')
    curl -fsS -H "Authorization: Bearer $TOKEN" localhost:3000/v1/me && echo ;;
  *)
    echo "usage: deploy/dev.sh up|up-obs|down|reset|status|logs [svc]|migrate|schema|test|e2e|smoke|token [user]|cli <args>|sample|web-local|web-check|e2e-local|web-deploy|api-local|worker-local|renderer-local" ;;
esac
