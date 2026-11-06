-- Custos da empresa calculados pela legislação: o FGTS passa a ser 8% do bruto do holerite,
-- calculado sozinho. A rubrica manual "FGTS" sai (os valores lançados nela eram esse mesmo 8%;
-- o custo dos lançamentos é recalculado no 1º acesso à folha) e entram rubricas de benefícios.
DELETE FROM "payroll_entry_lines" l USING "payroll_rubrics" r
WHERE l."rubric_id" = r."id" AND r."section" = 'employer' AND lower(r."name") = 'fgts';--> statement-breakpoint
DELETE FROM "payroll_rubrics" WHERE "section" = 'employer' AND lower("name") = 'fgts';--> statement-breakpoint
INSERT INTO "payroll_rubrics" ("org_id", "name", "section", "kind", "fixed", "sort_order")
SELECT o."org_id", n."name", 'employer', 'earning', true, o."mx" + n."pos"
FROM (SELECT "org_id", max("sort_order") AS "mx" FROM "payroll_rubrics" GROUP BY "org_id") o
CROSS JOIN (VALUES ('Vale-alimentação', 1), ('Vale-transporte (parte da empresa)', 2)) AS n("name", "pos")
WHERE NOT EXISTS (SELECT 1 FROM "payroll_rubrics" x WHERE x."org_id" = o."org_id" AND lower(x."name") = lower(n."name"));
