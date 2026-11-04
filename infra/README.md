# infra/

One folder per infrastructure component, each with its `component.yaml` (the contract in
`run/schema/component.schema.json`) and the configuration it mounts or builds from. All run on
Podman only, on the host network, listening on `127.0.0.1:<port>`.

| Component | What | Port | Config here |
|---|---|---|---|
| `gateway` | nginx: the one browser-facing origin from `/host.conf`; routes `/`, `/api`, `/auth`, `/mfe/<name>/`, `/mail/`, `/grafana/` | 5173 / 5443 | `Containerfile`, `templates/`, `15-d4-gateway.envsh` |
| `postgres` | Control plane; hook `ops seed` (migrations, local seed) | 5432 | |
| `neo4j` | The local tenant's graph; hook `ops schema t_local` | 7687 / 7474 | |
| `redis` | Job queues | 6379 | |
| `s3` | S3 mock (source in `mocks/s3`) | 8333 | `Containerfile` |
| `smtp` | SMTP mock with the inbox at `/mail/` (source in `mocks/smtp`) | 1025 / 8025 | `Containerfile` |
| `keycloak` | OIDC under `/auth`, realm `d4` | 8080 / 9000 | `d4-realm.json`, `tenant-user.sh` |
| `otel-collector`, `tempo`, `prometheus`, `grafana` | Optional observability (group `observability`) | 4317… / 3200 / 9090 / 3001 | their config files |

Start them with the stack (`run/run.sh podman:stack:deploy`) or on their own (`run/run.sh podman:observability:deploy`); `run/run.sh help <name>` shows one.
