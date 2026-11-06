CREATE TABLE IF NOT EXISTS "studio_lenses" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"visibility" text DEFAULT 'private' NOT NULL,
	"body" jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "studio_lenses_workspace" ON "studio_lenses" USING btree ("tenant_id","workspace_id");