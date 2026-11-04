# Organization CA certificates

**Where the files live is configuration:** set `ORG_CA_FILE` (and, for gateway HTTPS,
`GATEWAY_TLS_CERT_FILE` and `GATEWAY_TLS_KEY_FILE`) in `run/env/local.env` to any path
(absolute, `~/...`, or relative to `run/`), e.g. `ORG_CA_FILE=/etc/pki/org/ca-bundle.crt`.
`run/run.sh` copies them here as `org-ca.crt`, `gateway.crt` and `gateway.key`
(git-ignored; staged into every image build context as `certs/`, without keys). With the settings empty, files you place here
yourself under those names are used. Everything below refers to those copies.

Put your internal CA chain in `org-ca.crt` (PEM text, one or more certificates; the same file you import into browsers and the OS trust store). When the file exists,
every build and run trusts it in addition to the public CAs, so npm registries, proxies, OIDC,
webhooks and Git sources behind your CA work. Without it nothing changes. The file is git-ignored.

- Image builds (every stage that downloads, including the nginx images' `apk upgrade`): appended to the system bundle (apk, curl, git) and `NODE_EXTRA_CA_CERTS` for npm, pnpm and corepack.
- Final images (api, worker, ops, renderer): the same cert is appended to the system store (git, curl) and set as `NODE_EXTRA_CA_CERTS`; the renderer also adds each certificate to Chromium's NSS database. Images rebuild by themselves after it changes (it is part of their input hash): `run/run.sh podman:stack:deploy`.
- Keycloak: `KC_TRUSTSTORE_PATHS` points at it.
- Local runs (`run/run.sh local:...`, tests on local Node): `NODE_EXTRA_CA_CERTS` is set.
- Browsers: import `org-ca.crt` as a trusted authority (Chrome/Edge: Settings > Privacy and security > Manage certificates > Authorities; Firefox: Settings > Privacy & Security > View Certificates > Authorities; Linux system store: copy to `/usr/local/share/ca-certificates/` and run `sudo update-ca-certificates`).

## Gateway HTTPS (server certificate)

`gateway.crt` and `gateway.key` (PEM) make the gateway serve HTTPS on `D4_TLS_PORT` (host.conf,
default 5443) next to plain HTTP on `D4_PORT` (5173). They are the gateway's own identity,
usually issued by your organization CA, and are mounted read-only at `/run/d4-certs`; the key is
never copied into image builds. The key must be readable by the container user
(`chmod 644 run/certs/gateway.key` for rootless Podman). Without both files the gateway stays plain HTTP.
`GATEWAY_TLS_CERT` and `GATEWAY_TLS_KEY` in `local.env` override the paths. Run `run/run.sh gateway:deploy` after changing them.
