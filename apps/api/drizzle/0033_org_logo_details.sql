ALTER TABLE "organizations" ADD COLUMN "state_registration" varchar(32);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "city_registration" varchar(32);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "phone" varchar(32);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "whatsapp" varchar(32);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "email" varchar(160);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "website" varchar(160);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "zip_code" varchar(12);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "street" varchar(160);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "street_number" varchar(20);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "complement" varchar(80);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "district" varchar(80);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "city" varchar(80);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "state" varchar(2);--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "logo" text;