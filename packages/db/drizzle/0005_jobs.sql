CREATE TABLE IF NOT EXISTS "jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"params" jsonb NOT NULL,
	"progress" integer DEFAULT 0 NOT NULL,
	"result" jsonb,
	"error" text,
	"artifact_key" text,
	"artifact_name" text,
	"artifact_type" text,
	"artifact_bytes" integer,
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_workspace" ON "jobs" USING btree ("tenant_id","workspace_id","created_at");