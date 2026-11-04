CREATE TABLE "card_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"ref" varchar(7) NOT NULL,
	"closing_date" date NOT NULL,
	"due_date" date NOT NULL,
	"bill_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "card_transactions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"card_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"description" varchar(255) NOT NULL,
	"category_id" uuid NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"total_amount" numeric(14, 2) NOT NULL,
	"purchase_date" date NOT NULL,
	"installment_number" smallint DEFAULT 1 NOT NULL,
	"total_installments" smallint DEFAULT 1 NOT NULL,
	"notes" text,
	"import_batch_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(64) NOT NULL,
	"brand" varchar(16) DEFAULT 'other' NOT NULL,
	"last4" varchar(4),
	"color" varchar(16) DEFAULT 'indigo' NOT NULL,
	"limit_amount" numeric(14, 2),
	"closing_day" smallint NOT NULL,
	"due_day" smallint NOT NULL,
	"bill_category_id" uuid NOT NULL,
	"bill_folder_id" uuid,
	"holder" varchar(64),
	"active" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "card_statements" ADD CONSTRAINT "card_statements_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_statements" ADD CONSTRAINT "card_statements_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_statements" ADD CONSTRAINT "card_statements_bill_id_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."bills"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_card_id_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_statement_id_card_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."card_statements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "card_transactions" ADD CONSTRAINT "card_transactions_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_bill_category_id_categories_id_fk" FOREIGN KEY ("bill_category_id") REFERENCES "public"."categories"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_bill_folder_id_folders_id_fk" FOREIGN KEY ("bill_folder_id") REFERENCES "public"."folders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "card_statements_card_ref_uq" ON "card_statements" USING btree ("card_id","ref");--> statement-breakpoint
CREATE INDEX "card_tx_statement_idx" ON "card_transactions" USING btree ("statement_id");--> statement-breakpoint
CREATE INDEX "card_tx_group_idx" ON "card_transactions" USING btree ("group_id");--> statement-breakpoint
CREATE INDEX "card_tx_org_date_idx" ON "card_transactions" USING btree ("org_id","purchase_date");--> statement-breakpoint
CREATE INDEX "cards_org_idx" ON "cards" USING btree ("org_id");