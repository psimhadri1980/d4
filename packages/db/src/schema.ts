import { sql } from 'drizzle-orm';
import {
  bigint,
  bigserial,
  date,
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
    /** Set while a restore or rebuild replaces the graph; model writes are refused meanwhile. */
    lockedReason: text('locked_reason'),
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
    /** Realm roles from the IdP at the last sign-in; lets background work re-check access. */
    realmRoles: text('realm_roles').array().notNull().default(sql`'{}'::text[]`),
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
    /** Archived entries are hidden from the catalog but kept, with their versions, for audit. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
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
  (t) => ({
    byQuery: index('query_executions_query').on(t.tenantId, t.queryId, t.seq),
    byDay: index('query_executions_tenant_time').on(t.tenantId, t.executedAt),
  }),
);

export const JOB_KINDS = ['export', 'import-tabular', 'render', 'backup', 'verify', 'restore', 'rebuild', 'sync'] as const;

/**
 * Background jobs (imports, exports, renders). The queue (BullMQ in Redis) only carries the job
 * id; this table is the durable record users see: status, progress, result and the artefact.
 */
export const jobs = pgTable(
  'jobs',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    kind: text('kind', { enum: JOB_KINDS }).notNull(),
    status: text('status', { enum: ['queued', 'running', 'succeeded', 'failed'] }).notNull().default('queued'),
    params: jsonb('params').notNull(),
    /** 0–100. */
    progress: integer('progress').notNull().default(0),
    result: jsonb('result'),
    error: text('error'),
    /** Object key in the artefact bucket (input upload or output file). */
    artifactKey: text('artifact_key'),
    artifactName: text('artifact_name'),
    artifactType: text('artifact_type'),
    artifactBytes: integer('artifact_bytes'),
    attempts: integer('attempts').notNull().default(0),
    /** The schedule that started this job, if any. */
    scheduleId: text('schedule_id'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => ({
    byWorkspace: index('jobs_workspace').on(t.tenantId, t.workspaceId, t.createdAt),
    byTenant: index('jobs_tenant_time').on(t.tenantId, t.createdAt),
  }),
);

/**
 * Report schedules: a job spec (export or render) plus a cadence. The worker's scheduler claims
 * due rows (`next_run_at <= now`) and creates ordinary jobs owned by `created_by`.
 */
export const schedules = pgTable(
  'schedules',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    name: text('name').notNull(),
    kind: text('kind', { enum: ['export', 'render'] }).notNull(),
    params: jsonb('params').notNull(),
    /** Set the as-of date (exports, graph pictures) or "today" (roadmaps) to the run date. */
    useRunDate: boolean('use_run_date').notNull().default(true),
    /** { frequency: daily | weekly | monthly, hour (UTC), weekday?, day? } */
    cadence: jsonb('cadence').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    /** Why the system paused the schedule (e.g. the owner lost access); null when paused by a person. */
    pausedReason: text('paused_reason'),
    /** Email addresses that receive each run's file (or a link to it). */
    recipients: text('recipients').array().notNull().default(sql`'{}'::text[]`),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }).notNull(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastJobId: text('last_job_id'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byWorkspace: index('schedules_workspace').on(t.tenantId, t.workspaceId),
    due: index('schedules_due').on(t.enabled, t.nextRunAt),
  }),
);

// ── Webhooks (Phase 5b) ─────────────────────────────────────────────────

/**
 * An HTTPS endpoint that receives model events, signed with its own secret. `workspaceId` null
 * means every workspace in the tenant; an empty `eventTypes` means every event type.
 */
export const webhooks = pgTable(
  'webhooks',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    workspaceId: text('workspace_id'),
    name: text('name').notNull(),
    url: text('url').notNull(),
    secret: text('secret').notNull(),
    eventTypes: text('event_types').array().notNull().default(sql`'{}'::text[]`),
    enabled: boolean('enabled').notNull().default(true),
    /** Why the system turned the webhook off (e.g. repeated failures); null when off by a person. */
    disabledReason: text('disabled_reason'),
    /** Deliveries that ended in failure in a row; reset by any success. */
    consecutiveFailures: integer('consecutive_failures').notNull().default(0),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTenant: index('webhooks_tenant').on(t.tenantId),
  }),
);

/** One event (or test ping) to one webhook, with its retry state and the last response. */
export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: text('id').primaryKey(),
    webhookId: text('webhook_id')
      .notNull()
      .references(() => webhooks.id, { onDelete: 'cascade' }),
    /** null for a test ping */
    eventId: text('event_id'),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').notNull(),
    status: text('status', { enum: ['pending', 'succeeded', 'failed'] }).notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
    responseStatus: integer('response_status'),
    lastError: text('last_error'),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (t) => ({
    once: uniqueIndex('webhook_deliveries_once').on(t.webhookId, t.eventId),
    due: index('webhook_deliveries_due').on(t.status, t.nextAttemptAt),
    byWebhook: index('webhook_deliveries_webhook').on(t.webhookId, t.createdAt),
  }),
);

// ── Change proposals (Phase 5c) ─────────────────────────────────────────

export const PROPOSAL_STATUSES = ['draft', 'submitted', 'applied', 'rejected', 'withdrawn'] as const;

/**
 * Model changes held for review. `operations` are ProposalOperation steps (see `@d4/core`); they
 * apply as one change when a reviewer approves. Applied, rejected and withdrawn are final.
 */
