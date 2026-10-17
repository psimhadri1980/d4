#!/usr/bin/env bash
# Local stack helper. Works without Node installed: everything builds inside Docker.
set -euo pipefail
cd "$(dirname "$0")"

# Docker Desktop's CLI is not always on PATH.
if ! command -v docker >/dev/null; then
  export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"
fi
dc() { docker compose -f docker-compose.yml "$@"; }

case "${1:-help}" in
  up)       dc up -d --build --wait api && "$0" status ;;
  up-obs)   D4_OTEL_ENDPOINT=http://otel-collector:4318 dc --profile observability up -d --build --wait && "$0" status ;;
  down)     dc --profile observability --profile tools down ;;
  reset)    dc --profile observability --profile tools down -v ;;
  status)   dc --profile observability ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}' ;;
  logs)     dc logs -f "${@:2}" ;;
  schema)   dc run --rm neo4j-schema ;;
  test)     dc --profile tools run --rm --build test ;;
  smoke)
    curl -fsS localhost:3000/healthz && echo
    curl -fsS localhost:3000/readyz && echo
    TOKEN=$(curl -fsS -d client_id=d4-web -d grant_type=password -d username=dev-admin \
      -d password=d4-local-dev localhost:8080/realms/d4/protocol/openid-connect/token \
      | sed -E 's/.*"access_token":"([^"]+)".*/\1/')
    curl -fsS -H "Authorization: Bearer $TOKEN" localhost:3000/v1/me && echo ;;
  *)
    echo "usage: deploy/dev.sh up|up-obs|down|reset|status|logs [svc]|schema|test|smoke" ;;
esac
