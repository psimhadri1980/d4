CREATE TABLE IF NOT EXISTS "graph_backups" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"reason" text NOT NULL,
	"object_key" text NOT NULL,
	"bytes" integer NOT NULL,
	"elements" integer NOT NULL,
	"relationships" integer NOT NULL,
	"event_seq" bigint NOT NULL,
	"checksum" text NOT NULL,
	"job_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "locked_reason" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "graph_backups_workspace" ON "graph_backups" USING btree ("tenant_id","workspace_id","created_at");