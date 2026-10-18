-- Hand-written: constraints and guards drizzle-kit does not generate.

ALTER TABLE "query_versions" ADD CONSTRAINT "query_versions_status_check"
  CHECK ("status" IN ('draft','in_review','published','deprecated','retired'));
--> statement-breakpoint
ALTER TABLE "query_versions" ADD CONSTRAINT "query_versions_shape_check"
  CHECK ("result_shape" IN ('table','graph'));
--> statement-breakpoint
ALTER TABLE "query_versions" ADD CONSTRAINT "query_versions_kind_check"
  CHECK ("kind" IN ('read','write'));
--> statement-breakpoint
ALTER TABLE "query_grants" ADD CONSTRAINT "query_grants_principal_type_check"
  CHECK ("principal_type" IN ('role','group'));
--> statement-breakpoint

-- Once a version leaves draft its content is frozen, and status only moves forward along
-- draft → in_review → published → deprecated → retired (in_review may return to draft).
CREATE OR REPLACE FUNCTION query_versions_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status <> 'draft' AND (
       NEW.cypher IS DISTINCT FROM OLD.cypher
    OR NEW.params IS DISTINCT FROM OLD.params
    OR NEW.result_shape IS DISTINCT FROM OLD.result_shape
    OR NEW.kind IS DISTINCT FROM OLD.kind
    OR NEW.content_hash IS DISTINCT FROM OLD.content_hash) THEN
    RAISE EXCEPTION 'query version % is %; its content is immutable', OLD.id, OLD.status;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status = 'in_review')
    OR (OLD.status = 'in_review' AND NEW.status IN ('draft', 'published'))
    OR (OLD.status = 'published' AND NEW.status = 'deprecated')
    OR (OLD.status = 'deprecated' AND NEW.status IN ('published', 'retired'))) THEN
    RAISE EXCEPTION 'query version cannot move from % to %', OLD.status, NEW.status;
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER "query_versions_guard" BEFORE UPDATE ON "query_versions"
  FOR EACH ROW EXECUTE FUNCTION query_versions_guard();
--> statement-breakpoint

-- At most one open draft or review per query.
CREATE UNIQUE INDEX "query_versions_one_open" ON "query_versions" ("query_id")
  WHERE "status" IN ('draft', 'in_review');
--> statement-breakpoint

-- Catalog search over title, description and tags. Index expressions must be IMMUTABLE, which
-- array_to_string is not, so the document is built by a wrapper the search query also uses.
CREATE OR REPLACE FUNCTION query_search_doc(title text, description text, tags text[])
  RETURNS tsvector LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT to_tsvector('simple', title || ' ' || coalesce(description, '') || ' ' || coalesce(array_to_string(tags, ' '), ''))
$$;
--> statement-breakpoint
CREATE INDEX "queries_search" ON "queries" USING gin (query_search_doc("title", "description", "tags"));
