ALTER TABLE "users" ADD COLUMN "can_create_orgs" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_org_id_idx" ON "audit_logs" USING btree ("org_id","id");--> statement-breakpoint
-- Permissões v2: "editar" virou cadastrar / editar / dar baixa / apagar. Grupos que podiam
-- editar ganham todas as novas, para ninguém perder acesso na atualização.
UPDATE "groups" SET "permissions" = array(SELECT DISTINCT unnest("permissions" || ARRAY['payable.create','payable.pay','payable.delete']::text[]) ORDER BY 1)
  WHERE 'payable.edit' = ANY("permissions");--> statement-breakpoint
UPDATE "groups" SET "permissions" = array(SELECT DISTINCT unnest("permissions" || ARRAY['receivable.create','receivable.pay','receivable.delete']::text[]) ORDER BY 1)
  WHERE 'receivable.edit' = ANY("permissions");--> statement-breakpoint
UPDATE "groups" SET "permissions" = array(SELECT DISTINCT unnest("permissions" || ARRAY['cards.manage']::text[]) ORDER BY 1)
  WHERE 'cards.edit' = ANY("permissions");--> statement-breakpoint
-- Quem já é dono de algum espaço continua podendo criar espaços (antes qualquer conta podia).
UPDATE "users" SET "can_create_orgs" = true
  WHERE "is_superadmin" OR "id" IN (SELECT "user_id" FROM "memberships" WHERE "is_owner");
