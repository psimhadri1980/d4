import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWK } from 'jose';
import neo4j from 'neo4j-driver';
import { Client } from 'pg';
import { applySchema, awaitSchemaOnline } from '@d4/cypher';
import { createDb, runMigrations, seedLocal, type DbHandle } from '@d4/db';
import { loadStarterMetamodel, MetamodelRegistry } from '@d4/metamodel';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { JWKS } from '../src/auth/identity';
import { APP_CONFIG, loadConfig } from '../src/config';

export const PG = process.env.D4_TEST_POSTGRES_URL;
export const NEO = process.env.D4_TEST_NEO4J_URL;
const NEO_PASSWORD = process.env.D4_TEST_NEO4J_PASSWORD ?? 'd4-local-dev';
const ISSUER = 'http://issuer.test/realms/d4';

export interface Harness {
  app: NestFastifyApplication;
  db: DbHandle;
  workspaceId: string;
  /** Signs a token for the local test tenant (or another tenant). */
  sign(sub: string, roles: string[], tenant?: string): Promise<string>;
  call(
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
    url: string,
    token?: string,
    payload?: unknown,
  ): Promise<{ status: number; body: any }>;
  close(): Promise<void>;
}

/**
 * Starts the real API against a throwaway Postgres database (migrated and seeded) and the shared
 * Neo4j, with tokens signed by a local key instead of Keycloak.
 */
export async function startHarness(): Promise<Harness> {
  const dbName = `d4_e2e_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const admin = new Client({ connectionString: PG });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
  const url = new URL(PG!);
  url.pathname = `/${dbName}`;
  const db = createDb(url.toString(), 2);
  await runMigrations(db.db);
  const { workspaceId } = await seedLocal(db.db);

  const driver = neo4j.driver(NEO!, neo4j.auth.basic('neo4j', NEO_PASSWORD));
  const s = driver.session();
  await applySchema(s, new MetamodelRegistry(loadStarterMetamodel()));
  await awaitSchemaOnline(s);
  await s.close();
  await driver.close();

  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' };
  const sign = (sub: string, roles: string[], tenant = 't_local') =>
    new SignJWT({ tenant, realm_access: { roles } })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(ISSUER)
      .setAudience('d4-api')
      .setSubject(sub)
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(APP_CONFIG)
    .useValue(loadConfig({ D4_ENV: 'dev', POSTGRES_URL: url.toString(), NEO4J_PASSWORD: NEO_PASSWORD, NEO4J_URI: NEO, OIDC_ISSUER: ISSUER }))
    .overrideProvider(JWKS)
    .useValue(createLocalJWKSet({ keys: [jwk] }))
    .compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
  await configureApp(app);
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  const call: Harness['call'] = async (method, path, token, payload) => {
    const res = await app.inject({
      method,
      url: path,
      headers: token ? { authorization: `Bearer ${token}` } : {},
      ...(payload !== undefined && { payload: payload as object }),
    });
    return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : undefined };
  };

  return {
    app,
    db,
    workspaceId,
    sign,
    call,
    async close() {
      await app.close();
      const d = neo4j.driver(NEO!, neo4j.auth.basic('neo4j', NEO_PASSWORD));
      await d.executeQuery('MATCH (n:Element) WHERE n.workspaceId = $ws DETACH DELETE n', { ws: workspaceId });
      await d.close();
      await db.close();
      const c = new Client({ connectionString: PG });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await c.end();
    },
  };
}
