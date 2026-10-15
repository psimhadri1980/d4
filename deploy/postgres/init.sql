-- Control-plane bootstrap (Phase 0). Full schema is managed by Drizzle migrations from Phase 1.
CREATE TABLE IF NOT EXISTS tenants (
  id          TEXT PRIMARY KEY,
  slug        TEXT UNIQUE NOT NULL,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS tenant_db_instances (
  tenant_id   TEXT PRIMARY KEY REFERENCES tenants(id),
  bolt_uri    TEXT NOT NULL,
  secret_ref  TEXT NOT NULL,
  neo4j_version TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ready'
);

CREATE TABLE IF NOT EXISTS events (
  seq         BIGSERIAL PRIMARY KEY,
  tenant_id   TEXT NOT NULL REFERENCES tenants(id),
  type        TEXT NOT NULL,
  payload     JSONB NOT NULL,
  actor       TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Local single tenant pointing at the docker-compose Neo4j.
INSERT INTO tenants (id, slug, name) VALUES ('t_local', 'local', 'Local Dev') ON CONFLICT DO NOTHING;
INSERT INTO tenant_db_instances (tenant_id, bolt_uri, secret_ref, neo4j_version)
VALUES ('t_local', 'bolt://neo4j:7687', 'env:NEO4J_PASSWORD', '5.26') ON CONFLICT DO NOTHING;
