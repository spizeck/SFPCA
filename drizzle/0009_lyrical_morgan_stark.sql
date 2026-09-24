CREATE TABLE "owner_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"auth_identity_id" uuid,
	"person_id" uuid,
	"animal_id" uuid,
	"ownership_id" uuid,
	"detail" text,
	"payload" jsonb,
	"status" text DEFAULT 'pending' NOT NULL,
	"resolution_note" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_requests_kind_check" CHECK ("owner_requests"."kind" IN ('account-claim','no-longer-mine','transfer','lifecycle-deceased','lifecycle-moved-off-saba')),
	CONSTRAINT "owner_requests_status_check" CHECK ("owner_requests"."status" IN ('pending','approved','rejected','cancelled')),
	CONSTRAINT "owner_requests_resolved_consistency_check" CHECK (("owner_requests"."status" = 'pending') = ("owner_requests"."resolved_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE "ownership_confirmations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ownership_id" uuid NOT NULL,
	"animal_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"confirmed_by_identity_id" uuid,
	"confirmed_on" date DEFAULT now() NOT NULL,
	"method" text NOT NULL,
	"actor_label" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ownership_confirmations_method_check" CHECK ("ownership_confirmations"."method" IN ('owner-portal','staff'))
);
--> statement-breakpoint
ALTER TABLE "ownerships" ADD COLUMN "note" text;--> statement-breakpoint
ALTER TABLE "owner_requests" ADD CONSTRAINT "owner_requests_auth_identity_id_auth_identities_id_fk" FOREIGN KEY ("auth_identity_id") REFERENCES "public"."auth_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_requests" ADD CONSTRAINT "owner_requests_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_requests" ADD CONSTRAINT "owner_requests_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_requests" ADD CONSTRAINT "owner_requests_ownership_id_ownerships_id_fk" FOREIGN KEY ("ownership_id") REFERENCES "public"."ownerships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_confirmations" ADD CONSTRAINT "ownership_confirmations_ownership_id_ownerships_id_fk" FOREIGN KEY ("ownership_id") REFERENCES "public"."ownerships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_confirmations" ADD CONSTRAINT "ownership_confirmations_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_confirmations" ADD CONSTRAINT "ownership_confirmations_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownership_confirmations" ADD CONSTRAINT "ownership_confirmations_confirmed_by_identity_id_auth_identities_id_fk" FOREIGN KEY ("confirmed_by_identity_id") REFERENCES "public"."auth_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "owner_requests_pending_idx" ON "owner_requests" USING btree ("created_at") WHERE "owner_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "owner_requests_person_idx" ON "owner_requests" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "owner_requests_animal_idx" ON "owner_requests" USING btree ("animal_id");--> statement-breakpoint
CREATE INDEX "owner_requests_identity_idx" ON "owner_requests" USING btree ("auth_identity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "owner_requests_pending_dedup" ON "owner_requests" USING btree ("auth_identity_id","kind",coalesce("animal_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE "owner_requests"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "ownership_confirmations_ownership_idx" ON "ownership_confirmations" USING btree ("ownership_id");--> statement-breakpoint
CREATE INDEX "ownership_confirmations_animal_idx" ON "ownership_confirmations" USING btree ("animal_id");--> statement-breakpoint
CREATE INDEX "ownership_confirmations_confirmed_idx" ON "ownership_confirmations" USING btree ("confirmed_on");--> statement-breakpoint
CREATE INDEX "ownerships_person_idx" ON "ownerships" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "ownerships_household_idx" ON "ownerships" USING btree ("household_id");