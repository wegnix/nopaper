CREATE TABLE "accounting_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" varchar(16) NOT NULL,
	"competence" varchar(7),
	"note" varchar(500),
	"original_name" varchar(255) NOT NULL,
	"mime" varchar(100) NOT NULL,
	"size" integer NOT NULL,
	"storage_key" varchar(255) NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"detected" jsonb,
	"status" varchar(12) DEFAULT 'new' NOT NULL,
	"bill_id" uuid,
	"handled_by" uuid,
	"handled_at" timestamp with time zone,
	"handle_note" varchar(500),
	"uploaded_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounting_documents" ADD CONSTRAINT "accounting_documents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "accounting_documents" ADD CONSTRAINT "accounting_documents_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "accounting_docs_org_idx" ON "accounting_documents" USING btree ("org_id","status","created_at");--> statement-breakpoint
INSERT INTO "groups" ("org_id", "name", "description", "permissions")
SELECT o."id", 'Contador', 'Só envia documentos (holerites, guias, boletos) pela área do contador', ARRAY['accounting.upload']
FROM "organizations" o
WHERE NOT EXISTS (SELECT 1 FROM "groups" g WHERE g."org_id" = o."id" AND lower(g."name") = 'contador');
