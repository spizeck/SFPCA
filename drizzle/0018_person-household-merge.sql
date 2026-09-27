CREATE TABLE "household_merges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"retired_household_id" uuid NOT NULL,
	"survivor_household_id" uuid NOT NULL,
	"retired_name" text NOT NULL,
	"retired_address" text,
	"field_choices" jsonb,
	"moved_counts" jsonb,
	"note" text,
	"merged_by_label" text,
	"merged_by_identity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "household_merges_not_self_check" CHECK ("household_merges"."retired_household_id" <> "household_merges"."survivor_household_id")
);
--> statement-breakpoint
CREATE TABLE "person_merges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"retired_person_id" uuid NOT NULL,
	"survivor_person_id" uuid NOT NULL,
	"retired_full_name" text NOT NULL,
	"retired_email" text,
	"field_choices" jsonb,
	"moved_counts" jsonb,
	"note" text,
	"merged_by_label" text,
	"merged_by_identity_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "person_merges_not_self_check" CHECK ("person_merges"."retired_person_id" <> "person_merges"."survivor_person_id")
);
--> statement-breakpoint
ALTER TABLE "household_merges" ADD CONSTRAINT "household_merges_retired_household_id_households_id_fk" FOREIGN KEY ("retired_household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_merges" ADD CONSTRAINT "household_merges_survivor_household_id_households_id_fk" FOREIGN KEY ("survivor_household_id") REFERENCES "public"."households"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "household_merges" ADD CONSTRAINT "household_merges_merged_by_identity_id_auth_identities_id_fk" FOREIGN KEY ("merged_by_identity_id") REFERENCES "public"."auth_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_merges" ADD CONSTRAINT "person_merges_retired_person_id_persons_id_fk" FOREIGN KEY ("retired_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_merges" ADD CONSTRAINT "person_merges_survivor_person_id_persons_id_fk" FOREIGN KEY ("survivor_person_id") REFERENCES "public"."persons"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "person_merges" ADD CONSTRAINT "person_merges_merged_by_identity_id_auth_identities_id_fk" FOREIGN KEY ("merged_by_identity_id") REFERENCES "public"."auth_identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "household_merges_retired_key" ON "household_merges" USING btree ("retired_household_id");--> statement-breakpoint
CREATE INDEX "household_merges_survivor_idx" ON "household_merges" USING btree ("survivor_household_id");--> statement-breakpoint
CREATE UNIQUE INDEX "person_merges_retired_key" ON "person_merges" USING btree ("retired_person_id");--> statement-breakpoint
CREATE INDEX "person_merges_survivor_idx" ON "person_merges" USING btree ("survivor_person_id");