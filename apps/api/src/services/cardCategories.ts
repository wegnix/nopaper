import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { DEFAULT_CARD_CATEGORIES, classifySpending } from '@nopaper/shared';
import { db, schema, type DBOrTx } from '../db/client.js';
import { badRequest } from '../lib/errors.js';

export type CardCategoryRow = typeof schema.cardCategories.$inferSelect;

/** Cria as categorias padrão do cartão (espaço novo ou espaço antigo no 1º acesso). */
export async function seedCardCategories(tx: DBOrTx, orgId: string, userId: string | null) {
  return tx.insert(schema.cardCategories).values(DEFAULT_CARD_CATEGORIES.map((c) => ({
    orgId, label: c.label, color: c.color, ruleKey: c.key, createdBy: userId,
  }))).returning();
}

/** Categoria que recebe as compras de uma regra (ou a de "Diversos", se a da regra foi apagada). */
export function categoryForRule(cats: CardCategoryRow[], key: string): CardCategoryRow | null {
  return cats.find((c) => c.ruleKey === key) ?? cats.find((c) => c.ruleKey === 'other') ?? null;
}

/**
 * Garante as categorias do cartão do espaço e classifica lançamentos sem categoria (os que existiam
 * antes das categorias próprias do cartão) pelo nome da loja. Barato quando já está tudo certo.
 */
export async function ensureCardCategories(orgId: string, userId: string | null = null): Promise<CardCategoryRow[]> {
  const cats = await db.select().from(schema.cardCategories).where(eq(schema.cardCategories.orgId, orgId));
  const [pending] = await db.select({ id: schema.cardTransactions.id }).from(schema.cardTransactions)
    .where(and(eq(schema.cardTransactions.orgId, orgId), isNull(schema.cardTransactions.categoryId))).limit(1);
  if (cats.length && !pending) return cats;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`card-categories:${orgId}`}))`);
    let all = await tx.select().from(schema.cardCategories).where(eq(schema.cardCategories.orgId, orgId));
    if (!all.length) all = await seedCardCategories(tx, orgId, userId);
    const rows = await tx.select({ id: schema.cardTransactions.id, description: schema.cardTransactions.description }).from(schema.cardTransactions)
      .where(and(eq(schema.cardTransactions.orgId, orgId), isNull(schema.cardTransactions.categoryId)));
    if (rows.length) {
      // sem nenhuma categoria que sirva (usuário apagou todas): cria "Diversos"
      let fallback = categoryForRule(all, 'other') ?? all[0];
      if (!fallback) [fallback] = all = await tx.insert(schema.cardCategories).values({ orgId, label: 'Diversos', color: 'slate', ruleKey: 'other', createdBy: userId }).returning();
      const byCat = new Map<string, string[]>();
      for (const r of rows) {
        const c = categoryForRule(all, classifySpending(r.description)) ?? fallback;
        byCat.set(c.id, [...(byCat.get(c.id) ?? []), r.id]);
      }
      for (const [catId, ids] of byCat) {
        for (let k = 0; k < ids.length; k += 1000) await tx.update(schema.cardTransactions).set({ categoryId: catId }).where(inArray(schema.cardTransactions.id, ids.slice(k, k + 1000)));
      }
    }
    return all;
  });
}

/** Confere que as categorias são do cartão deste espaço. */
export async function assertCardCategories(orgId: string, ids: string[], conn: DBOrTx = db) {
  const uniq = [...new Set(ids)];
  if (!uniq.length) return;
  const found = await conn.select({ id: schema.cardCategories.id }).from(schema.cardCategories)
    .where(and(eq(schema.cardCategories.orgId, orgId), inArray(schema.cardCategories.id, uniq)));
  if (found.length !== uniq.length) throw badRequest('Categoria do cartão inválida. Recarregue a página e escolha de novo.');
}
