#!/bin/sh
# Writes the web app's /config.json from the container's environment at start-up (nginx runs
# /docker-entrypoint.d/* first). apps/web/vite.config.ts serves the same document in development.
set -eu
: "${D4_PUBLIC_API_URL:?}" "${OIDC_ISSUER:?}" "${OIDC_CLIENT_ID:?}"
mkdir -p /tmp/d4
# D4_WEB_REMOTES: name=entry,... (P6 spike), e.g. admin=/mfe/admin/admin.js
remotes=''
for r in $(echo "${D4_WEB_REMOTES:-}" | tr ',' ' '); do
  remotes="${remotes:+$remotes,}{\"name\":\"${r%%=*}\",\"entry\":\"${r#*=}\"}"
done
printf '{"apiUrl":"%s","oidcAuthority":"%s","oidcClientId":"%s","remotes":[%s]}\n' \
  "$D4_PUBLIC_API_URL" "$OIDC_ISSUER" "$OIDC_CLIENT_ID" "$remotes" > /tmp/d4/config.json
