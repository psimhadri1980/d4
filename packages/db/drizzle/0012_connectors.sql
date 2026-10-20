CREATE TABLE IF NOT EXISTS "connector_items" (
	"connector_id" text NOT NULL,
	"external_key" text NOT NULL,
	"element_id" text NOT NULL,
	"synced_version" integer NOT NULL,
	"source_hash" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_items_connector_id_external_key_pk" PRIMARY KEY("connector_id","external_key")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connectors" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"config" jsonb NOT NULL,
	"mapping" jsonb NOT NULL,
	"secret" text,
	"conflict_policy" text DEFAULT 'skip' NOT NULL,
	"cadence" jsonb,
	"next_run_at" timestamp with time zone,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_job_id" text,
	"last_run_at" timestamp with time zone,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "connector_items" ADD CONSTRAINT "connector_items_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "connectors_workspace_key" ON "connectors" USING btree ("tenant_id","workspace_id","key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "connectors_due" ON "connectors" USING btree ("enabled","next_run_at");