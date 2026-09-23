CREATE TABLE "vaccinations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"animal_id" uuid NOT NULL,
	"vaccine_name" text NOT NULL,
	"administered_on" date NOT NULL,
	"due_on" date,
	"valid_until" date,
	"product_name" text,
	"manufacturer" text,
	"lot_number" text,
	"administered_by" text,
	"notes" text,
	"document_path" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "vaccinations_due_range_check" CHECK ("vaccinations"."due_on" IS NULL OR "vaccinations"."due_on" >= "vaccinations"."administered_on"),
	CONSTRAINT "vaccinations_valid_range_check" CHECK ("vaccinations"."valid_until" IS NULL OR "vaccinations"."valid_until" >= "vaccinations"."administered_on")
);
--> statement-breakpoint
ALTER TABLE "vaccinations" ADD CONSTRAINT "vaccinations_animal_id_animals_id_fk" FOREIGN KEY ("animal_id") REFERENCES "public"."animals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "vaccinations_animal_idx" ON "vaccinations" USING btree ("animal_id");--> statement-breakpoint
CREATE INDEX "vaccinations_due_idx" ON "vaccinations" USING btree ("due_on");