ALTER TABLE "employees" ADD COLUMN "payslip_code" varchar(20);--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "payslip_only" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "employees_org_payslip_uq" ON "employees" USING btree ("org_id","payslip_code") WHERE "employees"."payslip_code" is not null;