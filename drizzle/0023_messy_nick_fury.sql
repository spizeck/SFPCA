CREATE TABLE "app_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"lifecycle" text DEFAULT 'prelaunch-demo' NOT NULL,
	"live_at" timestamp with time zone,
	"demo_seeded_at" timestamp with time zone,
	"demo_seed_version" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_state_single_row_check" CHECK ("app_state"."id" = 1),
	CONSTRAINT "app_state_lifecycle_check" CHECK ("app_state"."lifecycle" IN ('prelaunch-demo','live'))
);
--> statement-breakpoint
CREATE TABLE "demo_seed_entities" (
	"run_id" uuid NOT NULL,
	"entity_store" text NOT NULL,
	"entity_table" text NOT NULL,
	"entity_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "demo_seed_entities_entity_store_entity_table_entity_id_pk" PRIMARY KEY("entity_store","entity_table","entity_id"),
	CONSTRAINT "demo_seed_entities_store_check" CHECK ("demo_seed_entities"."entity_store" IN ('postgres','firestore','storage','auth'))
);
--> statement-breakpoint
CREATE TABLE "demo_seed_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seed_version" integer NOT NULL,
	"seeded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reset_at" timestamp with time zone,
	"seeded_counts" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"empty_firestore_collections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"empty_storage_prefixes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "demo_seed_entities" ADD CONSTRAINT "demo_seed_entities_run_id_demo_seed_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."demo_seed_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "demo_seed_entities_run_idx" ON "demo_seed_entities" USING btree ("run_id");--> statement-breakpoint
-- The lifecycle row: fresh EMPTY databases begin in 'prelaunch-demo' so
-- the production deploy enters demo posture automatically. A database
-- that already carries operational (domain) rows starts 'live' instead
-- — populated data must never silently drop into demo posture (banner,
-- noindex, demo email sink, sweep skip). The exempt set mirrors
-- scripts/lib/demo-db.ts: tooling tables, the preserved-by-window
-- staff/identity tables (operator accounts may legitimately pre-exist),
-- and ephemeral rate-limit state. E2E/dev fixtures that need live
-- behavior UPDATE it to 'live' after migrating (still legal — the
-- trigger only freezes a 'live' row).
DO $$
DECLARE
  t record;
  n bigint;
BEGIN
  FOR t IN
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename NOT IN (
        'app_state', 'demo_seed_runs', 'demo_seed_entities',
        'household_members', 'admin_users', 'auth_identities',
        'households', 'audit_events', 'persons', 'rate_limit_windows'
      )
  LOOP
    EXECUTE format('SELECT count(*) FROM %I', t.tablename) INTO n;
    IF n > 0 THEN
      INSERT INTO "app_state" ("id", "lifecycle") VALUES (1, 'live');
      RETURN;
    END IF;
  END LOOP;
  INSERT INTO "app_state" ("id", "lifecycle") VALUES (1, 'prelaunch-demo');
END $$;--> statement-breakpoint
-- One-way lifecycle enforcement: once the row reads 'live' it can
-- never be UPDATEd or DELETEd — the prelaunch-demo state is frozen
-- into the past and the demo tooling can never be re-engaged without
-- deliberately dropping a database trigger (never an app action).
CREATE OR REPLACE FUNCTION "app_state_live_is_final"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."lifecycle" = 'live' THEN
    RAISE EXCEPTION 'app_state: lifecycle is final once live — UPDATE and DELETE are refused';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER "app_state_live_is_final"
BEFORE UPDATE OR DELETE ON "app_state"
FOR EACH ROW EXECUTE FUNCTION "app_state_live_is_final"();
