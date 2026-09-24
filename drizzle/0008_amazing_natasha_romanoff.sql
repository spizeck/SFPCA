CREATE TABLE "communication_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"kind" text NOT NULL,
	"opted_out" boolean DEFAULT false NOT NULL,
	"actor_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "communication_preferences_channel_check" CHECK ("communication_preferences"."channel" IN ('email','sms','whatsapp','phone')),
	CONSTRAINT "communication_preferences_kind_check" CHECK ("communication_preferences"."kind" IN ('vaccination-reminder'))
);
--> statement-breakpoint
ALTER TABLE "communications" DROP CONSTRAINT "communications_status_check";--> statement-breakpoint
ALTER TABLE "communications" ALTER COLUMN "person_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "animal_id" uuid;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "cycle_key" text;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "touch" text;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "recipient" text;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "subject" text;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "body_text" text;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "body_html" text;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "provider" text;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "provider_message_id" text;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "last_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "delivered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "detail" text;--> statement-breakpoint
ALTER TABLE "communications" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "communication_preferences" ADD CONSTRAINT "communication_preferences_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "communication_preferences_person_kind_key" ON "communication_preferences" USING btree ("person_id","channel","kind");--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "communications_animal_idx" ON "communications" USING btree ("animal_id");--> statement-breakpoint
CREATE INDEX "communications_related_idx" ON "communications" USING btree ("related_type","related_id");--> statement-breakpoint
CREATE INDEX "communications_queued_idx" ON "communications" USING btree ("created_at") WHERE "communications"."status" = 'queued';--> statement-breakpoint
CREATE INDEX "communications_sending_idx" ON "communications" USING btree ("last_attempt_at") WHERE "communications"."status" = 'sending';--> statement-breakpoint
CREATE INDEX "communications_exceptions_idx" ON "communications" USING btree ("created_at") WHERE "communications"."status" IN ('failed','skipped');--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_sent_consistency_check" CHECK ("communications"."sent_at" IS NOT NULL OR "communications"."status" NOT IN ('sent','delivered'));--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_delivered_consistency_check" CHECK ("communications"."delivered_at" IS NULL OR "communications"."status" IN ('delivered','failed'));--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_attempts_check" CHECK ("communications"."attempts" >= 0);--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_status_check" CHECK ("communications"."status" IN ('queued','sending','sent','delivered','failed','skipped'));