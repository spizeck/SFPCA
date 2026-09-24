CREATE TABLE "animal_lifecycle_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"animal_id" uuid NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"effective_on" date NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"reason" text,
	"actor_identity_id" uuid,
	"actor_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "animal_lifecycle_events_from_status_check" CHECK ("animal_lifecycle_events"."from_status" IS NULL OR "animal_lifecycle_events"."from_status" IN ('active','deceased','moved-off-saba','unknown')),
	CONSTRAINT "animal_lifecycle_events_to_status_check" CHECK ("animal_lifecycle_events"."to_status" IN ('active','deceased','moved-off-saba','unknown')),
	CONSTRAINT "animal_lifecycle_events_source_check" CHECK ("animal_lifecycle_events"."source" IN ('staff','owner-request','import'))
);
--> statement-breakpoint
ALTER TABLE "animals" DROP CONSTRAINT "animals_lifecycle_status_check";--> statement-breakpoint
ALTER TABLE "animals" ALTER COLUMN "lifecycle_status" SET DEFAULT 'active';--> statement-breakpoint
-- Permanent human-readable registry reference. Monotonic, never reused,
-- meaningless beyond assignment order — the uuid remains the identity key.
CREATE SEQUENCE "animal_registry_ref_seq" START 1;--> statement-breakpoint
ALTER TABLE "animals" ADD COLUMN "registry_ref" text DEFAULT 'SFPCA-' || lpad(nextval('animal_registry_ref_seq'::regclass)::text, 6, '0') NOT NULL;--> statement-breakpoint
ALTER TABLE "animals" ADD COLUMN "birth_date" date;--> statement-breakpoint
ALTER TABLE "animals" ADD COLUMN "birth_date_estimated" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "animals" ADD COLUMN "identifying_notes" text;--> statement-breakpoint
ALTER TABLE "animals" ADD COLUMN "lifecycle_effective_on" date;--> statement-breakpoint
ALTER TABLE "animals" ADD COLUMN "adoption_status" text DEFAULT 'not-listed' NOT NULL;--> statement-breakpoint
ALTER TABLE "animals" ADD COLUMN "sterilization_status" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "animals" ADD COLUMN "sterilized_on" date;--> statement-breakpoint
ALTER TABLE "animals" ADD COLUMN "sterilized_by" text;--> statement-breakpoint
ALTER TABLE "animal_lifecycle_events" ADD CONSTRAINT "animal_lifecycle_events_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "animal_lifecycle_events" ADD CONSTRAINT "animal_lifecycle_events_actor_identity_id_auth_identities_id_fk" FOREIGN KEY ("actor_identity_id") REFERENCES "public"."auth_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "animal_lifecycle_events_animal_idx" ON "animal_lifecycle_events" USING btree ("animal_id","effective_on");--> statement-breakpoint
CREATE UNIQUE INDEX "animals_registry_ref_key" ON "animals" USING btree ("registry_ref");--> statement-breakpoint
CREATE INDEX "animals_adoption_status_idx" ON "animals" USING btree ("adoption_status");--> statement-breakpoint
ALTER TABLE "animals" ADD CONSTRAINT "animals_adoption_status_check" CHECK ("animals"."adoption_status" IN ('not-listed','available','pending','adopted'));--> statement-breakpoint
ALTER TABLE "animals" ADD CONSTRAINT "animals_sterilization_status_check" CHECK ("animals"."sterilization_status" IN ('unknown','sterilized','intact'));--> statement-breakpoint
ALTER TABLE "animals" ADD CONSTRAINT "animals_birth_estimate_consistency_check" CHECK ("animals"."birth_date_estimated" = false OR "animals"."birth_date" IS NOT NULL);--> statement-breakpoint
-- Backfill BEFORE the new lifecycle check: the old dual-purpose value
-- becomes adoption_status (preserving who was listed/pending/adopted),
-- and every pre-existing animal enters the registry lifecycle as
-- 'active' (they were all known on-island animals; 'adopted' animals
-- retain that fact in adoption_status, not as a registry state).
UPDATE "animals" SET "adoption_status" = "lifecycle_status";--> statement-breakpoint
UPDATE "animals" SET "lifecycle_status" = 'active';--> statement-breakpoint
UPDATE "animals" SET "lifecycle_effective_on" = "created_at"::date WHERE "lifecycle_effective_on" IS NULL;--> statement-breakpoint
ALTER TABLE "animals" ADD CONSTRAINT "animals_lifecycle_status_check" CHECK ("animals"."lifecycle_status" IN ('active','deceased','moved-off-saba','unknown'));