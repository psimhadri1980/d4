CREATE TABLE IF NOT EXISTS "schedules" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"params" jsonb NOT NULL,
	"use_run_date" boolean DEFAULT true NOT NULL,
	"cadence" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_job_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "jobs" ADD COLUMN "schedule_id" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedules_workspace" ON "schedules" USING btree ("tenant_id","workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "schedules_due" ON "schedules" USING btree ("enabled","next_run_at");