CREATE TABLE "payroll_thirteenth" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"period_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"year" smallint NOT NULL,
	"installment" varchar(8) NOT NULL,
	"pay_date" date NOT NULL,
	"net" numeric(14, 2) NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"gross" numeric(14, 2),
	"fgts" numeric(14, 2),
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" varchar(8) DEFAULT 'manual' NOT NULL,
	"file_name" varchar(200),
	"notes" text,
	"bill_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "payroll_thirteenth_id" uuid;--> statement-breakpoint
ALTER TABLE "payroll_thirteenth" ADD CONSTRAINT "payroll_thirteenth_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_thirteenth" ADD CONSTRAINT "payroll_thirteenth_period_id_payroll_periods_id_fk" FOREIGN KEY ("period_id") REFERENCES "public"."payroll_periods"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_thirteenth" ADD CONSTRAINT "payroll_thirteenth_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_thirteenth" ADD CONSTRAINT "payroll_thirteenth_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_thirteenth_uq" ON "payroll_thirteenth" USING btree ("org_id","employee_id","year","installment");--> statement-breakpoint
CREATE INDEX "payroll_thirteenth_period_idx" ON "payroll_thirteenth" USING btree ("period_id");--> statement-breakpoint
CREATE INDEX "bills_payroll_thirteenth_idx" ON "bills" USING btree ("payroll_thirteenth_id") WHERE "bills"."payroll_thirteenth_id" is not null;