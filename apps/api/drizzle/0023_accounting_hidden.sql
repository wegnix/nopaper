ALTER TABLE "accounting_documents" ADD COLUMN "hidden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "accounting_documents" ADD COLUMN "hidden_by" uuid;