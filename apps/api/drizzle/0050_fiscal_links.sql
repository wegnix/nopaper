ALTER TABLE "fiscal_documents" ADD COLUMN "linked_bill_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;
--> statement-breakpoint

-- o nome fantasia passou a fazer parte dos detalhes: relidos na próxima abertura da lista

UPDATE "fiscal_documents" SET "details" = NULL;
