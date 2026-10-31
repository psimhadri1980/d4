# Shared by dev-infra.sh, dev-deploy.sh, dev.sh and test.sh. Sourced, not run.
# shellcheck shell=bash
set -euo pipefail
DEPLOY_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DEPLOY_DIR"
# This script, callable after the cd above ($0 may be relative to the caller's directory).
SELF="$DEPLOY_DIR/${0##*/}"

# Podman by default; D4_CONTAINER_ENGINE=docker still works for the same compose files.
ENGINE="${D4_CONTAINER_ENGINE:-podman}"
export PODMAN_COMPOSE_WARNING_LOGS=false

# Settings live in deploy/env (see common.env). Variables already set by the caller win, e.g.
# `WEBHOOK_INTERVAL_MS=2000 deploy/dev.sh worker`; compose interpolates from this environment.
CALLER_ENV=" $(compgen -e | tr '\n' ' ') "
# Exports the env files in order, later files winning: common, the network view given as $1
# (container or host), dev secrets, then your git-ignored local.env.
load_env() {
  local f line key
  for f in common.env ${1:+$1.env} dev-secrets.env local.env; do
    [[ -f "env/$f" ]] || continue
    while IFS= read -r line || [[ -n "$line" ]]; do
      [[ "$line" =~ ^[[:space:]]*(#|$) ]] && continue
      key="${line%%=*}"
      [[ "$CALLER_ENV" == *" $key "* ]] || export "$key=${line#*=}"
    done < "env/$f"
  done
}
load_env

# Every compose file, always: depends_on crosses files, and profiles keep tools and
# observability out of plain `up`.
compose() {
  "$ENGINE" compose -p d4 -f compose/infra.yaml -f compose/observability.yaml -f compose/apps.yaml \
    -f compose/web.yaml -f compose/gateway.yaml -f compose/tools.yaml "$@"
}

INFRA_SERVICES=(postgres neo4j redis s3 smtp keycloak gateway)
OBS_SERVICES=(otel-collector tempo prometheus grafana)
APP_SERVICES=(api worker renderer web web-admin)

say() { printf '\033[1m%s\033[0m\n' "$*" >&2; }
die() { printf '%s\n' "$*" >&2; exit "${2:-1}"; }

# Local Node (dev.sh, test.sh --local). pnpm runs at the version pinned in package.json.
node_env() {
  local want; want=$(cut -d. -f1 ../.node-version)
  [[ "$(node -v 2>/dev/null)" == "v$want."* ]] && command -v npx >/dev/null ||
    die "Node.js $want with npx is required for $1 (see .node-version; found: $(node -v 2>/dev/null || echo none))"
  PNPM_VERSION=$(sed -nE 's/.*"packageManager": *"pnpm@([^"]+)".*/\1/p' ../package.json)
}
pn() { (cd .. && NPM_CONFIG_UPDATE_NOTIFIER=false npx -y "pnpm@$PNPM_VERSION" "$@"); }
ensure_deps() { [[ -d ../node_modules ]] || pn install --frozen-lockfile; }

# How a process outside the compose network reaches each tenant's Neo4j: the local tenant's
# `neo4j` plus every container started by `dev-infra.sh tenant create` (label d4.tenant).
neo4j_hosts() {
  local out="neo4j=$1:7687" name port
  while read -r name port; do [[ -n "$name" ]] && out+=",$name=$1:$port"; done < <(
    "$ENGINE" ps --filter label=d4.tenant --format '{{.Names}} {{.Ports}}' | sed -nE 's/^([^ ]+) .*:([0-9]+)->7687\/tcp.*/\1 \2/p')
  echo "$out"
}

# The process listening on a TCP port, empty when free (a container shows as rootlessport/pasta).
port_owner() { ss -Hltnp "sport = :$1" 2>/dev/null | sed -nE 's/.*users:\(\("([^"]+)".*/\1/p' | head -1; }
is_container_owner() { [[ "$1" =~ ^(rootlessport|pasta|conmon|docker-proxy|slirp4netns)$ ]]; }
