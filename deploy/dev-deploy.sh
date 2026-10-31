#!/usr/bin/env bash
# Builds and (re)starts D4 app containers on Podman: all of them by default, or the ones named.
# Infrastructure starts first when it is not running (dev-infra.sh up).
source "$(dirname "$0")/lib/common.sh"

usage() {
  cat >&2 <<'U'
usage: deploy/dev-deploy.sh [app ...]        build and (re)start apps (default: all)
       deploy/dev-deploy.sh build [app ...]  build images only
       deploy/dev-deploy.sh stop [app ...]   stop apps
       deploy/dev-deploy.sh status
apps: api worker renderer web web-admin gateway, or the groups backend (api worker renderer) and all
U
  exit 2
}

services() {
  local out=() a
  [[ $# -gt 0 ]] || set -- all
  for a in "$@"; do
    case "$a" in
      all) out+=("${APP_SERVICES[@]}") ;;
      backend) out+=(api worker renderer) ;;
      api|worker|renderer|web|web-*|gateway) out+=("$a") ;;
      *) usage ;;
    esac
  done
  printf '%s\n' "${out[@]}"
}

case "${1:-}" in
  -h|--help|help) usage ;;
  build) mapfile -t s < <(services "${@:2}"); compose build "${s[@]}" ;;
  stop)  mapfile -t s < <(services "${@:2}"); compose stop "${s[@]}" ;;
  status) compose ps --format 'table {{.Service}}\t{{.Image}}\t{{.Status}}\t{{.RunningFor}}' ;;
  *)
    mapfile -t s < <(services "$@")
    [[ "$(compose ps --format '{{.Service}}' 2>/dev/null)" == *postgres* ]] || ./dev-infra.sh up
    # Builds only the named apps and restarts only them: dependencies (init jobs, mocks) are left
    # as they are. After a migration or seed change, run dev-infra.sh migrate (or up).
    compose build "${s[@]}"
    compose up -d --no-deps --wait "${s[@]}"
    compose ps --format 'table {{.Service}}\t{{.Status}}\t{{.Ports}}' ;;
esac
