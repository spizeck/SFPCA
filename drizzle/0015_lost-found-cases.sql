CREATE TABLE "lost_found_cases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_type" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"animal_id" uuid,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reported_via" text DEFAULT 'staff' NOT NULL,
	"reporter_name" text,
	"reporter_contact" text,
	"last_seen_on" date,
	"last_seen_location" text,
	"found_on" date,
	"found_location" text,
	"description" text,
	"photo_urls" text[] DEFAULT '{}'::text[] NOT NULL,
	"chip_number" text,
	"chip_display" text,
	"microchip_record_id" uuid,
	"linked_at" timestamp with time zone,
	"linked_by" text,
	"published_at" timestamp with time zone,
	"published_by" text,
	"public_note" text,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"outcome" text,
	"resolution_note" text,
	"notes" text,
	"actor_identity_id" uuid,
	"actor_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lost_found_cases_type_check" CHECK ("lost_found_cases"."case_type" IN ('missing','found')),
	CONSTRAINT "lost_found_cases_status_check" CHECK ("lost_found_cases"."status" IN ('open','resolved','cancelled')),
	CONSTRAINT "lost_found_cases_outcome_check" CHECK ("lost_found_cases"."outcome" IS NULL OR "lost_found_cases"."outcome" IN ('reunited','owner-located','in-care','deceased','other')),
	CONSTRAINT "lost_found_cases_reported_via_check" CHECK ("lost_found_cases"."reported_via" IN ('staff','owner-portal')),
	CONSTRAINT "lost_found_cases_missing_animal_check" CHECK ("lost_found_cases"."case_type" = 'found' OR "lost_found_cases"."animal_id" IS NOT NULL),
	CONSTRAINT "lost_found_cases_resolved_consistency_check" CHECK (("lost_found_cases"."status" = 'open') = ("lost_found_cases"."resolved_at" IS NULL)),
	CONSTRAINT "lost_found_cases_outcome_consistency_check" CHECK (("lost_found_cases"."status" = 'resolved') = ("lost_found_cases"."outcome" IS NOT NULL)),
	CONSTRAINT "lost_found_cases_publish_check" CHECK ("lost_found_cases"."published_at" IS NULL OR ("lost_found_cases"."case_type" = 'missing' AND "lost_found_cases"."animal_id" IS NOT NULL)),
	CONSTRAINT "lost_found_cases_linked_check" CHECK ("lost_found_cases"."linked_at" IS NULL OR ("lost_found_cases"."linked_by" IS NOT NULL AND "lost_found_cases"."animal_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "lost_found_updates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"case_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"location" text,
	"note" text,
	"reporter_name" text,
	"reporter_contact" text,
	"source" text DEFAULT 'staff' NOT NULL,
	"actor_identity_id" uuid,
	"actor_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lost_found_updates_kind_check" CHECK ("lost_found_updates"."kind" IN ('sighting','scan','update')),
	CONSTRAINT "lost_found_updates_source_check" CHECK ("lost_found_updates"."source" IN ('staff','owner-portal','public'))
);
--> statement-breakpoint
ALTER TABLE "lost_found_cases" ADD CONSTRAINT "lost_found_cases_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lost_found_cases" ADD CONSTRAINT "lost_found_cases_microchip_record_id_microchip_records_id_fk" FOREIGN KEY ("microchip_record_id") REFERENCES "public"."microchip_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lost_found_cases" ADD CONSTRAINT "lost_found_cases_actor_identity_id_auth_identities_id_fk" FOREIGN KEY ("actor_identity_id") REFERENCES "public"."auth_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lost_found_updates" ADD CONSTRAINT "lost_found_updates_case_id_lost_found_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."lost_found_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lost_found_updates" ADD CONSTRAINT "lost_found_updates_actor_identity_id_auth_identities_id_fk" FOREIGN KEY ("actor_identity_id") REFERENCES "public"."auth_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "lost_found_cases_animal_idx" ON "lost_found_cases" USING btree ("animal_id");--> statement-breakpoint
CREATE INDEX "lost_found_cases_chip_idx" ON "lost_found_cases" USING btree ("chip_number");--> statement-breakpoint
CREATE INDEX "lost_found_cases_open_idx" ON "lost_found_cases" USING btree ("case_type","reported_at") WHERE "lost_found_cases"."status" = 'open';--> statement-breakpoint
CREATE INDEX "lost_found_cases_public_idx" ON "lost_found_cases" USING btree ("reported_at") WHERE "lost_found_cases"."status" = 'open' AND "lost_found_cases"."published_at" IS NOT NULL AND "lost_found_cases"."case_type" = 'missing';--> statement-breakpoint
CREATE UNIQUE INDEX "lost_found_cases_open_missing_key" ON "lost_found_cases" USING btree ("animal_id") WHERE "lost_found_cases"."status" = 'open' AND "lost_found_cases"."case_type" = 'missing';--> statement-breakpoint
CREATE UNIQUE INDEX "lost_found_cases_open_found_key" ON "lost_found_cases" USING btree ("animal_id") WHERE "lost_found_cases"."status" = 'open' AND "lost_found_cases"."case_type" = 'found' AND "lost_found_cases"."animal_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "lost_found_cases_open_chip_key" ON "lost_found_cases" USING btree ("chip_number") WHERE "lost_found_cases"."status" = 'open' AND "lost_found_cases"."animal_id" IS NULL AND "lost_found_cases"."chip_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "lost_found_updates_case_idx" ON "lost_found_updates" USING btree ("case_id","occurred_at");--> statement-breakpoint
-- #168 found_reports evolved into 'found' lost/found cases: carry every
-- existing scan record across (same id, same actor) before the old table
-- is dropped in the following migration. resolved rows map outcome
-- verbatim; a resolved row with no outcome (impossible under the old
-- service but not DB-enforced) degrades to 'other' so the new
-- outcome-consistency CHECK holds.
INSERT INTO "lost_found_cases" (
	"id",
	"case_type",
	"status",
	"animal_id",
	"microchip_record_id",
	"chip_number",
	"chip_display",
	"reported_at",
	"resolved_at",
	"resolved_by",
	"outcome",
	"notes",
	"actor_identity_id",
	"actor_label",
	"created_at",
	"updated_at"
)
SELECT
	"id",
	'found',
	"status",
	"animal_id",
	"microchip_record_id",
	"chip_number",
	"chip_display",
	"reported_on"::timestamptz,
	"resolved_on"::timestamptz,
	CASE WHEN "status" = 'resolved' THEN "actor_label" ELSE NULL END,
	CASE WHEN "status" = 'resolved' THEN coalesce("outcome", 'other') ELSE NULL END,
	"notes",
	"actor_identity_id",
	"actor_label",
	"created_at",
	"updated_at"
FROM "found_reports";