#!/bin/sh
# Writes the web app's /config.json from the container's environment at start-up (nginx runs
# /docker-entrypoint.d/* first). apps/web/vite.config.ts serves the same document in development.
set -eu
: "${D4_PUBLIC_API_URL:?}" "${OIDC_ISSUER:?}" "${OIDC_CLIENT_ID:?}"
printf '{"apiUrl":"%s","oidcAuthority":"%s","oidcClientId":"%s"}\n' \
  "$D4_PUBLIC_API_URL" "$OIDC_ISSUER" "$OIDC_CLIENT_ID" > /usr/share/nginx/html/config.json
