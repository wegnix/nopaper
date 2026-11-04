CREATE TABLE "alert_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"channel" varchar(16) NOT NULL,
	"target" varchar(200) NOT NULL,
	"status" varchar(8) NOT NULL,
	"items" integer DEFAULT 0 NOT NULL,
	"test" boolean DEFAULT false NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"trigger" varchar(16) NOT NULL,
	"status" varchar(8) NOT NULL,
	"file_name" varchar(200),
	"size_bytes" bigint,
	"remote_status" varchar(8) DEFAULT 'none' NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "alert_deliveries" ADD CONSTRAINT "alert_deliveries_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_deliveries_org_idx" ON "alert_deliveries" USING btree ("org_id","created_at");