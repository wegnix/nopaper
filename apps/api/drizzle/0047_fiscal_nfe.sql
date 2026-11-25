CREATE TABLE "fiscal_configs" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"query_hour" integer DEFAULT 6 NOT NULL,
	"uf" varchar(2),
	"category_id" uuid,
	"folder_id" uuid,
	"cert_enc" text,
	"cert_pass_enc" text,
	"cert_subject" varchar(300),
	"cert_document" varchar(20),
	"cert_not_before" timestamp with time zone,
	"cert_not_after" timestamp with time zone,
	"cert_fingerprint" varchar(120),
	"cert_uploaded_by" uuid,
	"cert_uploaded_by_name" varchar(120),
	"cert_uploaded_at" timestamp with time zone,
	"last_nsu" bigint DEFAULT 0 NOT NULL,
	"max_nsu" bigint,
	"last_query_at" timestamp with time zone,
	"last_status" varchar(16),
	"last_message" text,
	"last_auto_date" date,
	"next_allowed_at" timestamp with time zone,
	"paused_at" timestamp with time zone,
	"paused_reason" text,
	"expiry_warned_for" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fiscal_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"access_key" varchar(44) NOT NULL,
	"nsu" bigint,
	"kind" varchar(16) DEFAULT 'summary' NOT NULL,
	"status" varchar(16) DEFAULT 'new' NOT NULL,
	"situation" varchar(16) DEFAULT 'authorized' NOT NULL,
	"role" varchar(16) DEFAULT 'recipient' NOT NULL,
	"number" varchar(20),
	"series" varchar(5),
	"issued_at" date,
	"emitter_document" varchar(20),
	"emitter_name" varchar(200),
	"total" numeric(14, 2),
	"nature" varchar(120),
	"duplicates" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payment_kinds" text[] DEFAULT '{}'::text[] NOT NULL,
	"xml" text,
	"bill_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"handled_by" uuid,
	"handled_by_name" varchar(120),
	"handled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "fiscal_configs" ADD CONSTRAINT "fiscal_configs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_configs" ADD CONSTRAINT "fiscal_configs_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_configs" ADD CONSTRAINT "fiscal_configs_folder_id_folders_id_fk" FOREIGN KEY ("folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fiscal_documents" ADD CONSTRAINT "fiscal_documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "fiscal_documents_key_uq" ON "fiscal_documents" USING btree ("org_id","access_key");--> statement-breakpoint
CREATE INDEX "fiscal_documents_list_idx" ON "fiscal_documents" USING btree ("org_id","status","issued_at");