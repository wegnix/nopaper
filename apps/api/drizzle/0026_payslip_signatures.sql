CREATE TABLE "payslip_signatures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"period_id" uuid,
	"employee_id" uuid,
	"employee_name" varchar(120) NOT NULL,
	"employee_document" varchar(32) NOT NULL,
	"competence" varchar(7) NOT NULL,
	"net" numeric(14, 2) NOT NULL,
	"slip" jsonb NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"token_enc" text NOT NULL,
	"status" varchar(12) DEFAULT 'pending' NOT NULL,
	"storage_key" varchar(255) NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"size" integer NOT NULL,
	"signed_key" varchar(255),
	"signed_sha256" varchar(64),
	"signed_size" integer,
	"signed_at" timestamp with time zone,
	"signer_ip" varchar(64),
	"signer_ua" varchar(400),
	"term_version" varchar(8),
	"viewed_at" timestamp with time zone,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"accounting_doc_id" uuid,
	"sent_to_accountant_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "esign_accepted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "esign_term_version" varchar(8);--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "esign_accepted_ip" varchar(64);--> statement-breakpoint
ALTER TABLE "payslip_signatures" ADD CONSTRAINT "payslip_signatures_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_signatures" ADD CONSTRAINT "payslip_signatures_period_id_payroll_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."payroll_periods"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_signatures" ADD CONSTRAINT "payslip_signatures_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payslip_signatures" ADD CONSTRAINT "payslip_signatures_accounting_doc_id_accounting_documents_id_fk" FOREIGN KEY ("accounting_doc_id") REFERENCES "public"."accounting_documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payslip_signatures_token_uq" ON "payslip_signatures" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "payslip_signatures_emp_comp_uq" ON "payslip_signatures" USING btree ("org_id","employee_id","competence");--> statement-breakpoint
CREATE INDEX "payslip_signatures_period_idx" ON "payslip_signatures" USING btree ("org_id","period_id");