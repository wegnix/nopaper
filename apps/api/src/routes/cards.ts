import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  addMonthsRef, billPerm, cardCategorySchema, cardDescKeys, classifySpending, cardOfxImportSchema, cardOfxLines, cardSchema, cardTxSchema, cardTxUpdateSchema, cycleForPurchase, cycleForRef,
  MONTHS_PT_SHORT, decodeOfx, fromCents, matchExistingCardTx, OFX_MAX_TRANSACTIONS, parseOfx, toCents, todayISO,
} from '@nopaper/shared';
import { env } from '../env.js';
import { db, schema } from '../db/client.js';
import { parse } from '../lib/validate.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { assertCategoryUsable, assertFolder, attachmentsFor, deleteBillsWithFiles, restrictedCategoryIds, serialize } from '../services/bills.js';
import { assertCardCategories, categoryForRule, ensureCardCategories } from '../services/cardCategories.js';
import {
  loadCard, ensureStatement, createPurchase, deleteTransactions, limitUsed, statementStatus, statementsOf, syncStatementBill,
} from '../services/cards.js';
import { checkCardSpace } from '../services/spaceCheck.js';

const view = requirePerm('cards.view');
const refName = (ref: string) => `${MONTHS_PT_SHORT[Number(ref.slice(5, 7)) - 1]}/${ref.slice(0, 4)}`;
const edit = requirePerm('cards.edit');
const manage = requirePerm('cards.manage');

