ALTER TABLE "organizations" ADD COLUMN "legal_name" varchar(160);--> statement-breakpoint
ALTER TABLE "payslip_signatures" ADD COLUMN "kind" varchar(12) DEFAULT 'payslip' NOT NULL;