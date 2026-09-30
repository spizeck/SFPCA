CREATE TABLE "rate_limit_windows" (
	"bucket" text NOT NULL,
	"subject" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "rate_limit_windows_bucket_subject_window_start_pk" PRIMARY KEY("bucket","subject","window_start")
);
--> statement-breakpoint
CREATE INDEX "rate_limit_windows_expiry_idx" ON "rate_limit_windows" USING btree ("expires_at");