export default async function cardRoutes(app: FastifyInstance) {
  app.get('/api/cards', { preHandler: view }, async (req) => {
    const today = todayISO(req.org!.timezone);
    const rows = await db.select().from(schema.cards).where(eq(schema.cards.orgId, req.org!.id)).orderBy(asc(schema.cards.name));
    const items = [];
    for (const c of rows) {
      const cur = cycleForPurchase(today, c.closingDay, c.dueDay);
      const [st] = await db.select().from(schema.cardStatements).where(and(eq(schema.cardStatements.cardId, c.id), eq(schema.cardStatements.ref, cur.ref)));
      const [{ total }] = st
        ? await db.select({ total: sql<string>`coalesce(sum(${schema.cardTransactions.amount}),0)::text` }).from(schema.cardTransactions).where(eq(schema.cardTransactions.statementId, st.id))
        : [{ total: '0' }];
      items.push({ ...c, limitUsed: await limitUsed(c.id), currentRef: cur.ref, currentTotal: fromCents(toCents(total)), currentClosing: cur.closingDate, currentDue: cur.dueDate });
    }
    return { items };
  });

  app.post('/api/cards', { preHandler: manage }, async (req) => {
    const body = parse(cardSchema, req.body);
    await assertCategoryUsable(req, body.billCategoryId, 'payable');
    await assertFolder(req, body.billFolderId);
    const [c] = await db.insert(schema.cards).values({ ...body, orgId: req.org!.id, createdBy: req.user!.id }).returning();
    await audit(req, { action: 'card.create', entityType: 'card', entityId: c.id, description: `Cadastrou o cartão ${c.name}` });
    return c;
  });

  app.put<{ Params: { id: string } }>('/api/cards/:id', { preHandler: manage }, async (req) => {
    const body = parse(cardSchema, req.body);
    const c = await loadCard(req.org!.id, req.params.id);
    await assertCategoryUsable(req, body.billCategoryId, 'payable');
    await assertFolder(req, body.billFolderId);
    const [u] = await db.update(schema.cards).set(body).where(eq(schema.cards.id, c.id)).returning();
    // atualiza nome/categoria/pasta das contas das faturas ainda não pagas
    await db.transaction(async (tx) => {
      const sts = await tx.select({ id: schema.cardStatements.id }).from(schema.cardStatements).where(eq(schema.cardStatements.cardId, c.id));
      for (const s of sts) await syncStatementBill(tx, s.id, req.user!.id);
    });
    await audit(req, { action: 'card.update', entityType: 'card', entityId: c.id, details: body });
    return u;
  });

  /**
   * O que sai junto com o cartão: compras/parcelas, faturas e as contas a pagar dessas faturas.
   * Fatura já paga (com valor) bloqueia — é histórico financeiro: reverta o pagamento ou desative o cartão.
   */
  async function deletionImpact(cardId: string) {
    const [tx] = await db.select({ n: sql<number>`count(*)::int`, purchases: sql<number>`count(distinct ${schema.cardTransactions.groupId})::int` })
      .from(schema.cardTransactions).where(eq(schema.cardTransactions.cardId, cardId));
    const bills = await db.select({ id: schema.bills.id, status: schema.bills.status, amount: schema.bills.amount })
      .from(schema.cardStatements).innerJoin(schema.bills, eq(schema.bills.id, schema.cardStatements.billId))
      .where(eq(schema.cardStatements.cardId, cardId));
    const paid = bills.filter((b) => b.status === 'paid' && toCents(b.amount) > 0);
    const removable = bills.filter((b) => !paid.includes(b));
    const [{ files }] = removable.length
      ? await db.select({ files: sql<number>`count(*)::int` }).from(schema.attachments).where(inArray(schema.attachments.billId, removable.map((b) => b.id)))
      : [{ files: 0 }];
    return { transactions: tx.n, purchases: tx.purchases, paidStatements: paid.length, statementBills: removable.map((b) => b.id), attachments: files };
  }

  app.get<{ Params: { id: string } }>('/api/cards/:id/delete-impact', { preHandler: manage }, async (req) => {
    const c = await loadCard(req.org!.id, req.params.id);
    const i = await deletionImpact(c.id);
    return {
      transactions: i.transactions, purchases: i.purchases, paidStatements: i.paidStatements, statementBills: i.statementBills.length,
      attachments: i.attachments, canDeleteBills: req.org!.can(billPerm('payable', 'delete')),
    };
  });

  app.delete<{ Params: { id: string }; Querystring: { confirmName?: string } }>('/api/cards/:id', { preHandler: manage }, async (req) => {
    const c = await loadCard(req.org!.id, req.params.id);
    const i = await deletionImpact(c.id);
    if (i.paidStatements > 0) {
      throw conflict(`O cartão tem ${i.paidStatements} fatura(s) já paga(s). Para manter o histórico, desative o cartão em vez de apagar (ou reverta os pagamentos antes).`);
    }
    if (i.statementBills.length && !req.org!.can(billPerm('payable', 'delete'))) {
      throw forbidden('Apagar este cartão remove as contas a pagar das faturas dele, e você não tem permissão para apagar contas a pagar.');
    }
    // com lançamentos, exige o nome do cartão digitado (confirmação também no servidor)
    if (i.transactions > 0 && (req.query.confirmName ?? '').trim().toLowerCase() !== c.name.trim().toLowerCase()) {
      throw badRequest('Digite o nome do cartão para confirmar a exclusão', 'confirm_name');
    }
    await db.transaction(async (tx) => {
      await deleteBillsWithFiles(tx, i.statementBills);
      await tx.delete(schema.cards).where(eq(schema.cards.id, c.id)); // faturas e lançamentos saem em cascata
    });
    await audit(req, {
      action: 'card.delete', entityType: 'card', entityId: c.id,
      description: `Apagou o cartão ${c.name}${i.transactions ? ` (${i.purchases} compra(s), ${i.statementBills.length} fatura(s))` : ''}`,
      details: { transactions: i.transactions, purchases: i.purchases, statementBills: i.statementBills.length, attachments: i.attachments },
    });
    return { ok: true };
  });

  /** Fatura de um mês (ref = YYYY-MM do vencimento) com lançamentos. */
  app.get<{ Params: { id: string }; Querystring: { ref?: string } }>('/api/cards/:id/statement', { preHandler: view }, async (req) => {
    const c = await loadCard(req.org!.id, req.params.id);
    await ensureCardCategories(req.org!.id);
    const today = todayISO(req.org!.timezone);
    const ref = req.query.ref && /^\d{4}-\d{2}$/.test(req.query.ref) ? req.query.ref : cycleForPurchase(today, c.closingDay, c.dueDay).ref;
    const all = await statementsOf(c.id);
    let st = all.find((s) => s.ref === ref);
    if (!st) {
      // fatura virtual (ainda sem lançamentos)
      const cyc = cycleForRef(ref, c.closingDay, c.dueDay);
      return { card: c, ref, statement: { id: null, ...cyc, billId: null }, status: statementStatus(cyc, undefined, today), total: '0.00', bill: null, items: [], refs: all.map((s) => s.ref) };
    }
    const items = await db.select().from(schema.cardTransactions).where(eq(schema.cardTransactions.statementId, st.id))
      .orderBy(asc(schema.cardTransactions.purchaseDate), asc(schema.cardTransactions.createdAt));
    const bill = st.billId ? (await db.select().from(schema.bills).where(eq(schema.bills.id, st.billId)))[0] : undefined;
    const total = fromCents(items.reduce((a, t) => a + toCents(t.amount), 0));
    return {
      card: c, ref, statement: st, status: statementStatus(st, bill, today), total,
      // a conta da fatura é de Contas a pagar: só vai para quem pode vê-la lá (e a categoria, se restrita)
      bill: bill && req.org!.can('payable.view') && (req.org!.can('bills.view_restricted') || !(await restrictedCategoryIds(req.org!.id)).includes(bill.categoryId))
        ? serialize(bill, (await attachmentsFor([bill.id])).get(bill.id)) : null,
      items, refs: all.map((s) => s.ref),
    };
  });

  // ------------------------------------------------------------ categorias do cartão
  const sortPt = <T extends { label: string }>(rows: T[]) => rows.sort((a, b) => a.label.localeCompare(b.label, 'pt-BR', { sensitivity: 'base' }));
  const loadCardCategory = async (orgId: string, id: string) => {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Categoria não encontrada');
    const [c] = await db.select().from(schema.cardCategories).where(and(eq(schema.cardCategories.id, id), eq(schema.cardCategories.orgId, orgId)));
    if (!c) throw notFound('Categoria não encontrada');
    return c;
  };
  const assertUniqueLabel = async (orgId: string, label: string, exceptId?: string) => {
    const [dup] = await db.select({ id: schema.cardCategories.id, label: schema.cardCategories.label }).from(schema.cardCategories)
      .where(and(eq(schema.cardCategories.orgId, orgId), sql`lower(${schema.cardCategories.label}) = lower(${label})`, exceptId ? sql`${schema.cardCategories.id} <> ${exceptId}` : undefined));
    if (dup) throw badRequest(`Já existe a categoria "${dup.label}"`);
  };

  app.get('/api/card-categories', { preHandler: requirePerm('cards.view', 'reports.view') }, async (req) => {
    await ensureCardCategories(req.org!.id, req.user!.id);
    const rows = await db.select({
      id: schema.cardCategories.id, label: schema.cardCategories.label, color: schema.cardCategories.color, ruleKey: schema.cardCategories.ruleKey,
      usage: sql<number>`(select count(*)::int from card_transactions t where t.card_category_id = card_categories.id)`,
    }).from(schema.cardCategories).where(eq(schema.cardCategories.orgId, req.org!.id));
    return { items: sortPt(rows) };
  });

  app.post('/api/card-categories', { preHandler: manage }, async (req) => {
    const body = parse(cardCategorySchema, req.body);
    await ensureCardCategories(req.org!.id, req.user!.id);
    await assertUniqueLabel(req.org!.id, body.label);
    const [c] = await db.insert(schema.cardCategories).values({ ...body, orgId: req.org!.id, createdBy: req.user!.id }).returning();
    await audit(req, { action: 'card.category.create', entityType: 'card_category', entityId: c.id, description: `Criou a categoria de cartão ${c.label}`, details: body });
    return { ...c, usage: 0 };
  });

  app.put<{ Params: { id: string } }>('/api/card-categories/:id', { preHandler: manage }, async (req) => {
    const body = parse(cardCategorySchema, req.body);
    const c = await loadCardCategory(req.org!.id, req.params.id);
    await assertUniqueLabel(req.org!.id, body.label, c.id);
    const [u] = await db.update(schema.cardCategories).set(body).where(eq(schema.cardCategories.id, c.id)).returning();
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of ['label', 'color'] as const) if (c[k] !== u[k]) changes[k] = { from: c[k], to: u[k] };
    await audit(req, { action: 'card.category.update', entityType: 'card_category', entityId: c.id, description: `Editou a categoria de cartão ${u.label}`, details: { changes } });
    return u;
  });

  /** Apagar: sem compras, ou com `moveTo` (as compras vão para outra categoria antes). */
  app.delete<{ Params: { id: string }; Querystring: { moveTo?: string } }>('/api/card-categories/:id', { preHandler: manage }, async (req) => {
    const c = await loadCardCategory(req.org!.id, req.params.id);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.cardTransactions).where(eq(schema.cardTransactions.categoryId, c.id));
    let target: typeof c | null = null;
    if (n > 0) {
      if (!req.query.moveTo) throw badRequest(`A categoria tem ${n} compra(s). Escolha para qual categoria elas vão antes de apagar.`, 'category_in_use');
      target = await loadCardCategory(req.org!.id, req.query.moveTo);
      if (target.id === c.id) throw badRequest('Escolha outra categoria para receber as compras');
    }
    await db.transaction(async (tx) => {
      if (target) await tx.update(schema.cardTransactions).set({ categoryId: target.id }).where(eq(schema.cardTransactions.categoryId, c.id));
      // a regra automática passa para a categoria que recebeu as compras (se ela não tiver uma)
      if (target && c.ruleKey && !target.ruleKey) await tx.update(schema.cardCategories).set({ ruleKey: c.ruleKey }).where(eq(schema.cardCategories.id, target.id));
      await tx.delete(schema.cardCategories).where(eq(schema.cardCategories.id, c.id));
    });
    await audit(req, { action: 'card.category.delete', entityType: 'card_category', entityId: c.id, description: `Apagou a categoria de cartão ${c.label}${target ? ` (${n} compra(s) foram para ${target.label})` : ''}`, details: { moved: n, to: target?.label ?? null } });
    return { ok: true, moved: n };
  });

  // ------------------------------------------------------------ fatura em OFX
  /** Só lê o arquivo: lançamentos já tratados (descrição, parcela, sinal) + categoria sugerida pelo histórico. */
  app.post('/api/cards/ofx/read', { preHandler: edit }, async (req) => {
    const file = await req.file({ limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });
    if (!file) throw badRequest('Envie a fatura em OFX');
    const buf = await file.toBuffer();
    if (file.file.truncated) throw badRequest(`Arquivo maior que ${env.MAX_UPLOAD_MB} MB`);
    const ofx = parseOfx(decodeOfx(new Uint8Array(buf)));
    if (ofx.statements.reduce((n, st) => n + st.transactions.length, 0) > OFX_MAX_TRANSACTIONS) throw badRequest(`Este arquivo tem mais de ${OFX_MAX_TRANSACTIONS} lançamentos. Exporte um período menor.`);
    const cc = ofx.statements.filter((s) => s.kind === 'creditcard');
    if (!cc.length) {
      if (ofx.statements.length) throw badRequest('Este arquivo é um extrato de conta corrente, não uma fatura de cartão. Importe-o em Contas bancárias.', 'ofx_not_card');
      throw badRequest(`Não consegui ler este arquivo como fatura OFX. ${ofx.warnings.join(' ')} No app do banco, exporte a fatura do cartão no formato OFX.`, 'ofx_invalid');
    }
    const warnings = [...ofx.warnings];
    if (cc.length > 1) warnings.push(`O arquivo tem ${cc.length} cartões; os lançamentos de todos aparecem juntos.`);
    const lines = cc.flatMap((s) => cardOfxLines(s));
    // categoria usada da última vez na mesma loja (descrição ou estabelecimento antes do "*"); senão, a da regra pelo nome
    const cats = await ensureCardCategories(req.org!.id, req.user!.id);
    const hist = await db.select({ description: schema.cardTransactions.description, categoryId: schema.cardTransactions.categoryId })
      .from(schema.cardTransactions).where(eq(schema.cardTransactions.orgId, req.org!.id))
      .orderBy(desc(schema.cardTransactions.createdAt)).limit(3000);
    const known = new Map<string, string>();
    for (const h of hist) if (h.categoryId) for (const k of cardDescKeys(h.description)) if (!known.has(k)) known.set(k, h.categoryId);
    const s0 = cc[0];
    return {
      ...(await checkCardSpace(req, s0.accountId)),
      fileName: file.filename.slice(0, 200), bank: ofx.org, fid: ofx.fid, accountId: s0.accountId,
      balance: cc.length === 1 ? s0.balance : null, balanceDate: cc.length === 1 ? s0.balanceDate : null, warnings,
      lines: lines.map((l) => {
        const shop = cardDescKeys(l.description).map((k) => known.get(k)).find(Boolean);
        const rule = shop ? null : categoryForRule(cats, classifySpending(l.description));
        return { ...l, suggestedCategoryId: shop ?? rule?.id ?? null, suggestedFrom: shop ? 'shop' as const : rule ? 'rule' as const : null };
      }),
    };
  });

  /**
   * Importa os lançamentos marcados na fatura escolhida. Parcela n de N: a parcela entra nesta fatura e,
   * com `futureInstallments`, as seguintes vão para as próximas (a próxima importação as reconhece).
   * O que já está na fatura (mesmo valor/data/parcela) é pulado, também aqui no servidor.
   */
  app.post<{ Params: { id: string } }>('/api/cards/:id/ofx/import', { preHandler: edit }, async (req, reply) => {
    const body = parse(cardOfxImportSchema, req.body);
    const card = await loadCard(req.org!.id, req.params.id);
    if (!card.active) throw badRequest('O cartão está desativado. Ative-o na edição para importar a fatura.');
    await assertCardCategories(req.org!.id, body.items.map((i) => i.categoryId));
    const r = await db.transaction(async (tx) => {
      const st = await ensureStatement(tx, card, body.ref);
      if (st.billId) {
        const [b] = await tx.select({ status: schema.bills.status }).from(schema.bills).where(eq(schema.bills.id, st.billId));
        if (b?.status === 'paid') throw conflict('A fatura escolhida já está paga. Reverta o pagamento antes de importar, ou escolha outra fatura.');
      }
      const existing = await tx.select().from(schema.cardTransactions).where(eq(schema.cardTransactions.statementId, st.id));
      const lines = body.items.map((i) => ({ ...i, memo: '', kind: toCents(i.amount) > 0 ? 'purchase' as const : 'refund' as const }));
      const dup = matchExistingCardTx(lines, existing);
      const items = body.items.filter((i) => !dup.has(i.fitId));
      if (!items.length) return { batchId: null, created: 0, skipped: dup.size, total: '0.00' };
      // 1ª fatura importada: guarda a conta do arquivo, para reconhecer as próximas (e avisar se vierem para outro cartão/espaço)
      if (body.accountId && !card.ofxAccount) await tx.update(schema.cards).set({ ofxAccount: body.accountId }).where(eq(schema.cards.id, card.id));
      const batchId = randomUUID();
      const total = fromCents(items.reduce((a, i) => a + toCents(i.amount), 0));
      await tx.insert(schema.importBatches).values({ id: batchId, orgId: req.org!.id, type: 'card', fileName: body.fileName, rowCount: items.length, totalAmount: total, createdBy: req.user!.id });
      // parcelas futuras não podem cair em fatura já paga (mudaria o valor de uma conta paga)
      if (body.futureInstallments) {
        // teto do que uma importação pode criar em faturas futuras (uma fatura real fica muito abaixo)
        const future = items.reduce((n, i) => n + Math.max(0, (i.installments ?? 1) - (i.installment ?? 1)), 0);
        if (future > 3000) throw badRequest(`Esta importação criaria ${future} parcelas em faturas futuras. Importe em partes ou desligue "Lançar também as próximas parcelas".`);
        const span = Math.max(0, ...items.map((i) => (i.installments ?? 1) - (i.installment ?? 1)));
        if (span > 0) {
          const refs = Array.from({ length: span }, (_, k) => addMonthsRef(body.ref, k + 1));
          const paid = await tx.select({ ref: schema.cardStatements.ref }).from(schema.cardStatements)
            .innerJoin(schema.bills, eq(schema.bills.id, schema.cardStatements.billId))
            .where(and(eq(schema.cardStatements.cardId, card.id), inArray(schema.cardStatements.ref, refs), eq(schema.bills.status, 'paid')));
          if (paid.length) throw conflict(`As próximas parcelas cairiam em fatura já paga (${paid.map((p) => refName(p.ref)).sort().join(', ')}). Reverta o pagamento dela, ou desligue "Lançar também as próximas parcelas".`);
        }
      }
      const touched = new Set<string>([st.id]);
      const rows = [];
      for (const i of items) {
        const groupId = randomUUID();
        const n = i.installment ?? 1, of = i.installments ?? 1;
        const last = of > 1 && body.futureInstallments ? of : n;
        for (let k = n; k <= last; k++) {
          const target = k === n ? st : await ensureStatement(tx, card, addMonthsRef(body.ref, k - n));
          touched.add(target.id);
          rows.push({
            orgId: card.orgId, cardId: card.id, statementId: target.id, groupId, description: i.description, categoryId: i.categoryId,
            amount: i.amount, totalAmount: fromCents(toCents(i.amount) * of), purchaseDate: i.date, installmentNumber: k, totalInstallments: of,
            notes: i.notes, importBatchId: batchId, createdBy: req.user!.id,
          });
        }
      }
      for (let k = 0; k < rows.length; k += 500) await tx.insert(schema.cardTransactions).values(rows.slice(k, k + 500));
      for (const id of touched) await syncStatementBill(tx, id, req.user!.id, { lockPaid: true });
      return { batchId, created: items.length, skipped: dup.size, total, parcels: rows.length };
    });
    if (r.batchId) {
      await audit(req, {
        action: 'card.import', entityType: 'import', entityId: r.batchId,
        description: `Importou ${r.created} lançamento(s) da fatura "${body.fileName}" no ${card.name} (${body.ref})`,
        details: { card: card.name, ref: body.ref, created: r.created, skipped: r.skipped, total: r.total, futureInstallments: body.futureInstallments },
      });
    }
    reply.code(r.batchId ? 201 : 200);
    return r;
  });

  /** Importações de fatura ainda ativas deste cartão. */
  app.get<{ Params: { id: string } }>('/api/cards/:id/imports', { preHandler: view }, async (req) => {
    const card = await loadCard(req.org!.id, req.params.id);
    const rows = await db.select({
      b: schema.importBatches, userName: schema.users.name,
      parcels: sql<number>`count(${schema.cardTransactions.id})::int`,
      refs: sql<string[]>`array_agg(distinct ${schema.cardStatements.ref} order by ${schema.cardStatements.ref})`,
      paidRefs: sql<string[]>`coalesce(array_agg(distinct ${schema.cardStatements.ref}) filter (where ${schema.bills.status} = 'paid'), '{}')`,
    }).from(schema.importBatches)
      .innerJoin(schema.cardTransactions, eq(schema.cardTransactions.importBatchId, schema.importBatches.id))
      .innerJoin(schema.cardStatements, eq(schema.cardStatements.id, schema.cardTransactions.statementId))
      .leftJoin(schema.bills, eq(schema.bills.id, schema.cardStatements.billId))
      .leftJoin(schema.users, eq(schema.users.id, schema.importBatches.createdBy))
      .where(and(eq(schema.importBatches.orgId, req.org!.id), eq(schema.importBatches.type, 'card'), isNull(schema.importBatches.undoneAt), eq(schema.cardTransactions.cardId, card.id)))
      .groupBy(schema.importBatches.id, schema.users.name)
      .orderBy(desc(schema.importBatches.createdAt)).limit(30);
    return {
      items: rows.map((r) => ({
        id: r.b.id, fileName: r.b.fileName, rowCount: r.b.rowCount, totalAmount: r.b.totalAmount, createdAt: r.b.createdAt,
        createdBy: r.userName, parcels: r.parcels, refs: r.refs, paidRefs: [...r.paidRefs].sort(),
      })),
    };
  });

  /** Desfaz a importação: apaga os lançamentos (e parcelas futuras) que ela criou. Fatura paga bloqueia. */
  app.delete<{ Params: { id: string } }>('/api/cards/imports/:id', { preHandler: edit }, async (req) => {
    if (!/^[0-9a-f-]{36}$/i.test(req.params.id)) throw notFound('Importação não encontrada');
    const [b] = await db.select().from(schema.importBatches).where(and(eq(schema.importBatches.id, req.params.id), eq(schema.importBatches.orgId, req.org!.id), eq(schema.importBatches.type, 'card'), isNull(schema.importBatches.undoneAt)));
    if (!b) throw notFound('Importação não encontrada');
    const removed = await db.transaction(async (tx) => {
      const txs = await tx.select({ id: schema.cardTransactions.id, status: schema.bills.status, ref: schema.cardStatements.ref }).from(schema.cardTransactions)
        .innerJoin(schema.cardStatements, eq(schema.cardStatements.id, schema.cardTransactions.statementId))
        .leftJoin(schema.bills, eq(schema.bills.id, schema.cardStatements.billId))
        .where(and(eq(schema.cardTransactions.orgId, req.org!.id), eq(schema.cardTransactions.importBatchId, b.id)));
      const paidRefs = [...new Set(txs.filter((t) => t.status === 'paid').map((t) => t.ref))].sort();
      if (paidRefs.length) throw conflict(`Há lançamentos desta importação em fatura já paga (${paidRefs.map(refName).join(', ')}). Reverta o pagamento dessa fatura antes de desfazer.`);
      const n = await deleteTransactions(tx, txs.map((t) => t.id), req.user!.id);
      await tx.update(schema.importBatches).set({ undoneAt: new Date() }).where(eq(schema.importBatches.id, b.id));
      return n;
    });
    await audit(req, { action: 'card.import.undo', entityType: 'import', entityId: b.id, description: `Desfez a importação da fatura "${b.fileName}" (${removed} lançamento(s) removido(s))`, details: { removed } });
    return { removed };
  });

  // ------------------------------------------------------------ lançamentos
  app.post('/api/card-transactions', { preHandler: edit }, async (req) => {
    const body = parse(cardTxSchema, req.body);
    const card = await loadCard(req.org!.id, body.cardId);
    await assertCardCategories(req.org!.id, [body.categoryId]);
    const r = await db.transaction((tx) => createPurchase(tx, card, req.user!.id, body));
    await audit(req, { action: 'card.tx.create', entityType: 'card_tx', entityId: r.groupId, description: `Lançou "${body.description}" no ${card.name} (${body.installments}x)`, details: body });
    return r;
  });

  app.put<{ Params: { id: string } }>('/api/card-transactions/:id', { preHandler: edit }, async (req) => {
    const body = parse(cardTxUpdateSchema, req.body);
    const [t] = await db.select().from(schema.cardTransactions).where(and(eq(schema.cardTransactions.id, req.params.id), eq(schema.cardTransactions.orgId, req.org!.id)));
    if (!t) throw notFound('Lançamento não encontrado');
    if (body.categoryId) await assertCardCategories(req.org!.id, [body.categoryId]);
    const card = await loadCard(req.org!.id, t.cardId);
    const structural = (body.amount !== undefined && body.amount !== t.totalAmount) || (body.purchaseDate !== undefined && body.purchaseDate !== t.purchaseDate) || (body.installments !== undefined && body.installments !== t.totalInstallments);
    await db.transaction(async (tx) => {
      if (structural) {
        // recria a compra inteira mantendo o group id
        const group = await tx.select().from(schema.cardTransactions).where(eq(schema.cardTransactions.groupId, t.groupId)).orderBy(asc(schema.cardTransactions.installmentNumber));
        const firstSt = (await tx.select().from(schema.cardStatements).where(eq(schema.cardStatements.id, group[0].statementId)))[0];
        await deleteTransactions(tx, group.map((g) => g.id), req.user!.id);
        await createPurchase(tx, card, req.user!.id, {
          description: body.description ?? t.description, categoryId: body.categoryId ?? t.categoryId ?? '',
          amount: body.amount ?? t.totalAmount, purchaseDate: body.purchaseDate ?? t.purchaseDate,
          installments: body.installments ?? t.totalInstallments, notes: body.notes ?? t.notes,
          firstRef: body.purchaseDate && body.purchaseDate !== t.purchaseDate && group[0].installmentNumber === 1 ? null : firstSt.ref,
          // importada a partir da parcela n: mantém a numeração (n..N) a partir da mesma fatura
          startInstallment: Math.min(group[0].installmentNumber, body.installments ?? t.totalInstallments),
        }, t.groupId);
      } else {
        const patch = { description: body.description, categoryId: body.categoryId, notes: body.notes };
        const where = body.scope === 'group' ? eq(schema.cardTransactions.groupId, t.groupId) : eq(schema.cardTransactions.id, t.id);
        await tx.update(schema.cardTransactions).set(patch).where(where);
      }
      if (body.categoryId && body.applyToShop) {
        const key = cardDescKeys(body.description ?? t.description)[0];
        const same = (await tx.select({ id: schema.cardTransactions.id, description: schema.cardTransactions.description }).from(schema.cardTransactions)
          .where(eq(schema.cardTransactions.orgId, req.org!.id))).filter((r) => cardDescKeys(r.description)[0] === key).map((r) => r.id);
        for (let k = 0; k < same.length; k += 1000) await tx.update(schema.cardTransactions).set({ categoryId: body.categoryId }).where(inArray(schema.cardTransactions.id, same.slice(k, k + 1000)));
      }
    });
    await audit(req, { action: 'card.tx.update', entityType: 'card_tx', entityId: t.groupId, description: `Editou "${t.description}"`, details: body });
    return { ok: true };
  });

  app.delete<{ Params: { id: string }; Querystring: { scope?: string } }>('/api/card-transactions/:id', { preHandler: edit }, async (req) => {
    const scope = parse(z.enum(['one', 'group', 'forward']), req.query.scope ?? 'group');
    const [t] = await db.select().from(schema.cardTransactions).where(and(eq(schema.cardTransactions.id, req.params.id), eq(schema.cardTransactions.orgId, req.org!.id)));
    if (!t) throw notFound('Lançamento não encontrado');
    const n = await db.transaction(async (tx) => {
      const group = await tx.select().from(schema.cardTransactions).where(eq(schema.cardTransactions.groupId, t.groupId));
      const ids = scope === 'one' ? [t.id] : scope === 'forward' ? group.filter((g) => g.installmentNumber >= t.installmentNumber).map((g) => g.id) : group.map((g) => g.id);
      return deleteTransactions(tx, ids, req.user!.id);
    });
    await audit(req, { action: 'card.tx.delete', entityType: 'card_tx', entityId: t.groupId, description: `Apagou "${t.description}" (${n} parcela(s))` });
    return { deleted: n };
  });

  /** Move um lançamento para outra fatura (ex.: compra que o banco jogou para o mês seguinte). */
  app.post<{ Params: { id: string } }>('/api/card-transactions/:id/move', { preHandler: edit }, async (req) => {
    const { ref } = parse(z.object({ ref: z.string().regex(/^\d{4}-\d{2}$/) }), req.body);
    const [t] = await db.select().from(schema.cardTransactions).where(and(eq(schema.cardTransactions.id, req.params.id), eq(schema.cardTransactions.orgId, req.org!.id)));
    if (!t) throw notFound('Lançamento não encontrado');
    const card = await loadCard(req.org!.id, t.cardId);
    await db.transaction(async (tx) => {
      const st = await ensureStatement(tx, card, ref);
      await tx.update(schema.cardTransactions).set({ statementId: st.id }).where(eq(schema.cardTransactions.id, t.id));
      await syncStatementBill(tx, t.statementId, req.user!.id, { lockPaid: true });
      await syncStatementBill(tx, st.id, req.user!.id, { lockPaid: true });
    });
    await audit(req, { action: 'card.tx.move', entityType: 'card_tx', entityId: t.groupId, description: `Moveu "${t.description}" para a fatura de ${ref} do ${card.name}` });
    return { ok: true };
  });
}
