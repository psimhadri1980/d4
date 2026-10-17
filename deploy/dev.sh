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
    echo "usage: deploy/dev.sh up|up-obs|down|reset|status|logs [svc]|migrate|schema|test|smoke|token [user]|cli <args>|sample" ;;
esac
