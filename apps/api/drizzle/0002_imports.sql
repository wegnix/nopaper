CREATE TABLE "import_batches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"type" varchar(16) NOT NULL,
	"file_name" varchar(200) NOT NULL,
	"row_count" integer NOT NULL,
	"total_amount" numeric(14, 2) NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"undone_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "import_batches_org_idx" ON "import_batches" USING btree ("org_id","created_at");