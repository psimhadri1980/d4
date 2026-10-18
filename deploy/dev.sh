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
pn() { (cd .. && npx -y "pnpm@$PNPM_VERSION" "$@"); }
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
  test)     dc --profile tools run --rm --build test ;;
  # Browser tests (Playwright) against the running stack; report in apps/e2e/results/report.
  e2e)      dc --profile tools run --rm --build e2e "${@:2}" ;;
  # Web app on local Node with hot reload at :5173 (stops the web container, which uses that port).
  web-local)
    node_env web-local
    dc stop web >/dev/null 2>&1 || true
    [[ -d ../node_modules ]] || pn install --frozen-lockfile
    pn turbo run build --filter '@d4/web^...'
    pn --filter @d4/web exec vite --host 127.0.0.1 --port 5173 --strictPort ;;
  # Web checks on local Node: unit tests, typecheck, lint and a production build.
  web-check)
    node_env web-check
    [[ -d ../node_modules ]] || pn install --frozen-lockfile
    pn turbo run build test typecheck lint --filter @d4/web ;;
  # Browser tests against the local web server from web-local (API and Keycloak stay in Docker).
  e2e-local)
    [[ -n "$(port_5173_owner)" && "$(port_5173_owner)" != com.docke* ]] || { echo "Start deploy/dev.sh web-local first" >&2; exit 1; }
    dc --profile tools run --rm --build --no-deps -e E2E_WEB_TARGET=host.docker.internal:5173 e2e "${@:2}" ;;
  # Builds and (re)starts the web container from the current tree, e.g. after committing.
  web-deploy)
    owner=$(port_5173_owner)
    if [[ -n "$owner" && "$owner" != com.docke* ]]; then
      echo "Port 5173 is used by '$owner' (web-local?). Stop it first." >&2; exit 1
    fi
    dc up -d --build --wait web && "$SELF" status ;;
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
    echo "usage: deploy/dev.sh up|up-obs|down|reset|status|logs [svc]|migrate|schema|test|e2e|smoke|token [user]|cli <args>|sample|web-local|web-check|e2e-local|web-deploy" ;;
esac
