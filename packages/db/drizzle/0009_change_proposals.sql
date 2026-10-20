CREATE TABLE IF NOT EXISTS "change_proposals" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"workspace_id" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"operations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"review_comment" text,
	"applied_refs" jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "change_proposals_workspace" ON "change_proposals" USING btree ("tenant_id","workspace_id","status");