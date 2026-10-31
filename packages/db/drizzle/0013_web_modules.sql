CREATE TABLE IF NOT EXISTS "web_modules" (
	"tenant_id" text NOT NULL,
	"name" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"owner" text,
	"entry" text NOT NULL,
	"version" text NOT NULL,
	"contract" integer NOT NULL,
	"framework" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "web_modules_tenant_id_name_pk" PRIMARY KEY("tenant_id","name")
);
