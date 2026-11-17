CREATE TABLE "manuals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" varchar(120) NOT NULL,
	"description" varchar(300),
	"audiences" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"original_name" varchar(255) NOT NULL,
	"size" integer NOT NULL,
	"storage_key" varchar(255) NOT NULL,
	"sha256" varchar(64) NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
