#!/usr/bin/env bash
# Runs the Playwright suite inside the compose network. The browser must use the same origins as
# a developer's browser (OIDC redirect URIs and the token issuer are localhost-based), so local
# ports are forwarded to the services.
set -euo pipefail
# E2E_WEB_TARGET points at a web server on the host instead (deploy/dev.sh e2e-local).
socat TCP-LISTEN:5173,fork,reuseaddr,bind=127.0.0.1 TCP:"${E2E_WEB_TARGET:-web:80}" &
socat TCP-LISTEN:8080,fork,reuseaddr,bind=127.0.0.1 TCP:keycloak:8080 &
socat TCP-LISTEN:3000,fork,reuseaddr,bind=127.0.0.1 TCP:api:3000 &
# An API on the host from deploy/dev.sh api-local (used when the web app is built against it).
socat TCP-LISTEN:3100,fork,reuseaddr,bind=127.0.0.1 TCP:host.docker.internal:3100 &
sleep 0.5
cd /repo/apps/e2e
NPM_CONFIG_UPDATE_NOTIFIER=false exec npx playwright test "$@"
