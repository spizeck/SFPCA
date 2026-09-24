ALTER TABLE "follow_ups" DROP CONSTRAINT "follow_ups_status_check";--> statement-breakpoint
ALTER TABLE "follow_ups" ADD COLUMN "reason" text;--> statement-breakpoint
-- Pre-#175 rows stored the recheck reason in `notes`; move it to the
-- dedicated column so the queue renders one honest headline field.
UPDATE "follow_ups" SET "reason" = "notes", "notes" = NULL WHERE "reason" IS NULL AND "notes" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "follow_ups_open_due_idx" ON "follow_ups" USING btree ("due_on") WHERE "follow_ups"."status" = 'open';--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_resolved_consistency_check" CHECK (("follow_ups"."status" = 'open') = ("follow_ups"."resolved_at" IS NULL));--> statement-breakpoint
-- The terminal state was renamed to match the #175 vocabulary
-- ('completed', not 'done') — rewrite before the new CHECK lands.
UPDATE "follow_ups" SET "status" = 'completed' WHERE "status" = 'done';--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_status_check" CHECK ("follow_ups"."status" IN ('open','completed','cancelled'));
