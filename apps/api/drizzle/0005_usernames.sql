ALTER TABLE "users" ADD COLUMN "username" varchar(32);--> statement-breakpoint
-- contas existentes: usuário = parte do e-mail antes do @ (sem símbolos); repetidos ganham sufixo numérico
WITH base AS (
  SELECT id, created_at,
    coalesce(nullif(left(regexp_replace(regexp_replace(lower(split_part(email, '@', 1)), '[^a-z0-9._-]+', '', 'g'), '^[._-]+', ''), 28), ''), 'usuario') AS b
  FROM "users"
), ranked AS (
  SELECT id, CASE WHEN length(b) < 3 THEN b || 'usr' ELSE b END AS b,
    row_number() OVER (PARTITION BY b ORDER BY created_at) AS n
  FROM base
)
UPDATE "users" u SET "username" = CASE WHEN r.n = 1 THEN r.b ELSE r.b || r.n::text END
FROM ranked r WHERE r.id = u.id;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "username" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_username_uq" ON "users" USING btree (lower("username"));
