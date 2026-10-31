#!/usr/bin/env bash
# Every test, in containers (default) or on local Node (--local).
source "$(dirname "$0")/lib/common.sh"

usage() {
  cat >&2 <<'U'
usage: deploy/test.sh <suite> [--local] [args]
  static                typecheck, lint and knip
  unit [--filter pkg]   unit tests only (integration suites skip without their services)
  integration [--filter pkg]   all tests, with Postgres, Neo4j, Redis and S3
  web                   web unit tests, typecheck, lint and production build
  e2e [--podman] [playwright args]  browser tests through the gateway: D4_PUBLIC_URL, whatever
                        mix of container and local (deploy/dev.sh) apps is behind it, or with
                        --podman D4_PODMAN_URL, the containers only
  smoke                 gateway and API health, login and /v1/me through the gateway
  all                   static, integration, e2e: the full run
--local runs on host Node (Node 24); otherwise everything runs in the test image.
U
  exit 2
}

suite="${1:-}"; shift || true
local_node=0; podman_host=0; args=()
for a in "$@"; do
  case "$a" in --local) local_node=1 ;; --podman) podman_host=1 ;; *) args+=("$a") ;; esac
done
filter() { [[ "${args[0]:-}" == --filter ]] && echo "--filter ${args[1]}"; }

# Runs a pnpm command on host Node or in the test container (with or without services).
run() {
  local with_services="$1"; shift
  if [[ $local_node == 1 ]]; then
    node_env test; ensure_deps
    if [[ $with_services == 1 ]]; then
      load_env host
      export D4_TEST_POSTGRES_URL="postgres://$POSTGRES_USER:$POSTGRES_PASSWORD@localhost:$POSTGRES_PORT/postgres" \
        D4_TEST_NEO4J_URL=bolt://localhost:7687 D4_TEST_NEO4J_PASSWORD="$NEO4J_PASSWORD" \
        D4_TEST_REDIS_URL=redis://localhost:6379 D4_TEST_S3_ENDPOINT="$S3_ENDPOINT"
    fi
    pn "$@"
  elif [[ $with_services == 1 ]]; then
    compose --profile tools run --rm --build test pnpm "$@"
  else
    compose --profile tools run --rm --build --no-deps \
      -e D4_TEST_POSTGRES_URL= -e D4_TEST_NEO4J_URL= -e D4_TEST_REDIS_URL= -e D4_TEST_S3_ENDPOINT= test pnpm "$@"
  fi
}

e2e() {
  # The gateway serves the app, the API and Keycloak whether they run in containers or on the host.
  local base="$D4_PUBLIC_URL"; [[ $podman_host == 1 ]] && base="$D4_PODMAN_URL"
  curl -fsS -o /dev/null "$base/healthz" || die "No gateway at $base: run deploy/dev-infra.sh up and deploy/dev-deploy.sh"
  compose --profile tools run --rm --build --no-deps -e E2E_BASE_URL="$base" e2e "${args[@]}"
}

case "$suite" in
  static)      run 0 turbo run typecheck lint --concurrency=2 && run 0 knip ;;
  unit)        run 0 turbo run test --concurrency=2 $(filter) ;;
  integration) run 1 turbo run test --concurrency=2 $(filter) ;;
  web)         run 0 turbo run build test typecheck lint --filter @d4/web ;;
  e2e)         e2e ;;
  smoke)
    curl -fsS "$D4_PUBLIC_URL/healthz" && echo
    curl -fsS "$D4_PUBLIC_API_URL/healthz" && echo
    curl -fsS "$D4_PUBLIC_API_URL/readyz" && echo
    curl -fsS -H "Authorization: Bearer $(./dev-infra.sh token)" "$D4_PUBLIC_API_URL/v1/me" && echo ;;
  all)         "$SELF" static "$@" && "$SELF" integration "$@" && "$SELF" e2e --retries=0 ;;
  *) usage ;;
esac
