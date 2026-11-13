CREATE TABLE "api_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" varchar(64) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"hint" varchar(12) NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"allowed_ips" text[] DEFAULT '{}'::text[] NOT NULL,
	"expires_at" date,
	"last_used_at" timestamp with time zone,
	"last_used_ip" varchar(64),
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_tokens" ADD CONSTRAINT "api_tokens_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "api_tokens_hash_uq" ON "api_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "api_tokens_org_idx" ON "api_tokens" USING btree ("org_id");