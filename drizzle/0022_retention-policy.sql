CREATE TABLE "retention_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"created_by_label" text NOT NULL,
	"created_by_identity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	"removed_by_label" text,
	"removed_by_identity_id" uuid,
	CONSTRAINT "retention_holds_entity_type_check" CHECK ("retention_holds"."entity_type" IN ('registration_submission','registration')),
	CONSTRAINT "retention_holds_reason_check" CHECK (length(btrim("retention_holds"."reason")) > 0),
	CONSTRAINT "retention_holds_removed_consistency_check" CHECK (("retention_holds"."removed_at" IS NULL) = ("retention_holds"."removed_by_label" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "registration_submissions" ADD COLUMN "receipt_verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "registration_submissions" ADD COLUMN "receipt_purged_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "retention_holds" ADD CONSTRAINT "retention_holds_created_by_identity_id_auth_identities_id_fk" FOREIGN KEY ("created_by_identity_id") REFERENCES "public"."auth_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "retention_holds" ADD CONSTRAINT "retention_holds_removed_by_identity_id_auth_identities_id_fk" FOREIGN KEY ("removed_by_identity_id") REFERENCES "public"."auth_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "retention_holds_active_key" ON "retention_holds" USING btree ("entity_type","entity_id") WHERE "retention_holds"."removed_at" IS NULL;--> statement-breakpoint
CREATE INDEX "retention_holds_entity_idx" ON "retention_holds" USING btree ("entity_type","entity_id");--> statement-breakpoint
-- Backfill the verification stamp for existing receipts (#130). Staff
-- approval and confirmed payments are the only trustworthy
-- verification signals ever recorded; the stamp is the EARLIEST of the
-- two. Manual payments insert directly as 'confirmed' with only a
-- 'recorded' event, so both event shapes count — restricted to
-- confirmed payment rows. Rows with neither stay NULL — an
-- unverifiable timestamp fails closed and the receipt is simply never
-- 90-day purge-eligible.
UPDATE "registration_submissions" s
SET "receipt_verified_at" = LEAST(
	CASE WHEN s."status" = 'approved' THEN s."decided_at" END,
	(
		SELECT min(pe."created_at")
		FROM "payment_events" pe
		JOIN "payments" p ON p."id" = pe."payment_id"
		WHERE p."submission_id" = s."id"
		  AND p."kind" = 'payment' AND p."status" = 'confirmed'
		  AND (pe."event" = 'confirmed'
		       OR (pe."event" = 'recorded' AND pe."detail"->>'status' = 'confirmed'))
	)
)
WHERE s."payment_receipt_path" IS NOT NULL;