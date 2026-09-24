CREATE TABLE "medical_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"animal_id" uuid NOT NULL,
	"encounter_id" uuid,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'important' NOT NULL,
	"summary" text NOT NULL,
	"details" text,
	"status" text DEFAULT 'active' NOT NULL,
	"recorded_on" date NOT NULL,
	"resolved_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "medical_alerts_kind_check" CHECK ("medical_alerts"."kind" IN ('allergy','contraindication','condition','other')),
	CONSTRAINT "medical_alerts_severity_check" CHECK ("medical_alerts"."severity" IN ('info','important','critical')),
	CONSTRAINT "medical_alerts_status_check" CHECK ("medical_alerts"."status" IN ('active','resolved')),
	CONSTRAINT "medical_alerts_resolved_consistency_check" CHECK (("medical_alerts"."status" = 'resolved') = ("medical_alerts"."resolved_on" IS NOT NULL)),
	CONSTRAINT "medical_alerts_resolved_range_check" CHECK ("medical_alerts"."resolved_on" IS NULL OR "medical_alerts"."resolved_on" >= "medical_alerts"."recorded_on")
);
--> statement-breakpoint
CREATE TABLE "vet_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"animal_id" uuid NOT NULL,
	"encounter_id" uuid,
	"vaccination_id" uuid,
	"storage_path" text NOT NULL,
	"label" text NOT NULL,
	"notes" text,
	"uploaded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vet_documents_path_check" CHECK ("vet_documents"."storage_path" ~ '^vet-docs/')
);
--> statement-breakpoint
CREATE TABLE "vet_encounters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"animal_id" uuid NOT NULL,
	"kind" text DEFAULT 'visit' NOT NULL,
	"occurred_on" date NOT NULL,
	"provider" text,
	"reason" text,
	"complaint" text,
	"findings" text,
	"assessment" text,
	"plan" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vet_encounters_kind_check" CHECK ("vet_encounters"."kind" IN ('visit','history','note'))
);
--> statement-breakpoint
CREATE TABLE "vet_medications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"animal_id" uuid NOT NULL,
	"encounter_id" uuid,
	"medication" text NOT NULL,
	"dose" text,
	"route" text,
	"frequency" text,
	"start_on" date NOT NULL,
	"end_on" date,
	"instructions" text,
	"prescribed_by" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vet_medications_range_check" CHECK ("vet_medications"."end_on" IS NULL OR "vet_medications"."end_on" >= "vet_medications"."start_on")
);
--> statement-breakpoint
CREATE TABLE "vet_procedures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"animal_id" uuid NOT NULL,
	"encounter_id" uuid,
	"kind" text NOT NULL,
	"performed_on" date,
	"provider" text,
	"description" text NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vet_procedures_kind_check" CHECK ("vet_procedures"."kind" IN ('spay','neuter','surgery','dental','wound','other'))
);
--> statement-breakpoint
CREATE TABLE "weight_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"animal_id" uuid NOT NULL,
	"encounter_id" uuid,
	"measured_on" date NOT NULL,
	"weight_grams" integer NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "weight_records_grams_check" CHECK ("weight_records"."weight_grams" > 0 AND "weight_records"."weight_grams" <= 200000)
);
--> statement-breakpoint
ALTER TABLE "follow_ups" ADD COLUMN "encounter_id" uuid;--> statement-breakpoint
ALTER TABLE "vaccinations" ADD COLUMN "encounter_id" uuid;--> statement-breakpoint
ALTER TABLE "medical_alerts" ADD CONSTRAINT "medical_alerts_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_alerts" ADD CONSTRAINT "medical_alerts_encounter_id_vet_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."vet_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vet_documents" ADD CONSTRAINT "vet_documents_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vet_documents" ADD CONSTRAINT "vet_documents_encounter_id_vet_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."vet_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vet_documents" ADD CONSTRAINT "vet_documents_vaccination_id_vaccinations_id_fk" FOREIGN KEY ("vaccination_id") REFERENCES "public"."vaccinations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vet_encounters" ADD CONSTRAINT "vet_encounters_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vet_medications" ADD CONSTRAINT "vet_medications_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vet_medications" ADD CONSTRAINT "vet_medications_encounter_id_vet_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."vet_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vet_procedures" ADD CONSTRAINT "vet_procedures_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vet_procedures" ADD CONSTRAINT "vet_procedures_encounter_id_vet_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."vet_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weight_records" ADD CONSTRAINT "weight_records_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "weight_records" ADD CONSTRAINT "weight_records_encounter_id_vet_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."vet_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "medical_alerts_animal_idx" ON "medical_alerts" USING btree ("animal_id");--> statement-breakpoint
CREATE INDEX "medical_alerts_active_idx" ON "medical_alerts" USING btree ("animal_id") WHERE "medical_alerts"."status" = 'active';--> statement-breakpoint
CREATE INDEX "vet_documents_animal_idx" ON "vet_documents" USING btree ("animal_id");--> statement-breakpoint
CREATE INDEX "vet_documents_encounter_idx" ON "vet_documents" USING btree ("encounter_id");--> statement-breakpoint
CREATE INDEX "vet_encounters_animal_idx" ON "vet_encounters" USING btree ("animal_id","occurred_on");--> statement-breakpoint
CREATE INDEX "vet_medications_animal_idx" ON "vet_medications" USING btree ("animal_id","start_on");--> statement-breakpoint
CREATE INDEX "vet_medications_encounter_idx" ON "vet_medications" USING btree ("encounter_id");--> statement-breakpoint
CREATE INDEX "vet_procedures_animal_idx" ON "vet_procedures" USING btree ("animal_id","performed_on");--> statement-breakpoint
CREATE INDEX "vet_procedures_encounter_idx" ON "vet_procedures" USING btree ("encounter_id");--> statement-breakpoint
CREATE INDEX "weight_records_animal_idx" ON "weight_records" USING btree ("animal_id","measured_on");--> statement-breakpoint
CREATE INDEX "weight_records_encounter_idx" ON "weight_records" USING btree ("encounter_id");--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_encounter_id_vet_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."vet_encounters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vaccinations" ADD CONSTRAINT "vaccinations_encounter_id_vet_encounters_id_fk" FOREIGN KEY ("encounter_id") REFERENCES "public"."vet_encounters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "follow_ups_animal_idx" ON "follow_ups" USING btree ("animal_id");