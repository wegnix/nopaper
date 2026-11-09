CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(80) NOT NULL,
	"bank_code" varchar(8),
	"branch" varchar(20),
	"account_number" varchar(30),
	"match_key" varchar(80),
	"kind" varchar(16) DEFAULT 'checking' NOT NULL,
	"color" varchar(16) DEFAULT 'sky' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"notes" text,
	"balance" numeric(14, 2),
	"balance_date" date,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_imports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"file_name" varchar(200) NOT NULL,
	"date_from" date,
	"date_to" date,
	"balance" numeric(14, 2),
	"balance_date" date,
	"tx_count" integer DEFAULT 0 NOT NULL,
	"new_count" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bank_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"import_id" uuid,
	"fit_id" varchar(120) NOT NULL,
	"posted_at" date NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"trn_type" varchar(16),
	"memo" varchar(255),
	"name" varchar(255),
	"ref_num" varchar(64),
	"check_num" varchar(64),
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"action" varchar(16),
	"bill_id" uuid,
	"reconciled_by" uuid,
	"reconciled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_imports" ADD CONSTRAINT "bank_imports_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_imports" ADD CONSTRAINT "bank_imports_account_id_bank_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_account_id_bank_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_import_id_bank_imports_id_fk" FOREIGN KEY ("import_id") REFERENCES "public"."bank_imports"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_transactions" ADD CONSTRAINT "bank_transactions_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_org_key_uq" ON "bank_accounts" USING btree ("org_id","match_key") WHERE "bank_accounts"."match_key" is not null;--> statement-breakpoint
CREATE INDEX "bank_imports_account_idx" ON "bank_imports" USING btree ("account_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_tx_account_fit_uq" ON "bank_transactions" USING btree ("account_id","fit_id");--> statement-breakpoint
CREATE INDEX "bank_tx_account_date_idx" ON "bank_transactions" USING btree ("account_id","posted_at");--> statement-breakpoint
CREATE INDEX "bank_tx_bill_idx" ON "bank_transactions" USING btree ("bill_id");