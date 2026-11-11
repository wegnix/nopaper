ALTER TABLE "sessions" ADD COLUMN "rotation" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "rotation_acked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
-- A categoria das contas de salário (Folha → Configurar) passa a ser restrita: sem isso, quem vê
-- Contas a pagar via o salário de cada funcionário. Quem deve ver recebe "Ver categorias restritas".
UPDATE "categories" c SET "is_restricted" = true
FROM "org_settings" s
WHERE s."key" = 'payroll' AND c."org_id" = s."org_id" AND c."id"::text = s."value"->>'categoryId' AND c."is_restricted" = false;--> statement-breakpoint
-- As contas de salário não levam mais a divisão "pelo holerite / por fora" nas observações.
UPDATE "bills" SET "notes" = nullif(btrim(regexp_replace("notes", '\s*Pelo holerite:.*$', '')), '')
WHERE "payroll_entry_id" IS NOT NULL AND "notes" LIKE '%Pelo holerite:%';--> statement-breakpoint
-- Registros de auditoria das contas em categoria restrita ficam marcados (somem para quem não vê restritas).
UPDATE "audit_logs" a SET "details" = coalesce(a."details", '{}'::jsonb) || '{"restricted": true}'::jsonb
FROM "bills" b JOIN "categories" c ON c."id" = b."category_id"
WHERE a."entity_type" = 'bill' AND a."entity_id" = b."id"::text AND c."is_restricted"
  AND (a."details" IS NULL OR jsonb_typeof(a."details") = 'object')
  AND coalesce((a."details"->>'restricted')::boolean, false) = false;
