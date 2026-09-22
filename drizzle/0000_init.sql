CREATE TABLE "admin_users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"auth_identity_id" uuid,
	"person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "admin_users_role_check" CHECK ("admin_users"."role" IN ('admin','editor'))
);
--> statement-breakpoint
CREATE TABLE "animals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_id" text,
	"name" text NOT NULL,
	"species" text NOT NULL,
	"sex" text NOT NULL,
	"approx_age" text,
	"description" text,
	"lifecycle_status" text NOT NULL,
	"photo_urls" text[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "animals_species_check" CHECK ("animals"."species" IN ('dog','cat','other')),
	CONSTRAINT "animals_sex_check" CHECK ("animals"."sex" IN ('male','female','unknown')),
	CONSTRAINT "animals_lifecycle_status_check" CHECK ("animals"."lifecycle_status" IN ('available','pending','adopted'))
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_identity_id" uuid,
	"actor_label" text,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"action" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"provider" text NOT NULL,
	"provider_uid" text NOT NULL,
	"email" text,
	"person_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"person_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"kind" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"idempotency_key" text,
	"related_type" text,
	"related_id" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "communications_channel_check" CHECK ("communications"."channel" IN ('email','sms','whatsapp','phone')),
	CONSTRAINT "communications_status_check" CHECK ("communications"."status" IN ('queued','sent','failed','skipped'))
);
--> statement-breakpoint
CREATE TABLE "follow_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"animal_id" uuid,
	"person_id" uuid,
	"registration_id" uuid,
	"kind" text NOT NULL,
	"due_on" date NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"notes" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "follow_ups_status_check" CHECK ("follow_ups"."status" IN ('open','done','cancelled'))
);
--> statement-breakpoint
CREATE TABLE "household_members" (
	"household_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_members_household_id_person_id_pk" PRIMARY KEY("household_id","person_id"),
	CONSTRAINT "household_members_role_check" CHECK ("household_members"."role" IN ('member','primary'))
);
--> statement-breakpoint
CREATE TABLE "households" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "microchip_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"chip_number" text NOT NULL,
	"animal_id" uuid NOT NULL,
	"assigned_from" date DEFAULT now() NOT NULL,
	"assigned_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "microchip_assignment_range_check" CHECK ("microchip_records"."assigned_to" IS NULL OR "microchip_records"."assigned_to" >= "microchip_records"."assigned_from")
);
--> statement-breakpoint
CREATE TABLE "ownerships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"animal_id" uuid NOT NULL,
	"person_id" uuid,
	"household_id" uuid,
	"valid_from" date NOT NULL,
	"valid_to" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ownerships_one_owner_side_check" CHECK (num_nonnulls("ownerships"."person_id", "ownerships"."household_id") = 1),
	CONSTRAINT "ownerships_valid_range_check" CHECK ("ownerships"."valid_to" IS NULL OR "ownerships"."valid_to" > "ownerships"."valid_from")
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"registration_id" uuid,
	"submission_id" uuid,
	"person_id" uuid,
	"amount_cents" integer NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"kind" text DEFAULT 'payment' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider" text,
	"provider_ref" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payments_kind_check" CHECK ("payments"."kind" IN ('payment','refund','adjustment')),
	CONSTRAINT "payments_status_check" CHECK ("payments"."status" IN ('pending','confirmed','failed','void'))
);
--> statement-breakpoint
CREATE TABLE "persons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"full_name" text NOT NULL,
	"email" text,
	"phone" text,
	"address" text,
	"preferred_channel" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "persons_preferred_channel_check" CHECK ("persons"."preferred_channel" IS NULL OR "persons"."preferred_channel" IN ('email','phone','whatsapp','sms'))
);
--> statement-breakpoint
CREATE TABLE "registration_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legacy_id" text,
	"owner_name" text NOT NULL,
	"owner_address" text,
	"owner_phone" text,
	"owner_email" text,
	"person_id" uuid,
	"payment_receipt_path" text,
	"total_fee_cents" integer DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registration_submissions_status_check" CHECK ("registration_submissions"."status" IN ('pending','approved','rejected')),
	CONSTRAINT "registration_submissions_fee_check" CHECK ("registration_submissions"."total_fee_cents" >= 0)
);
--> statement-breakpoint
CREATE TABLE "registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"animal_id" uuid NOT NULL,
	"submission_id" uuid,
	"year" integer NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "registrations_year_check" CHECK ("registrations"."year" BETWEEN 2000 AND 2200),
	CONSTRAINT "registrations_status_check" CHECK ("registrations"."status" IN ('pending','approved','rejected'))
);
--> statement-breakpoint
CREATE TABLE "vet_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"animal_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"occurred_on" date NOT NULL,
	"summary" text NOT NULL,
	"valid_until" date,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vet_events_type_check" CHECK ("vet_events"."event_type" IN ('vaccination','exam','treatment','surgery','note','other'))
);
--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_auth_identity_id_auth_identities_id_fk" FOREIGN KEY ("auth_identity_id") REFERENCES "public"."auth_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "admin_users" ADD CONSTRAINT "admin_users_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_identity_id_auth_identities_id_fk" FOREIGN KEY ("actor_identity_id") REFERENCES "public"."auth_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_identities" ADD CONSTRAINT "auth_identities_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communications" ADD CONSTRAINT "communications_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_members" ADD CONSTRAINT "household_members_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "microchip_records" ADD CONSTRAINT "microchip_records_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownerships" ADD CONSTRAINT "ownerships_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownerships" ADD CONSTRAINT "ownerships_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ownerships" ADD CONSTRAINT "ownerships_household_id_households_id_fk" FOREIGN KEY ("household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_submission_id_registration_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."registration_submissions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registration_submissions" ADD CONSTRAINT "registration_submissions_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "registrations" ADD CONSTRAINT "registrations_submission_id_registration_submissions_id_fk" FOREIGN KEY ("submission_id") REFERENCES "public"."registration_submissions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vet_events" ADD CONSTRAINT "vet_events_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "admin_users_email_key" ON "admin_users" USING btree (lower("email"));--> statement-breakpoint
CREATE UNIQUE INDEX "animals_legacy_id_key" ON "animals" USING btree ("legacy_id");--> statement-breakpoint
CREATE INDEX "animals_lifecycle_status_idx" ON "animals" USING btree ("lifecycle_status");--> statement-breakpoint
CREATE INDEX "audit_events_entity_idx" ON "audit_events" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "audit_events_created_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_identities_provider_uid_key" ON "auth_identities" USING btree ("provider","provider_uid");--> statement-breakpoint
CREATE UNIQUE INDEX "communications_idempotency_key" ON "communications" USING btree ("idempotency_key");--> statement-breakpoint
CREATE INDEX "communications_person_idx" ON "communications" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "follow_ups_due_idx" ON "follow_ups" USING btree ("due_on");--> statement-breakpoint
CREATE UNIQUE INDEX "microchip_active_chip_key" ON "microchip_records" USING btree ("chip_number") WHERE "microchip_records"."assigned_to" IS NULL;--> statement-breakpoint
CREATE INDEX "microchip_animal_idx" ON "microchip_records" USING btree ("animal_id");--> statement-breakpoint
CREATE INDEX "ownerships_animal_idx" ON "ownerships" USING btree ("animal_id");--> statement-breakpoint
CREATE INDEX "payments_registration_idx" ON "payments" USING btree ("registration_id");--> statement-breakpoint
CREATE INDEX "payments_person_idx" ON "payments" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "persons_email_idx" ON "persons" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "registration_submissions_legacy_id_key" ON "registration_submissions" USING btree ("legacy_id");--> statement-breakpoint
CREATE UNIQUE INDEX "registrations_animal_year_key" ON "registrations" USING btree ("animal_id","year");--> statement-breakpoint
CREATE INDEX "registrations_submission_idx" ON "registrations" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "vet_events_animal_idx" ON "vet_events" USING btree ("animal_id");