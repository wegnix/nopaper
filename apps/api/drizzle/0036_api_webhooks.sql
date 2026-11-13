ALTER TABLE "api_tokens" ADD COLUMN "webhook_url" varchar(500);--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "webhook_secret" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "webhook_groups" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "webhook_cursor" bigint;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "webhook_status" varchar(16);--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "webhook_error" text;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "webhook_last_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "webhook_fail_since" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "webhook_next_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_tokens" ADD COLUMN "webhook_attempts" integer DEFAULT 0 NOT NULL;