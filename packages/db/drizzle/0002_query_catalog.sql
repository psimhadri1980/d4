CREATE TABLE IF NOT EXISTS "queries" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"system" boolean DEFAULT false NOT NULL,
	"certified" boolean DEFAULT false NOT NULL,
	"owner_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "query_executions" (
	"seq" bigserial PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"query_id" text NOT NULL,
	"version" integer NOT NULL,
	"workspace_id" text NOT NULL,
	"user_id" text NOT NULL,
	"params" jsonb NOT NULL,
	"status" text NOT NULL,
	"row_count" integer,
	"duration_ms" integer NOT NULL,
	"error" text,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "query_grants" (
	"query_id" text NOT NULL,
	"principal_type" text NOT NULL,
	"principal" text NOT NULL,
	"granted_by" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "query_grants_query_id_principal_type_principal_pk" PRIMARY KEY("query_id","principal_type","principal")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "query_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"query_id" text NOT NULL,
	"version" integer NOT NULL,
	"cypher" text NOT NULL,
	"params" jsonb NOT NULL,
	"result_shape" text NOT NULL,
	"kind" text DEFAULT 'read' NOT NULL,
	"content_hash" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"checks" jsonb,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"review_note" text,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "queries" ADD CONSTRAINT "queries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "query_grants" ADD CONSTRAINT "query_grants_query_id_queries_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."queries"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "query_versions" ADD CONSTRAINT "query_versions_query_id_queries_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."queries"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "queries_tenant_slug" ON "queries" USING btree ("tenant_id","slug");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "query_executions_query" ON "query_executions" USING btree ("tenant_id","query_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "query_versions_query_version" ON "query_versions" USING btree ("query_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "query_versions_status" ON "query_versions" USING btree ("query_id","status");