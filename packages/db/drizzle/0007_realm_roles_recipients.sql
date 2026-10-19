ALTER TABLE "schedules" ADD COLUMN "paused_reason" text;--> statement-breakpoint
ALTER TABLE "schedules" ADD COLUMN "recipients" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "realm_roles" text[] DEFAULT '{}'::text[] NOT NULL;