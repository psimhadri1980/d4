import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/*
 * Control-plane schema, shared by all tenants. Every tenant-owned table carries `tenant_id`, and
 * every store method takes the tenant explicitly. Graph data lives in each tenant's Neo4j.
 */

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();

export const tenants = pgTable('tenants', {
  id: text('id').primaryKey(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  status: text('status', { enum: ['active', 'suspended', 'deleted'] }).notNull().default('active'),
  plan: text('plan').notNull().default('standard'),
  createdAt: createdAt(),
});

/** Where each tenant's dedicated Neo4j Community instance lives (ADR 0001). */
export const tenantDbInstances = pgTable('tenant_db_instances', {
  tenantId: text('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  boltUri: text('bolt_uri').notNull(),
  secretRef: text('secret_ref').notNull(),
  neo4jVersion: text('neo4j_version').notNull(),
  status: text('status', { enum: ['provisioning', 'ready', 'maintenance', 'failed'] })
    .notNull()
    .default('ready'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Versioned metamodel documents; workspaces pin one ACTIVE version. */
export const metamodels = pgTable(
  'metamodels',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    version: text('version').notNull(),
    content: jsonb('content').notNull(),
    contentHash: text('content_hash').notNull(),
    status: text('status', { enum: ['draft', 'active', 'retired'] }).notNull().default('draft'),
    createdAt: createdAt(),
    createdBy: text('created_by').notNull(),
  },
  (t) => ({
    nameVersion: uniqueIndex('metamodels_tenant_name_version').on(t.tenantId, t.name, t.version),
  }),
);

export const workspaces = pgTable(
  'workspaces',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    metamodelId: text('metamodel_id')
      .notNull()
      .references(() => metamodels.id),
    createdAt: createdAt(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => ({ slug: uniqueIndex('workspaces_tenant_slug').on(t.tenantId, t.slug) }),
);

/** Users are provisioned just-in-time from verified OIDC tokens. */
export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    subject: text('subject').notNull(),
    email: text('email'),
    displayName: text('display_name'),
    createdAt: createdAt(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ subject: uniqueIndex('users_tenant_subject').on(t.tenantId, t.subject) }),
);

export const groups = pgTable(
  'groups',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({ name: uniqueIndex('groups_tenant_name').on(t.tenantId, t.name) }),
);

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: text('group_id')
      .notNull()
      .references(() => groups.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => ({ pk: primaryKey({ columns: [t.groupId, t.userId] }) }),
);

export const ROLES = [
  'viewer',
  'contributor',
  'planner',
  'architect',
  'query-author',
  'query-steward',
  'admin',
] as const;

/**
 * Grants a role to a user or group, tenant-wide (`workspace_id` null) or for one workspace.
 * Combined with the IdP's realm roles when authorising. Role values are CHECK-constrained in
 * migration 0001.
 */
export const roleBindings = pgTable(
  'role_bindings',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    workspaceId: text('workspace_id').references(() => workspaces.id, { onDelete: 'cascade' }),
    principalType: text('principal_type', { enum: ['user', 'group'] }).notNull(),
    principalId: text('principal_id').notNull(),
    role: text('role', { enum: ROLES }).notNull(),
    createdAt: createdAt(),
    createdBy: text('created_by').notNull(),
  },
  (t) => ({
    unique: uniqueIndex('role_bindings_unique')
      .on(t.tenantId, t.principalType, t.principalId, t.role, sql`coalesce(${t.workspaceId}, '')`),
    principal: index('role_bindings_principal').on(t.tenantId, t.principalType, t.principalId),
  }),
);

/**
 * Append-only domain event log (audit, history, webhooks, tenant rebuilds). Rows are immutable
 * except `published_at`, which the outbox relay sets; enforced by a trigger (migration 0001).
 */
export const events = pgTable(
  'events',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    id: text('id').notNull().unique(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    workspaceId: text('workspace_id').notNull(),
    type: text('type').notNull(),
    subjectId: text('subject_id').notNull(),
    subjectVersion: integer('subject_version').notNull(),
    actor: text('actor').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    data: jsonb('data').notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => ({
    stream: index('events_tenant_workspace_seq').on(t.tenantId, t.workspaceId, t.seq),
    subject: index('events_subject').on(t.tenantId, t.subjectId, t.seq),
    unpublished: index('events_unpublished').on(t.seq).where(sql`${t.publishedAt} is null`),
  }),
);

// ── Query Catalog (ADR 0002) ────────────────────────────────────────────

/** A catalog entry. Its Cypher lives in immutable versions; users run published versions only. */
export const queries = pgTable(
  'queries',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id')
      .notNull()
      .references(() => tenants.id),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    /** Shipped with the platform (system pack) rather than authored in the tenant. */
    system: boolean('system').notNull().default(false),
    /** Marked as mastered/certified by a steward. */
    certified: boolean('certified').notNull().default(false),
    ownerId: text('owner_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({ slug: uniqueIndex('queries_tenant_slug').on(t.tenantId, t.slug) }),
);

export const QUERY_STATUSES = ['draft', 'in_review', 'published', 'deprecated', 'retired'] as const;

/**
 * One version of a query. Cypher, parameters and result shape are frozen once the version leaves
 * draft (enforced by a trigger in migration 0003); only status and review fields change after.
 */
export const queryVersions = pgTable(
  'query_versions',
  {
    id: text('id').primaryKey(),
    queryId: text('query_id')
      .notNull()
      .references(() => queries.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    cypher: text('cypher').notNull(),
    /** Parameter definitions (name, type, required, default, enum, element type, label). */
    params: jsonb('params').notNull(),
    resultShape: text('result_shape', { enum: ['table', 'graph'] }).notNull(),
    /** 'read' runs in a READ session; 'write' is admin-approved and runs via commands. */
    kind: text('kind', { enum: ['read', 'write'] }).notNull().default('read'),
    contentHash: text('content_hash').notNull(),
    status: text('status', { enum: QUERY_STATUSES }).notNull().default('draft'),
    /** Findings from the authoring checks at the last test or submit. */
    checks: jsonb('checks'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    reviewedBy: text('reviewed_by'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewNote: text('review_note'),
    publishedAt: timestamp('published_at', { withTimezone: true }),
  },
  (t) => ({
    version: uniqueIndex('query_versions_query_version').on(t.queryId, t.version),
    status: index('query_versions_status').on(t.queryId, t.status),
  }),
);

/** Who may see and run a query's published versions: a realm role or a D4 group. */
export const queryGrants = pgTable(
  'query_grants',
  {
    queryId: text('query_id')
      .notNull()
      .references(() => queries.id, { onDelete: 'cascade' }),
    principalType: text('principal_type', { enum: ['role', 'group'] }).notNull(),
    principal: text('principal').notNull(),
    grantedBy: text('granted_by').notNull(),
    grantedAt: timestamp('granted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.queryId, t.principalType, t.principal] }) }),
);

/** Every run, for audit and usage analytics. */
export const queryExecutions = pgTable(
  'query_executions',
  {
    seq: bigserial('seq', { mode: 'number' }).primaryKey(),
    tenantId: text('tenant_id').notNull(),
    queryId: text('query_id').notNull(),
    version: integer('version').notNull(),
    workspaceId: text('workspace_id').notNull(),
    userId: text('user_id').notNull(),
    params: jsonb('params').notNull(),
    status: text('status', { enum: ['ok', 'error', 'timeout'] }).notNull(),
    rowCount: integer('row_count'),
    durationMs: integer('duration_ms').notNull(),
    error: text('error'),
    executedAt: timestamp('executed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ byQuery: index('query_executions_query').on(t.tenantId, t.queryId, t.seq) }),
);
