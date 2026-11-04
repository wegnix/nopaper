ALTER TABLE "sessions" ADD COLUMN "prev_refresh_hash" varchar(128);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "rotated_at" timestamp with time zone;