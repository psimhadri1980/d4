# Organization CA certificates

**Where the files live is configuration:** set `ORG_CA_FILE` (and, for gateway HTTPS,
`GATEWAY_TLS_CERT_FILE` and `GATEWAY_TLS_KEY_FILE`) in `deploy/env/local.env` to any path
(absolute, `~/...`, or relative to `deploy/`), e.g. `ORG_CA_FILE=/etc/pki/org/ca-bundle.crt`.
`deploy/lib/common.sh` copies them here as `org-ca.crt`, `gateway.crt` and `gateway.key`
(git-ignored; this folder is the image build context). With the settings empty, files you place here
yourself under those names are used. Everything below refers to those copies.

Put your internal CA chain in `org-ca.crt` (PEM text, one or more certificates; the same file you import into browsers and the OS trust store). When the file exists,
every build and run trusts it in addition to the public CAs, so npm registries, proxies, OIDC,
webhooks and Git sources behind your CA work. Without it nothing changes. The file is git-ignored.

- Image builds (every stage that downloads, including the nginx images' `apk upgrade`): appended to the system bundle (apk, curl, git) and `NODE_EXTRA_CA_CERTS` for npm, pnpm and corepack.
- Final images (api, worker, ops, renderer): the same cert is appended to the system store (git, curl) and set as `NODE_EXTRA_CA_CERTS`; the renderer also adds each certificate to Chromium's NSS database. Rebuild after changing it (`deploy/dev-deploy.sh`).
- Keycloak: `KC_TRUSTSTORE_PATHS` points at it.
- Host runs (`deploy/dev.sh`, `deploy/test.sh --local`): `NODE_EXTRA_CA_CERTS` is exported.
- Browsers: import `org-ca.crt` as a trusted authority (Chrome/Edge: Settings > Privacy and security > Manage certificates > Authorities; Firefox: Settings > Privacy & Security > View Certificates > Authorities; Linux system store: copy to `/usr/local/share/ca-certificates/` and run `sudo update-ca-certificates`).

## Gateway HTTPS (server certificate)

`gateway.crt` and `gateway.key` (PEM) make the gateway serve HTTPS on port 8443 (published on
127.0.0.1:5443, `GATEWAY_TLS_PORT`) next to plain HTTP on 5173. They are the gateway's own identity,
usually issued by your organization CA, and are mounted read-only at `/run/d4-certs`; the key is
excluded from image builds (`.containerignore`). The key must be readable by the container user
(`chmod 644 deploy/certs/gateway.key` for rootless Podman). Without both files the gateway stays plain HTTP.
`GATEWAY_TLS_CERT` and `GATEWAY_TLS_KEY` in `local.env` override the paths. Run `deploy/dev-deploy.sh gateway` after changing them.
