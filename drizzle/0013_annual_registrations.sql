ALTER TABLE "registrations" DROP CONSTRAINT "registrations_status_check";--> statement-breakpoint
ALTER TABLE "registrations" ALTER COLUMN "status" SET DEFAULT 'active';--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "ownership_id" uuid;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "person_id" uuid;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "household_id" uuid;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "owner_label" text;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "submitted_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "registered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "amount_due_cents" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "resolution" text;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "resolution_note" text;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "resolved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "resolved_by" text;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "cancellation_reason" text;--> statement-breakpoint
ALTER TABLE "registrations" ADD COLUMN "cancellation_note" text;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_ownership_id_ownerships_id_fk" FOREIGN KEY ("ownership_id") REFERENCES "public"."ownerships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "registrations_year_status_idx" ON "registrations" USING btree ("year","status");--> statement-breakpoint
CREATE INDEX "registrations_person_idx" ON "registrations" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "registrations_household_idx" ON "registrations" USING btree ("household_id");--> statement-breakpoint
-- Pre-#169 scaffold rows carried submission-style statuses; map them
-- onto the registration vocabulary BEFORE the new CHECK lands:
-- approved/pending become active registrations, rejected becomes a
-- cancelled correction. New columns must exist first, so this sits
-- between the column adds and the constraint adds.
UPDATE "registrations" SET
  "status" = CASE WHEN "status" = 'rejected' THEN 'cancelled' ELSE 'active' END,
  "registered_at" = "created_at",
  "cancelled_at" = CASE WHEN "status" = 'rejected' THEN now() ELSE NULL END,
  "cancellation_reason" = CASE WHEN "status" = 'rejected' THEN 'correction' ELSE NULL END
WHERE "status" IN ('pending','approved','rejected');--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_amount_check" CHECK ("registrations"."amount_due_cents" >= 0);--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_owner_side_check" CHECK (NOT ("registrations"."person_id" IS NOT NULL AND "registrations"."household_id" IS NOT NULL));--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_cancellation_consistency_check" CHECK (("registrations"."status" = 'cancelled') = ("registrations"."cancelled_at" IS NOT NULL) AND ("registrations"."cancelled_at" IS NULL) = ("registrations"."cancellation_reason" IS NULL));--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_cancellation_reason_check" CHECK ("registrations"."cancellation_reason" IS NULL OR "registrations"."cancellation_reason" IN ('correction','withdrawn'));--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_resolution_check" CHECK ("registrations"."resolution" IS NULL OR "registrations"."resolution" IN ('waived','complimentary'));--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_resolution_consistency_check" CHECK (("registrations"."resolution" IS NULL) = ("registrations"."resolved_at" IS NULL));--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_status_check" CHECK ("registrations"."status" IN ('active','cancelled'));