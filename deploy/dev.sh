#!/usr/bin/env bash
# Runs D4 apps on local Node with hot reload, next to the infrastructure and containers from
# dev-infra.sh / dev-deploy.sh. Needs Node 24 (see .node-version).
source "$(dirname "$0")/lib/common.sh"

usage() {
  cat >&2 <<'U'
usage: deploy/dev.sh <command>
  web        Vite with hot reload on :5173 (stops the web container, which uses that port)
  api        API with reload on :3100, next to the container on :3000
  worker     job worker for the local API's queues (d4-jobs-local, d4-render-local)
  renderer   renderer image from the current tree on the local render queue
  cli <args> the d4 CLI in a container against the API; paths are relative to the repo root
  sample     import samples/ubs-banking.yaml into the default workspace
Pair local apps with D4_API_URL=http://localhost:3100, e.g. `D4_API_URL=http://localhost:3100 deploy/dev.sh web`.
U
  exit 2
}

case "${1:-}" in
  web)
    node_env web
    compose stop web >/dev/null 2>&1 || true
    ensure_deps
    pn turbo run build --filter '@d4/web^...'
    # --force: re-bundle the workspace packages Vite caches; restart after changing packages/*.
    # vite.config.ts serves /config.json from D4_PUBLIC_API_URL, OIDC_ISSUER and OIDC_CLIENT_ID.
    D4_PUBLIC_API_URL="${D4_API_URL:-$D4_PUBLIC_API_URL}" pn --filter @d4/web exec vite --host 127.0.0.1 --port 5173 --strictPort --force ;;
  api|worker)
    node_env "$1"
    ensure_deps
    pn turbo run build --filter "@d4/$1^..."
    load_env host
    NEO4J_HOSTS="$(neo4j_hosts localhost)" NEO4J_SECRETS_DIR="$PWD/secrets" pn --filter "@d4/$1" run dev ;;
  # Chromium needs the Playwright image, so this builds the renderer image from the current tree
  # and runs it once (not as the compose service) against the services' published ports.
  renderer)
    compose build renderer
    "$ENGINE" run --rm --name d4-renderer-local \
      --env-file env/common.env --env-file env/host.env --env-file env/dev-secrets.env $([[ -f env/local.env ]] && echo --env-file env/local.env) \
      -e POSTGRES_HOST=host.containers.internal -e NEO4J_HOSTS="$(neo4j_hosts host.containers.internal)" \
      -v "$PWD/secrets:/run/d4-secrets:ro,z" -e NEO4J_SECRETS_DIR=/run/d4-secrets \
      -e REDIS_URL=redis://host.containers.internal:6379 -e S3_ENDPOINT=http://host.containers.internal:8333 \
      -e SMTP_URL=smtp://host.containers.internal:1025 localhost/d4-renderer:local ;;
  cli)
    TOKEN=$(./dev-infra.sh token)
    compose --profile tools run --rm --build --no-deps -e D4_TOKEN="$TOKEN" -e D4_API_URL=http://api:3000 \
      -v "$(cd .. && pwd):/work:z" -w /work test node /repo/packages/cli/dist/main.js "${@:2}" ;;
  sample) "$0" cli import samples/ubs-banking.yaml -w default ;;
  *) usage ;;
esac
