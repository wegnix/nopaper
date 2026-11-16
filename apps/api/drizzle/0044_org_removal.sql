ALTER TABLE "organizations" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "archived_by" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "deletion_requested_by" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "deletion_requested_by_name" varchar(120);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "deletion_by_platform" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "deletion_due_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "deletion_reminder_at" timestamp with time zone;