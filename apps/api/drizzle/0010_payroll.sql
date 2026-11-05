CREATE TABLE "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(120) NOT NULL,
	"document" varchar(32),
	"role" varchar(64),
	"admission_date" date,
	"termination_date" date,
	"active" boolean DEFAULT true NOT NULL,
	"pix_key" varchar(140),
	"bank_info" varchar(255),
	"notes" text,
	"import_batch_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"payslip_net" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"off_payroll" numeric(14, 2) DEFAULT '0' NOT NULL,
	"employer_cost" numeric(14, 2) DEFAULT '0' NOT NULL,
	"company_cost" numeric(14, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"bill_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_entry_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"rubric_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"note" varchar(120)
);
--> statement-breakpoint
CREATE TABLE "payroll_periods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"ref" varchar(7) NOT NULL,
	"pay_date" date NOT NULL,
	"bills_enabled" boolean DEFAULT true NOT NULL,
	"notes" text,
	"import_batch_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_rubrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(64) NOT NULL,
	"section" varchar(16) NOT NULL,
	"kind" varchar(16) DEFAULT 'earning' NOT NULL,
	"fixed" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort_order" smallint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "payroll_entry_id" uuid;--> statement-breakpoint
ALTER TABLE "employees" ADD CONSTRAINT "employees_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_entries" ADD CONSTRAINT "payroll_entries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_entries" ADD CONSTRAINT "payroll_entries_period_id_payroll_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."payroll_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_entries" ADD CONSTRAINT "payroll_entries_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_entries" ADD CONSTRAINT "payroll_entries_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_entry_lines" ADD CONSTRAINT "payroll_entry_lines_entry_id_payroll_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."payroll_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_entry_lines" ADD CONSTRAINT "payroll_entry_lines_rubric_id_payroll_rubrics_id_fk" FOREIGN KEY ("rubric_id") REFERENCES "public"."payroll_rubrics"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_periods" ADD CONSTRAINT "payroll_periods_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_rubrics" ADD CONSTRAINT "payroll_rubrics_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "employees_org_name_uq" ON "employees" USING btree ("org_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_entries_period_employee_uq" ON "payroll_entries" USING btree ("period_id","employee_id");--> statement-breakpoint
CREATE INDEX "payroll_entries_employee_idx" ON "payroll_entries" USING btree ("employee_id");--> statement-breakpoint
CREATE INDEX "payroll_lines_entry_idx" ON "payroll_entry_lines" USING btree ("entry_id");--> statement-breakpoint
CREATE INDEX "payroll_lines_rubric_idx" ON "payroll_entry_lines" USING btree ("rubric_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_periods_org_ref_uq" ON "payroll_periods" USING btree ("org_id","ref");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_rubrics_org_name_uq" ON "payroll_rubrics" USING btree ("org_id",lower("name"));--> statement-breakpoint
CREATE INDEX "bills_payroll_entry_idx" ON "bills" USING btree ("payroll_entry_id") WHERE "bills"."payroll_entry_id" is not null;