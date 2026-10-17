-- Hand-written: constraints drizzle-kit does not generate.

ALTER TABLE "role_bindings" ADD CONSTRAINT "role_bindings_role_check"
  CHECK ("role" IN ('viewer','contributor','planner','architect','query-author','query-steward','admin'));
--> statement-breakpoint

-- The event log is append-only: no deletes, no truncates, and updates may only set published_at.
CREATE OR REPLACE FUNCTION events_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION 'events are append-only (% not allowed)', TG_OP;
  END IF;
  IF (to_jsonb(NEW) - 'published_at') IS DISTINCT FROM (to_jsonb(OLD) - 'published_at') THEN
    RAISE EXCEPTION 'events are immutable; only published_at may change';
  END IF;
  IF OLD.published_at IS NOT NULL AND NEW.published_at IS DISTINCT FROM OLD.published_at THEN
    RAISE EXCEPTION 'published_at is already set';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "events_append_only_row" BEFORE UPDATE OR DELETE ON "events"
  FOR EACH ROW EXECUTE FUNCTION events_append_only();
--> statement-breakpoint
CREATE TRIGGER "events_append_only_truncate" BEFORE TRUNCATE ON "events"
  FOR EACH STATEMENT EXECUTE FUNCTION events_append_only();
