DROP INDEX "payslip_signatures_emp_comp_uq";--> statement-breakpoint
ALTER TABLE "payslip_signatures" ADD COLUMN "doc_key" varchar(40) DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payslip_signatures_emp_comp_uq" ON "payslip_signatures" USING btree ("org_id","employee_id","competence","doc_key");