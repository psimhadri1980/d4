#!/usr/bin/env bash
# Runs the Playwright suite inside the compose network. The browser must use the same origins as
# a developer's browser (OIDC redirect URIs and the token issuer are localhost-based), so local
# ports are forwarded to the services.
set -euo pipefail
socat TCP-LISTEN:5173,fork,reuseaddr,bind=127.0.0.1 TCP:web:80 &
socat TCP-LISTEN:8080,fork,reuseaddr,bind=127.0.0.1 TCP:keycloak:8080 &
socat TCP-LISTEN:3000,fork,reuseaddr,bind=127.0.0.1 TCP:api:3000 &
sleep 0.5
cd /repo/apps/e2e
exec npx playwright test "$@"
