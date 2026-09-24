CREATE TABLE "clinic_expectations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"animal_id" uuid NOT NULL,
	"person_id" uuid,
	"encounter_id" uuid,
	"expected_on" date NOT NULL,
	"session_label" text,
	"reason" text NOT NULL,
	"status" text DEFAULT 'expected' NOT NULL,
	"notes" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinic_expectations_status_check" CHECK ("clinic_expectations"."status" IN ('expected','seen','no_show','cancelled')),
	CONSTRAINT "clinic_expectations_resolved_consistency_check" CHECK (("clinic_expectations"."status" = 'expected') = ("clinic_expectations"."resolved_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "clinic_expectations" ADD CONSTRAINT "clinic_expectations_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_expectations" ADD CONSTRAINT "clinic_expectations_person_id_persons_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."persons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinic_expectations" ADD CONSTRAINT "clinic_expectations_encounter_id_vet_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."vet_encounters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clinic_expectations_animal_idx" ON "clinic_expectations" USING btree ("animal_id");--> statement-breakpoint
CREATE INDEX "clinic_expectations_expected_idx" ON "clinic_expectations" USING btree ("expected_on") WHERE "clinic_expectations"."status" = 'expected';