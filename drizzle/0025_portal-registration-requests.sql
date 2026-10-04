ALTER TABLE "registration_submissions" ADD COLUMN "source" text DEFAULT 'public' NOT NULL;--> statement-breakpoint
ALTER TABLE "registration_submissions" ADD COLUMN "animal_id" uuid;--> statement-breakpoint
ALTER TABLE "registration_submissions" ADD COLUMN "ownership_id" uuid;--> statement-breakpoint
ALTER TABLE "registration_submissions" ADD COLUMN "auth_identity_id" uuid;--> statement-breakpoint
ALTER TABLE "registration_submissions" ADD COLUMN "requested_year" integer;--> statement-breakpoint
ALTER TABLE "registration_submissions" ADD COLUMN "owner_note" text;--> statement-breakpoint
ALTER TABLE "registration_submissions" ADD CONSTRAINT "registration_submissions_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_submissions" ADD CONSTRAINT "registration_submissions_ownership_id_ownerships_id_fk" FOREIGN KEY ("ownership_id") REFERENCES "public"."ownerships"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_submissions" ADD CONSTRAINT "registration_submissions_auth_identity_id_auth_identities_id_fk" FOREIGN KEY ("auth_identity_id") REFERENCES "public"."auth_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "registration_submissions_pending_animal_year_key" ON "registration_submissions" USING btree ("animal_id","requested_year") WHERE "registration_submissions"."status" = 'pending' AND "registration_submissions"."animal_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "registration_submissions_animal_year_idx" ON "registration_submissions" USING btree ("animal_id","requested_year");--> statement-breakpoint
ALTER TABLE "registration_submissions" ADD CONSTRAINT "registration_submissions_source_check" CHECK ("registration_submissions"."source" IN ('public','portal'));--> statement-breakpoint
ALTER TABLE "registration_submissions" ADD CONSTRAINT "registration_submissions_requested_year_check" CHECK ("registration_submissions"."requested_year" IS NULL OR "registration_submissions"."requested_year" BETWEEN 2000 AND 2200);--> statement-breakpoint
ALTER TABLE "registration_submissions" ADD CONSTRAINT "registration_submissions_portal_linkage_check" CHECK ("registration_submissions"."source" <> 'portal' OR ("registration_submissions"."animal_id" IS NOT NULL AND "registration_submissions"."requested_year" IS NOT NULL));