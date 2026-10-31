import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import neo4j from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDb, LOCAL_TENANT, runMigrations, seedLocal, TenantStore, type DbHandle } from '@d4/db';
import { Client } from 'pg';
import { claimDatabase, ManualInstanceDriver, parseHosts, provisionTenant, resolveSecret, routeUri, TenantGraphs } from '../src';

const PG = process.env.D4_TEST_POSTGRES_URL;
const NEO = process.env.D4_TEST_NEO4J_URL;
const NEO_PASSWORD = process.env.D4_TEST_NEO4J_PASSWORD ?? 'd4-local-dev';

describe('tenant routing', () => {
  it('maps registered hosts to reachable ones and leaves others alone', () => {
    const hosts = parseHosts('neo4j=localhost:7687, d4-neo4j-t_acme=localhost:7701');
    expect(routeUri('bolt://neo4j:7687', { hosts })).toBe('bolt://localhost:7687');
    expect(routeUri('bolt://d4-neo4j-t_acme:7687', { hosts })).toBe('bolt://localhost:7701');
    expect(routeUri('neo4j+s://db.example.com:7687', { hosts })).toBe('neo4j+s://db.example.com:7687');
    // Without a host map, the legacy override applies to every tenant.
    expect(routeUri('bolt://anything:7687', { uriOverride: 'bolt://localhost:7687' })).toBe('bolt://localhost:7687');
    expect(() => parseHosts('neo4j=localhost')).toThrow(/host=host:port/);
  });

  it('reads secrets from the environment password or a secrets directory, nothing else', () => {
    const dir = mkdtempSync(join(tmpdir(), 'd4-secrets-'));
    writeFileSync(join(dir, 'neo4j-t_acme'), 's3cret\n');
    expect(resolveSecret('env:NEO4J_PASSWORD', { password: 'p' })).toBe('p');
    expect(resolveSecret('file:neo4j-t_acme', { password: 'p', secretsDir: dir })).toBe('s3cret');
    expect(() => resolveSecret('file:../etc/passwd', { password: 'p', secretsDir: dir })).toThrow(/Unsupported/);
    expect(() => resolveSecret('env:HOME', { password: 'p' })).toThrow(/Unsupported/);
    expect(() => resolveSecret('file:neo4j-t_acme', { password: 'p' })).toThrow(/no secrets directory/);
  });
});

/**
 * Isolation against the shared test Neo4j, which belongs to the local tenant: registering another
 * tenant on it (a misconfiguration) must never give that tenant access to it.
 */
describe.skipIf(!PG || !NEO)('tenant isolation (Postgres + Neo4j)', () => {
  const dbName = `d4_tenants_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let handle: DbHandle;
  const graph = { user: 'neo4j', password: NEO_PASSWORD, uriOverride: NEO! };

  beforeAll(async () => {
    const admin = new Client({ connectionString: PG });
    await admin.connect();
    await admin.query(`CREATE DATABASE ${dbName}`);
    await admin.end();
    const url = new URL(PG!);
    url.pathname = `/${dbName}`;
    handle = createDb(url.toString(), 2);
    await runMigrations(handle.db);
    await seedLocal(handle.db);
    // The shared database belongs to the local tenant (the first service to connect claims it).
    const d = neo4j.driver(NEO!, neo4j.auth.basic('neo4j', NEO_PASSWORD));
    await claimDatabase(d, LOCAL_TENANT);
    await d.close();
  }, 60_000);
  afterAll(async () => {
    await handle?.close();
    const c = new Client({ connectionString: PG });
    await c.connect();
    await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await c.end();
  });

  it('refuses to provision a tenant on a database that belongs to another tenant', async () => {
    const driver = new ManualInstanceDriver({ boltUri: 'bolt://neo4j:7687', secretRef: 'env:NEO4J_PASSWORD', neo4jVersion: '5.26' });
    await expect(provisionTenant(handle.db, driver, { tenantId: 't_intruder', slug: 'intruder', name: 'Intruder' }, { graph, waitMs: 5000 })).rejects.toThrow(
      /belongs to another tenant/,
    );
    const tenants = new TenantStore(handle.db);
    expect(await tenants.get('t_intruder')).toMatchObject({ status: 'suspended' });
    expect(await tenants.instance('t_intruder')).toMatchObject({ status: 'failed' });
  });

  it('never routes a tenant to a database claimed by another, even if the registry says so', async () => {
    const tenants = new TenantStore(handle.db);
    await tenants.ensure({ id: 't_misrouted', slug: 'misrouted', name: 'Misrouted' });
    await tenants.upsertInstance({ tenantId: 't_misrouted', boltUri: 'bolt://neo4j:7687', secretRef: 'env:NEO4J_PASSWORD', neo4jVersion: '5.26', status: 'ready' });
    const graphs = new TenantGraphs(handle.db, graph);
    try {
      await expect(graphs.session('t_misrouted')).rejects.toMatchObject({ code: 'NOT_FOUND', message: expect.stringMatching(/belongs to another tenant/) });
      // The rightful owner still connects.
      const s = await graphs.session(LOCAL_TENANT);
      await s.close();
    } finally {
      await graphs.close();
    }
  });

  it('only routes active tenants with a ready instance', async () => {
    const tenants = new TenantStore(handle.db);
    await tenants.setStatus(LOCAL_TENANT, 'suspended');
    const graphs = new TenantGraphs(handle.db, graph);
    try {
      await expect(graphs.session(LOCAL_TENANT)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    } finally {
      await tenants.setStatus(LOCAL_TENANT, 'active');
      await graphs.close();
    }
  });
});
