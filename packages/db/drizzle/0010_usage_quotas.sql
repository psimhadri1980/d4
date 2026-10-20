CREATE TABLE IF NOT EXISTS "tenant_quotas" (
	"tenant_id" text PRIMARY KEY NOT NULL,
	"limits" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "usage_daily" (
	"tenant_id" text NOT NULL,
	"day" date NOT NULL,
	"metric" text NOT NULL,
	"value" bigint NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_daily_tenant_id_day_metric_pk" PRIMARY KEY("tenant_id","day","metric")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tenant_quotas" ADD CONSTRAINT "tenant_quotas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_tenant_time" ON "jobs" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "query_executions_tenant_time" ON "query_executions" USING btree ("tenant_id","executed_at");