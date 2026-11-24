CREATE TABLE "group_categories" (
	"group_id" uuid NOT NULL,
	"category_id" uuid NOT NULL,
	CONSTRAINT "group_categories_group_id_category_id_pk" PRIMARY KEY("group_id","category_id")
);
--> statement-breakpoint
ALTER TABLE "group_categories" ADD CONSTRAINT "group_categories_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "group_categories" ADD CONSTRAINT "group_categories_category_id_categories_id_fk" FOREIGN KEY ("category_id") REFERENCES "public"."categories"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_categories_category_idx" ON "group_categories" USING btree ("category_id");