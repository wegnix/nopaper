ALTER TABLE "payroll_entries" ADD COLUMN "payslip_net_declared" numeric(14, 2);--> statement-breakpoint
-- Rubricas novas do holerite nos espaços que já usam a folha (os novos recebem pelo padrão).
-- Cada uma entra logo depois da rubrica de referência (ou no fim do grupo), sem duplicar nome.
UPDATE "payroll_rubrics" SET "sort_order" = "sort_order" * 10;--> statement-breakpoint
INSERT INTO "payroll_rubrics" ("org_id", "name", "section", "kind", "fixed", "sort_order")
SELECT o."org_id", n."name", 'payslip', n."kind", false,
  coalesce(
    (SELECT max(a."sort_order") FROM "payroll_rubrics" a WHERE a."org_id" = o."org_id" AND lower(a."name") = lower(n."after")),
    (SELECT max(b."sort_order") FROM "payroll_rubrics" b WHERE b."org_id" = o."org_id" AND b."section" = 'payslip' AND b."kind" = n."kind"),
    0
  ) + n."pos"
FROM (SELECT DISTINCT "org_id" FROM "payroll_rubrics") o
CROSS JOIN (VALUES
  ('Diferença salarial', 'earning', 'Salário base', 5),
  ('Periculosidade', 'earning', 'Horas extras (holerite)', 5),
  ('Empréstimo consignado', 'deduction', 'Adiantamento', 5)
) AS n("name", "kind", "after", "pos")
WHERE NOT EXISTS (SELECT 1 FROM "payroll_rubrics" x WHERE x."org_id" = o."org_id" AND lower(x."name") = lower(n."name"));--> statement-breakpoint
UPDATE "payroll_rubrics" r SET "sort_order" = s."rn"
FROM (SELECT "id", (row_number() OVER (PARTITION BY "org_id" ORDER BY "sort_order", "name") - 1)::smallint AS "rn" FROM "payroll_rubrics") s
WHERE s."id" = r."id";
