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
  e2e [--web-local] [playwright args]   browser tests against the running stack
                        (--web-local: against `deploy/dev.sh web` on the host)
  smoke                 API health, login and /v1/me
  all                   static, integration, e2e: the pre-commit gate
--local runs on host Node (Node 24); otherwise everything runs in the test image.
U
  exit 2
}

suite="${1:-}"; shift || true
local_node=0; args=()
for a in "$@"; do [[ "$a" == --local ]] && local_node=1 || args+=("$a"); done
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
  if [[ "${args[0]:-}" == --web-local ]]; then
    args=("${args[@]:1}")
    o=$(port_owner 5173); [[ -n "$o" ]] && ! is_container_owner "$o" || die "Start deploy/dev.sh web first"
    # On the host network the browser reaches the local web server and the published ports
    # directly. With D4_API_URL (as given to dev.sh web) setup talks to that API too; the webhook
    # receiver listens on :3199 so a local worker can reach it.
    compose --profile tools run --rm --build --no-deps --network host -e E2E_NO_FORWARD=1 \
      -e E2E_HOOK_PORT=3199 -e E2E_HOOK_URL=http://localhost:3199/d4-hook -e E2E_INBOX_URL=http://localhost:8025 \
      -e E2E_API_URL="${D4_API_URL:-$D4_PUBLIC_API_URL}" e2e "${args[@]}"
  else
    compose --profile tools run --rm --build e2e "${args[@]}"
  fi
}

case "$suite" in
  static)      run 0 turbo run typecheck lint && run 0 knip ;;
  unit)        run 0 turbo run test --concurrency=2 $(filter) ;;
  integration) run 1 turbo run test --concurrency=2 $(filter) ;;
  web)         run 0 turbo run build test typecheck lint --filter @d4/web ;;
  e2e)         e2e ;;
  smoke)
    curl -fsS "$D4_PUBLIC_API_URL/healthz" && echo
    curl -fsS "$D4_PUBLIC_API_URL/readyz" && echo
    curl -fsS -H "Authorization: Bearer $(./dev-infra.sh token)" "$D4_PUBLIC_API_URL/v1/me" && echo ;;
  all)         "$0" static "$@" && "$0" integration "$@" && "$0" e2e --retries=0 ;;
  *) usage ;;
esac
