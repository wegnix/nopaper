CREATE TABLE "employee_vacation_adjusts" (
	"org_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"absences" smallint DEFAULT 0 NOT NULL,
	"forfeited" boolean DEFAULT false NOT NULL,
	CONSTRAINT "employee_vacation_adjusts_employee_id_period_start_pk" PRIMARY KEY("employee_id","period_start")
);
--> statement-breakpoint
CREATE TABLE "employee_vacations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"employee_id" uuid NOT NULL,
	"period_start" date NOT NULL,
	"start_date" date,
	"days" smallint DEFAULT 0 NOT NULL,
	"sold_days" smallint DEFAULT 0 NOT NULL,
	"notes" text,
	"source" varchar(12) DEFAULT 'manual' NOT NULL,
	"needs_review" boolean DEFAULT false NOT NULL,
	"signature_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "employees" ADD COLUMN "vacation_from" date;--> statement-breakpoint
ALTER TABLE "employee_vacation_adjusts" ADD CONSTRAINT "employee_vacation_adjusts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_vacation_adjusts" ADD CONSTRAINT "employee_vacation_adjusts_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_vacations" ADD CONSTRAINT "employee_vacations_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employee_vacations" ADD CONSTRAINT "employee_vacations_employee_id_employees_id_fk" FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "employee_vacations_emp_idx" ON "employee_vacations" USING btree ("employee_id","period_start");