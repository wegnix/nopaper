CREATE TABLE "api_idempotency_keys" (
	"token_id" uuid NOT NULL,
	"key" varchar(120) NOT NULL,
	"request_hash" varchar(64) NOT NULL,
	"status" smallint,
	"response" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_idempotency_keys_token_id_key_pk" PRIMARY KEY("token_id","key")
);
--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "external_id" varchar(120);--> statement-breakpoint
ALTER TABLE "bills" ADD COLUMN "source" varchar(40);--> statement-breakpoint
ALTER TABLE "api_idempotency_keys" ADD CONSTRAINT "api_idempotency_keys_token_id_api_tokens_id_fk" FOREIGN KEY ("token_id") REFERENCES "public"."api_tokens"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "api_idem_created_idx" ON "api_idempotency_keys" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "bills_org_external_uq" ON "bills" USING btree ("org_id","external_id") WHERE "bills"."external_id" is not null;