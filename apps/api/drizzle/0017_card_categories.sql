CREATE TABLE "card_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"label" varchar(64) NOT NULL,
	"color" varchar(16) DEFAULT 'slate' NOT NULL,
	"rule_key" varchar(24),
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "card_transactions" DROP CONSTRAINT "card_transactions_category_id_categories_id_fk";
--> statement-breakpoint
ALTER TABLE "card_categories" ADD CONSTRAINT "card_categories_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "card_categories_org_idx" ON "card_categories" USING btree ("org_id");--> statement-breakpoint
ALTER TABLE "card_transactions" DROP COLUMN "category_id";