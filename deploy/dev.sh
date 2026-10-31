#!/usr/bin/env bash
# Runs D4 apps on local Node with hot reload, behind the gateway: on D4_PUBLIC_URL (localhost) the
# gateway's upstream for the app points at the host process, and Ctrl-C switches back to the
# container. The container keeps running and stays reachable on D4_PODMAN_URL (d4.localhost). Needs Node 24 (.node-version).
source "$(dirname "$0")/lib/common.sh"

usage() {
  cat >&2 <<'U'
usage: deploy/dev.sh <command>
  web        Vite with hot reload on :5174, served at D4_PUBLIC_URL through the gateway
  web-<name> one web module (explore, queries, plan, data, reporting, admin) rebuilt on every
             change and served at D4_PUBLIC_URL/mfe/_dev/<name>/; point the shell at it (printed)
  api        API with reload on :3100, served at D4_PUBLIC_URL/api through the gateway
  worker     job worker for the local API's queues (d4-jobs-local, d4-render-local)
  renderer   renderer image from the current tree on the local render queue
  restore    route the gateway back to the containers (after a crash)
  cli <args> the d4 CLI in a container against the API; paths are relative to the repo root
  sample     import samples/ubs-banking.yaml into the default workspace
U
  exit 2
}

WEB_DEV_PORT=5174
MFE_DEV_PORT=5180
# The gateway reaches processes on the host here; they listen on all interfaces for it.
HOST_FROM_CONTAINERS=host.containers.internal

# The upstream overrides of every running dev.sh (one KEY=value line each, git-ignored), so several
# can run at once (web, api, a module) without one undoing another's route.
ROUTES=.dev-routes

# Recreates the gateway with the overrides in $ROUTES (UPSTREAM_API=..., UPSTREAM_WEB=...).
route() {
  (
    [[ -s $ROUTES ]] && while IFS= read -r kv; do export "$kv"; done < "$ROUTES"
    compose up -d --no-deps --force-recreate --wait gateway >/dev/null
  )
}

# Serves one app on D4_PUBLIC_URL from the host until this script exits, then gives it back to its
# container (which D4_PODMAN_URL uses throughout). Extra cleanup commands can follow.
route_local() {
  local svc="$1" upstream="$2" cleanup="${3:-}"
  { grep -v "^${upstream%%=*}=" "$ROUTES" 2>/dev/null || true; echo "$upstream"; } > "$ROUTES.tmp" && mv "$ROUTES.tmp" "$ROUTES"
  route
  trap "$cleanup say 'Routing $svc back to its container'; sed -i '/^${upstream%%=*}=/d' $ROUTES; route" EXIT
  say "Gateway: $D4_PUBLIC_URL → ${upstream#*=} for $svc; $D4_PODMAN_URL stays on the containers"
}

case "${1:-}" in
  web)
    node_env web
    ensure_deps
    pn turbo run build --filter '@d4/web^...'
    route_local web "UPSTREAM_WEB=$HOST_FROM_CONTAINERS:$WEB_DEV_PORT"
    # --force: re-bundle the workspace packages Vite caches; restart after changing packages/*.
    # vite.config.ts serves /config.json from D4_PUBLIC_API_URL, OIDC_ISSUER and OIDC_CLIENT_ID.
    pn --filter @d4/web exec vite --host 0.0.0.0 --port "$WEB_DEV_PORT" --strictPort --force ;;
  api)
    node_env api
    ensure_deps
    pn turbo run build --filter '@d4/api^...'
    load_env host
    route_local api "UPSTREAM_API=$HOST_FROM_CONTAINERS:$API_PORT"
    NEO4J_HOSTS="$(neo4j_hosts localhost)" NEO4J_SECRETS_DIR="$PWD/secrets" pn --filter @d4/api run dev ;;
  worker)
    node_env worker
    ensure_deps
    pn turbo run build --filter '@d4/worker^...'
    load_env host
    NEO4J_HOSTS="$(neo4j_hosts localhost)" NEO4J_SECRETS_DIR="$PWD/secrets" pn --filter @d4/worker run dev ;;
  # Chromium needs the Playwright image, so this builds the renderer image from the current tree
  # and runs it once (not as the compose service) against the services' published ports.
  renderer)
    compose build renderer
    "$ENGINE" run --rm --name d4-renderer-local \
      --env-file env/common.env --env-file env/host.env --env-file env/dev-secrets.env $([[ -f env/local.env ]] && echo --env-file env/local.env) \
      -e POSTGRES_HOST=$HOST_FROM_CONTAINERS -e NEO4J_HOSTS="$(neo4j_hosts $HOST_FROM_CONTAINERS)" \
      -v "$PWD/secrets:/run/d4-secrets:ro,z" -e NEO4J_SECRETS_DIR=/run/d4-secrets \
      -e REDIS_URL=redis://$HOST_FROM_CONTAINERS:6379 -e S3_ENDPOINT=http://$HOST_FROM_CONTAINERS:8333 \
      -e SMTP_URL=smtp://$HOST_FROM_CONTAINERS:1025 localhost/d4-renderer:local ;;
  web-*)
    mod="${1#web-}"
    [[ -d "../apps/web-$mod" ]] || die "No web module apps/web-$mod" 2
    node_env "web-$mod"
    ensure_deps
    pn turbo run build --filter "@d4/web-$mod^..."
    # A watch build into dist/, served by vite preview under /mfe/_dev/<name>/ (same origin as
    # the shell, so its content security policy allows it).
    pn --filter "@d4/web-$mod" exec vite build --watch --emptyOutDir false >/dev/null &
    watch=$!
    route_local "web-$mod" "UPSTREAM_MFE_DEV=$HOST_FROM_CONTAINERS:$MFE_DEV_PORT" "kill_tree $watch;"
    say "In the browser console on $D4_PUBLIC_URL: localStorage['d4:module:$mod'] = '/mfe/_dev/$mod/$mod.js', then reload after each rebuild. Remove the key to go back."
    pn --filter "@d4/web-$mod" exec vite preview --host 0.0.0.0 --port "$MFE_DEV_PORT" --strictPort --base "/mfe/_dev/$mod/" ;;
  restore)
    rm -f "$ROUTES"
    route
    say "Gateway routes to the containers." ;;
  cli)
    TOKEN=$(./dev-infra.sh token)
    compose --profile tools run --rm --build --no-deps -e D4_TOKEN="$TOKEN" -e D4_API_URL=http://api:3000 \
      -v "$(cd .. && pwd):/work:z" -w /work test node /repo/packages/cli/dist/main.js "${@:2}" ;;
  sample) "$SELF" cli import samples/ubs-banking.yaml -w default ;;
  *) usage ;;
esac
