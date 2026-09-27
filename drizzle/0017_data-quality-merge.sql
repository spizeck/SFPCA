CREATE TABLE "animal_merges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"retired_animal_id" uuid NOT NULL,
	"survivor_animal_id" uuid NOT NULL,
	"retired_registry_ref" text NOT NULL,
	"retired_legacy_id" text,
	"field_choices" jsonb,
	"moved_counts" jsonb,
	"note" text,
	"merged_by_label" text,
	"merged_by_identity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "animal_merges_not_self_check" CHECK ("animal_merges"."retired_animal_id" <> "animal_merges"."survivor_animal_id")
);
--> statement-breakpoint
CREATE TABLE "data_quality_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"detector" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_a" uuid NOT NULL,
	"entity_b" uuid,
	"fingerprint" text NOT NULL,
	"decision" text NOT NULL,
	"note" text,
	"decided_by_label" text,
	"decided_by_identity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "data_quality_reviews_decision_check" CHECK ("data_quality_reviews"."decision" IN ('confirmed','dismissed')),
	CONSTRAINT "data_quality_reviews_pair_order_check" CHECK ("data_quality_reviews"."entity_b" IS NULL OR "data_quality_reviews"."entity_a" < "data_quality_reviews"."entity_b")
);
--> statement-breakpoint
ALTER TABLE "animal_lifecycle_events" DROP CONSTRAINT "animal_lifecycle_events_from_status_check";--> statement-breakpoint
ALTER TABLE "animal_lifecycle_events" DROP CONSTRAINT "animal_lifecycle_events_to_status_check";--> statement-breakpoint
ALTER TABLE "animal_lifecycle_events" DROP CONSTRAINT "animal_lifecycle_events_source_check";--> statement-breakpoint
ALTER TABLE "animals" DROP CONSTRAINT "animals_lifecycle_status_check";--> statement-breakpoint
ALTER TABLE "animal_merges" ADD CONSTRAINT "animal_merges_retired_animal_id_animals_id_fk" FOREIGN KEY ("retired_animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "animal_merges" ADD CONSTRAINT "animal_merges_survivor_animal_id_animals_id_fk" FOREIGN KEY ("survivor_animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "animal_merges" ADD CONSTRAINT "animal_merges_merged_by_identity_id_auth_identities_id_fk" FOREIGN KEY ("merged_by_identity_id") REFERENCES "public"."auth_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "data_quality_reviews" ADD CONSTRAINT "data_quality_reviews_decided_by_identity_id_auth_identities_id_fk" FOREIGN KEY ("decided_by_identity_id") REFERENCES "public"."auth_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "animal_merges_retired_key" ON "animal_merges" USING btree ("retired_animal_id");--> statement-breakpoint
CREATE INDEX "animal_merges_survivor_idx" ON "animal_merges" USING btree ("survivor_animal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "data_quality_reviews_finding_key" ON "data_quality_reviews" USING btree ("detector","entity_type","entity_a",coalesce("entity_b", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
ALTER TABLE "animal_lifecycle_events" ADD CONSTRAINT "animal_lifecycle_events_from_status_check" CHECK ("animal_lifecycle_events"."from_status" IS NULL OR "animal_lifecycle_events"."from_status" IN ('active','deceased','moved-off-saba','unknown','merged'));--> statement-breakpoint
ALTER TABLE "animal_lifecycle_events" ADD CONSTRAINT "animal_lifecycle_events_to_status_check" CHECK ("animal_lifecycle_events"."to_status" IN ('active','deceased','moved-off-saba','unknown','merged'));--> statement-breakpoint
ALTER TABLE "animal_lifecycle_events" ADD CONSTRAINT "animal_lifecycle_events_source_check" CHECK ("animal_lifecycle_events"."source" IN ('staff','owner-request','import','merge'));--> statement-breakpoint
ALTER TABLE "animals" ADD CONSTRAINT "animals_lifecycle_status_check" CHECK ("animals"."lifecycle_status" IN ('active','deceased','moved-off-saba','unknown','merged'));