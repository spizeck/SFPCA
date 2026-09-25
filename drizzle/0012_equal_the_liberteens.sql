CREATE TABLE "found_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"animal_id" uuid,
	"microchip_record_id" uuid,
	"chip_number" text NOT NULL,
	"chip_display" text,
	"reported_on" date DEFAULT now() NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_on" date,
	"outcome" text,
	"notes" text,
	"actor_identity_id" uuid,
	"actor_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "found_reports_status_check" CHECK ("found_reports"."status" IN ('open','resolved')),
	CONSTRAINT "found_reports_outcome_check" CHECK ("found_reports"."outcome" IS NULL OR "found_reports"."outcome" IN ('reunited','in-care','other')),
	CONSTRAINT "found_reports_resolved_consistency_check" CHECK (("found_reports"."status" = 'open') = ("found_reports"."resolved_on" IS NULL)),
	CONSTRAINT "found_reports_resolved_range_check" CHECK ("found_reports"."resolved_on" IS NULL OR "found_reports"."resolved_on" >= "found_reports"."reported_on")
);
--> statement-breakpoint
CREATE TABLE "microchip_conflicts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chip_number" text NOT NULL,
	"claimed_animal_id" uuid NOT NULL,
	"existing_record_id" uuid,
	"existing_animal_id" uuid,
	"source" text NOT NULL,
	"detail" text,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "microchip_conflicts_source_check" CHECK ("microchip_conflicts"."source" IN ('staff','import')),
	CONSTRAINT "microchip_conflicts_status_check" CHECK ("microchip_conflicts"."status" IN ('open','resolved')),
	CONSTRAINT "microchip_conflicts_resolved_consistency_check" CHECK (("microchip_conflicts"."status" = 'open') = ("microchip_conflicts"."resolved_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "microchip_records" ADD COLUMN "chip_display" text;--> statement-breakpoint
ALTER TABLE "microchip_records" ADD COLUMN "manufacturer" text;--> statement-breakpoint
ALTER TABLE "microchip_records" ADD COLUMN "implanted_on" date;--> statement-breakpoint
ALTER TABLE "microchip_records" ADD COLUMN "implanted_by" text;--> statement-breakpoint
ALTER TABLE "microchip_records" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "microchip_records" ADD COLUMN "closed_reason" text;--> statement-breakpoint
ALTER TABLE "microchip_records" ADD COLUMN "replaced_by_id" uuid;--> statement-breakpoint
ALTER TABLE "microchip_records" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "found_reports" ADD CONSTRAINT "found_reports_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "found_reports" ADD CONSTRAINT "found_reports_microchip_record_id_microchip_records_id_fk" FOREIGN KEY ("microchip_record_id") REFERENCES "public"."microchip_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "found_reports" ADD CONSTRAINT "found_reports_actor_identity_id_auth_identities_id_fk" FOREIGN KEY ("actor_identity_id") REFERENCES "public"."auth_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "microchip_conflicts" ADD CONSTRAINT "microchip_conflicts_claimed_animal_id_animals_id_fk" FOREIGN KEY ("claimed_animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "microchip_conflicts" ADD CONSTRAINT "microchip_conflicts_existing_record_id_microchip_records_id_fk" FOREIGN KEY ("existing_record_id") REFERENCES "public"."microchip_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "microchip_conflicts" ADD CONSTRAINT "microchip_conflicts_existing_animal_id_animals_id_fk" FOREIGN KEY ("existing_animal_id") REFERENCES "public"."animals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "found_reports_animal_idx" ON "found_reports" USING btree ("animal_id");--> statement-breakpoint
CREATE INDEX "found_reports_chip_idx" ON "found_reports" USING btree ("chip_number");--> statement-breakpoint
CREATE INDEX "found_reports_open_idx" ON "found_reports" USING btree ("reported_on") WHERE "found_reports"."status" = 'open';--> statement-breakpoint
CREATE UNIQUE INDEX "found_reports_open_dedup" ON "found_reports" USING btree ("chip_number",coalesce("animal_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "found_reports"."status" = 'open';--> statement-breakpoint
CREATE INDEX "microchip_conflicts_chip_idx" ON "microchip_conflicts" USING btree ("chip_number");--> statement-breakpoint
CREATE INDEX "microchip_conflicts_animal_idx" ON "microchip_conflicts" USING btree ("claimed_animal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "microchip_conflicts_open_dedup" ON "microchip_conflicts" USING btree ("chip_number","claimed_animal_id") WHERE "microchip_conflicts"."status" = 'open';--> statement-breakpoint
ALTER TABLE "microchip_records" ADD CONSTRAINT "microchip_records_replaced_by_id_microchip_records_id_fk" FOREIGN KEY ("replaced_by_id") REFERENCES "public"."microchip_records"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "microchip_active_animal_key" ON "microchip_records" USING btree ("animal_id") WHERE "microchip_records"."assigned_to" IS NULL;--> statement-breakpoint
CREATE INDEX "microchip_chip_number_idx" ON "microchip_records" USING btree ("chip_number");--> statement-breakpoint
ALTER TABLE "microchip_records" ADD CONSTRAINT "microchip_closed_reason_check" CHECK ("microchip_records"."closed_reason" IS NULL OR "microchip_records"."closed_reason" IN ('replaced','removed','corrected'));--> statement-breakpoint
-- Backfill BEFORE the closure-consistency CHECK: a pre-#168 row closed
-- without a reason gets the honest 'removed' reason rather than failing
-- the new invariant.
UPDATE "microchip_records" SET "closed_reason" = 'removed' WHERE "assigned_to" IS NOT NULL AND "closed_reason" IS NULL;--> statement-breakpoint
ALTER TABLE "microchip_records" ADD CONSTRAINT "microchip_closure_consistency_check" CHECK (("microchip_records"."assigned_to" IS NULL) = ("microchip_records"."closed_reason" IS NULL));--> statement-breakpoint
ALTER TABLE "microchip_records" ADD CONSTRAINT "microchip_replaced_by_check" CHECK ("microchip_records"."replaced_by_id" IS NULL OR ("microchip_records"."replaced_by_id" <> "microchip_records"."id" AND "microchip_records"."assigned_to" IS NOT NULL));