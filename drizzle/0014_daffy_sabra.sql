CREATE TABLE "payment_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"payment_id" uuid NOT NULL,
	"event" text NOT NULL,
	"actor_label" text,
	"source" text DEFAULT 'staff' NOT NULL,
	"detail" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_events_event_check" CHECK ("payment_events"."event" IN ('recorded','confirmed','failed','voided','refunded','adjusted')),
	CONSTRAINT "payment_events_source_check" CHECK ("payment_events"."source" IN ('staff','provider'))
);
--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "method" text DEFAULT 'other' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "source" text DEFAULT 'staff' NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "reference" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "related_payment_id" uuid;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "recorded_by" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Pre-#170 scaffold rows encoded the method inside provider
-- ('manual:cash') and kept the note inside metadata. Normalize them
-- onto the new columns BEFORE the method/source/provider consistency
-- CHECKs land: manual:* becomes a real method + staff source with a
-- NULL provider; any other provider value is an online/provider row.
UPDATE "payments" SET
  "method" = CASE
    WHEN "provider" = 'manual:cash' THEN 'cash'
    WHEN "provider" = 'manual:bank-transfer' THEN 'bank-transfer'
    WHEN "provider" LIKE 'manual:%' THEN 'other'
    WHEN "provider" IS NOT NULL THEN 'online'
    ELSE 'other' END,
  "source" = CASE
    WHEN "provider" IS NOT NULL AND "provider" NOT LIKE 'manual:%'
      THEN 'provider'
    ELSE 'staff' END,
  "note" = COALESCE("note", "metadata"->>'note'),
  "provider" = CASE
    WHEN "provider" LIKE 'manual:%' THEN NULL
    ELSE "provider" END
WHERE "provider" IS NOT NULL OR "metadata"->>'note' IS NOT NULL;--> statement-breakpoint
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payment_events_payment_idx" ON "payment_events" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "payment_events_created_idx" ON "payment_events" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_related_payment_id_payments_id_fk" FOREIGN KEY ("related_payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payments_related_idx" ON "payments" USING btree ("related_payment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_ref_key" ON "payments" USING btree ("provider","provider_ref") WHERE "payments"."provider_ref" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_idempotency_key" ON "payments" USING btree ("idempotency_key") WHERE "payments"."idempotency_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_method_check" CHECK ("payments"."method" IN ('cash','bank-transfer','other','online'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_source_check" CHECK ("payments"."source" IN ('staff','provider'));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_check" CHECK (("payments"."kind" IN ('payment','refund') AND "payments"."amount_cents" > 0) OR ("payments"."kind" = 'adjustment' AND "payments"."amount_cents" <> 0));--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_provider_consistency_check" CHECK (("payments"."method" = 'online') = ("payments"."provider" IS NOT NULL) AND ("payments"."provider_ref" IS NULL OR "payments"."provider" IS NOT NULL));