export const changeProposals = pgTable(
  'change_proposals',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    status: text('status', { enum: PROPOSAL_STATUSES }).notNull().default('draft'),
    operations: jsonb('operations').notNull().default(sql`'[]'::jsonb`),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    reviewComment: text('review_comment'),
    /** Element ref → id assigned when the proposal applied. */
    appliedRefs: jsonb('applied_refs'),
  },
  (t) => ({
    byWorkspace: index('change_proposals_workspace').on(t.tenantId, t.workspaceId, t.status),
  }),
);

// ── Usage and quotas (Phase 5d) ─────────────────────────────────────────

export const QUOTA_METRICS = ['elements', 'relationships', 'workspaces', 'queryRunsPerDay', 'jobsPerDay', 'storageBytes'] as const;

/**
 * Per-tenant limits that replace the built-in defaults. A metric missing from `limits` uses the
 * default; `null` means unlimited. Set by the platform operator, not by tenant admins.
 */
export const tenantQuotas = pgTable('tenant_quotas', {
  tenantId: text('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  limits: jsonb('limits').notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: text('updated_by').notNull(),
});

/** Daily usage readings for billing and trends; the worker refreshes today's row through the day. */
export const usageDaily = pgTable(
  'usage_daily',
  {
    tenantId: text('tenant_id').notNull(),
    day: date('day', { mode: 'string' }).notNull(),
    metric: text('metric').notNull(),
    value: bigint('value', { mode: 'number' }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.tenantId, t.day, t.metric] }) }),
);

// ── Graph backups (Phase 5e) ────────────────────────────────────────────

/**
 * A snapshot of one workspace's graph in object storage. `eventSeq` is the event-log position
 * when the snapshot started: restoring loads the snapshot, then replays events after it.
 */
export const graphBackups = pgTable(
  'graph_backups',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    /** manual, scheduled, or safety (taken automatically before a restore or rebuild) */
    reason: text('reason', { enum: ['manual', 'scheduled', 'safety'] }).notNull(),
    objectKey: text('object_key').notNull(),
    bytes: integer('bytes').notNull(),
    elements: integer('elements').notNull(),
    relationships: integer('relationships').notNull(),
    eventSeq: bigint('event_seq', { mode: 'number' }).notNull(),
    /** SHA-256 over the canonical items, to compare graphs without reading them. */
    checksum: text('checksum').notNull(),
    jobId: text('job_id'),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
  },
  (t) => ({ byWorkspace: index('graph_backups_workspace').on(t.tenantId, t.workspaceId, t.createdAt) }),
);

// ── Connectors (Phase 6a) ───────────────────────────────────────────────

/**
 * A source system synced into one workspace. `key` prefixes the external keys of the elements it
 * owns (`<key>:<source id>`). `secret` is write-only through the API (like webhook secrets).
 */
export const connectors = pgTable(
  'connectors',
  {
    id: text('id').primaryKey(),
    tenantId: text('tenant_id').notNull(),
    workspaceId: text('workspace_id').notNull(),
    key: text('key').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    /** Kind-specific source settings (URL, paging, auth scheme); never the secret. */
    config: jsonb('config').notNull(),
    /** How source records become elements and relationships. */
    mapping: jsonb('mapping').notNull(),
    secret: text('secret'),
    /** What to do when an item changed in D4 and in the source since the last sync. */
    conflictPolicy: text('conflict_policy', { enum: ['skip', 'source-wins'] }).notNull().default('skip'),
    /** { frequency, hour, … } as for report schedules; null = manual only. */
    cadence: jsonb('cadence'),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    enabled: boolean('enabled').notNull().default(true),
    lastJobId: text('last_job_id'),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    key: uniqueIndex('connectors_workspace_key').on(t.tenantId, t.workspaceId, t.key),
    due: index('connectors_due').on(t.enabled, t.nextRunAt),
  }),
);

/** What the last sync wrote for each source item: to tell D4 edits from source changes. */
export const connectorItems = pgTable(
  'connector_items',
  {
    connectorId: text('connector_id')
      .notNull()
      .references(() => connectors.id, { onDelete: 'cascade' }),
    externalKey: text('external_key').notNull(),
    elementId: text('element_id').notNull(),
    /** Element version right after the last sync wrote or confirmed it. */
    syncedVersion: integer('synced_version').notNull(),
    /** Hash of the mapped source values at the last sync. */
    sourceHash: text('source_hash').notNull(),
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.connectorId, t.externalKey] }) }),
);

// ── Web modules (P6, D64) ───────────────────────────────────────────────

/**
 * The module registry: web modules the shell loads at run time (single-spa lifecycle modules),
 * with what they are and which release to load. Per tenant, so an admin chooses what their people
 * get; the shell picks up changes while it runs.
 */
export const webModules = pgTable(
  'web_modules',
  {
    tenantId: text('tenant_id').notNull(),
    /** Also the path it owns under a workspace: `/w/:ws/<name>`. */
    name: text('name').notNull(),
    title: text('title').notNull(),
    description: text('description'),
    /** The team that answers for it. */
    owner: text('owner'),
    /** Same-origin URL of its ES module entry, under `/mfe/<name>/`. */
    entry: text('entry').notNull(),
    version: text('version').notNull(),
    /** The lifecycle contract it was built for. */
    contract: integer('contract').notNull(),
    framework: text('framework').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdBy: text('created_by').notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({ pk: primaryKey({ columns: [t.tenantId, t.name] }) }),
);
