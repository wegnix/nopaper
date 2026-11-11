import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, between, desc, eq, inArray, isNotNull, ne, or, sql } from 'drizzle-orm';
import {
  BANK_ACCOUNT_KIND_LABEL, MATCH_WINDOW, accountKey, bankAccountSchema, bankImportSchema, bankName, billPerm, decodeOfx, formatBRL, formatDateBR, normBank,
  OFX_MAX_TRANSACTIONS, parseOfx, reconcileSchema, type BillType,
} from '@nopaper/shared';
import { db, schema, type DBOrTx } from '../db/client.js';
import { env } from '../env.js';
import { parse } from '../lib/validate.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { assertCategoryUsable, assertFolder, createBills, deleteBillsWithFiles, loadBill, restrictedCategoryIds, serialize } from '../services/bills.js';

const view = { preHandler: requirePerm('bank.view') };
const imp = { preHandler: requirePerm('bank.import') };
const manage = { preHandler: requirePerm('bank.manage') };

const isUniqueViolation = (err: unknown) => {
  const e = err as { code?: string; cause?: { code?: string } };
  return e.code === '23505' || e.cause?.code === '23505';
};
const addDays = (d: string, n: number) => new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10) + n)).toISOString().slice(0, 10);
const isoOk = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v);
const typeOf = (amount: string): BillType => (amount.startsWith('-') ? 'payable' : 'receivable');
const abs = (amount: string) => amount.replace('-', '');

async function loadAccount(req: FastifyRequest, id: string, conn: DBOrTx = db) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Conta bancária não encontrada');
  const [a] = await conn.select().from(schema.bankAccounts).where(and(eq(schema.bankAccounts.id, id), eq(schema.bankAccounts.orgId, req.org!.id)));
  if (!a) throw notFound('Conta bancária não encontrada');
  return a;
}

/** Saldo da conta = o do extrato importado com a data de saldo mais recente. */
async function refreshBalance(conn: DBOrTx, accountId: string) {
  const [last] = await conn.select({ balance: schema.bankImports.balance, balanceDate: schema.bankImports.balanceDate }).from(schema.bankImports)
    .where(and(eq(schema.bankImports.accountId, accountId), isNotNull(schema.bankImports.balanceDate)))
    .orderBy(desc(schema.bankImports.balanceDate), desc(schema.bankImports.createdAt)).limit(1);
  await conn.update(schema.bankAccounts).set({ balance: last?.balance ?? null, balanceDate: last?.balanceDate ?? null }).where(eq(schema.bankAccounts.id, accountId));
}

export default async function bankRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------ contas bancárias
  app.get('/api/bank/accounts', view, async (req) => {
    const rows = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.orgId, req.org!.id)).orderBy(asc(schema.bankAccounts.name));
    const stats = await db.select({
      accountId: schema.bankTransactions.accountId,
      pending: sql<number>`count(*) filter (where ${schema.bankTransactions.status} = 'pending')::int`,
      total: sql<number>`count(*)::int`,
      last: sql<string | null>`max(${schema.bankTransactions.postedAt})::text`,
    }).from(schema.bankTransactions).where(eq(schema.bankTransactions.orgId, req.org!.id)).groupBy(schema.bankTransactions.accountId);
    const st = new Map(stats.map((s) => [s.accountId, s]));
    return { items: rows.map((a) => ({ ...a, pending: st.get(a.id)?.pending ?? 0, transactions: st.get(a.id)?.total ?? 0, lastDate: st.get(a.id)?.last ?? null })) };
  });

  const saveAccount = async (req: FastifyRequest, id?: string) => {
    const body = parse(bankAccountSchema, req.body);
    const matchKey = body.accountNumber ? accountKey(body.bankCode, body.branch, body.accountNumber) : null;
    try {
      if (id) {
        const a = await loadAccount(req, id);
        const [u] = await db.update(schema.bankAccounts).set({ ...body, matchKey }).where(eq(schema.bankAccounts.id, a.id)).returning();
        const changes: Record<string, { from: unknown; to: unknown }> = {};
        for (const k of Object.keys(body) as (keyof typeof body)[]) if (JSON.stringify(a[k] ?? null) !== JSON.stringify(u[k] ?? null)) changes[k] = { from: a[k] ?? null, to: u[k] ?? null };
        await audit(req, { action: 'bank.account.update', entityType: 'bank_account', entityId: a.id, description: `Editou a conta bancária ${u.name}`, details: { changes } });
        return u;
      }
      const [a] = await db.insert(schema.bankAccounts).values({ ...body, matchKey, orgId: req.org!.id, createdBy: req.user!.id }).returning();
      await audit(req, { action: 'bank.account.create', entityType: 'bank_account', entityId: a.id, description: `Cadastrou a conta bancária ${a.name}` });
      return a;
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('Já existe uma conta com esse banco, agência e número.');
      throw err;
    }
  };
  app.post('/api/bank/accounts', manage, (req) => saveAccount(req));
  app.put<{ Params: { id: string } }>('/api/bank/accounts/:id', manage, (req) => saveAccount(req, req.params.id));

  app.delete<{ Params: { id: string } }>('/api/bank/accounts/:id', manage, async (req) => {
    const a = await loadAccount(req, req.params.id);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.bankTransactions).where(and(eq(schema.bankTransactions.accountId, a.id), eq(schema.bankTransactions.status, 'linked')));
    if (n > 0) throw conflict(`${a.name} tem ${n} lançamento(s) conciliado(s) com contas. Para manter o histórico, desative a conta (ou desfaça as conciliações antes).`);
    await db.delete(schema.bankAccounts).where(eq(schema.bankAccounts.id, a.id));
    await audit(req, { action: 'bank.account.delete', entityType: 'bank_account', entityId: a.id, description: `Apagou a conta bancária ${a.name} e os extratos dela` });
    return { ok: true };
  });

  // ------------------------------------------------------------ importar extrato
  /** Lê o OFX: extratos do arquivo, a conta reconhecida e quantos lançamentos já estão no NoPaper. */
  app.post('/api/bank/read', imp, async (req) => {
    const file = await req.file({ limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });
    if (!file) throw badRequest('Envie o extrato em OFX');
    const buf = await file.toBuffer();
    if (file.file.truncated) throw badRequest(`Arquivo maior que ${env.MAX_UPLOAD_MB} MB`);
    const ofx = parseOfx(decodeOfx(new Uint8Array(buf)));
    if (ofx.statements.reduce((n, st) => n + st.transactions.length, 0) > OFX_MAX_TRANSACTIONS) throw badRequest(`Este arquivo tem mais de ${OFX_MAX_TRANSACTIONS} lançamentos. Exporte um período menor.`);
    if (!ofx.statements.length) throw badRequest(`Não consegui ler este arquivo como extrato OFX. ${ofx.warnings.join(' ')} No banco, exporte o extrato no formato OFX.`, 'ofx_invalid');
    const accounts = await db.select().from(schema.bankAccounts).where(eq(schema.bankAccounts.orgId, req.org!.id));
    const statements = [];
    for (const s of ofx.statements) {
      const key = accountKey(s.bankId, s.branchId, s.accountId);
      const account = accounts.find((a) => a.matchKey === key) ?? null;
      let duplicates = 0;
      if (account && s.transactions.length) {
        const ids = s.transactions.map((t) => t.fitId);
        const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.bankTransactions)
          .where(and(eq(schema.bankTransactions.accountId, account.id), inArray(schema.bankTransactions.fitId, ids)));
        duplicates = n;
      }
      const kind = s.accountType === 'SAVINGS' ? 'savings' : s.kind === 'creditcard' ? 'other' : 'checking';
      statements.push({
        ...s, account: account && { id: account.id, name: account.name, active: account.active }, duplicates,
        suggested: { name: `${bankName(s.bankId)} ${s.kind === 'creditcard' ? 'cartão' : BANK_ACCOUNT_KIND_LABEL[kind].toLowerCase()}`.slice(0, 80), bankCode: normBank(s.bankId), branch: s.branchId, accountNumber: s.accountId, kind },
      });
    }
    return { fileName: file.filename.slice(0, 200), org: ofx.org, statements, warnings: ofx.warnings };
  });

  app.post('/api/bank/import', imp, async (req) => {
    const body = parse(bankImportSchema, req.body);
    const orgId = req.org!.id;
    const s = body.statement;
    const out = await db.transaction(async (tx) => {
      let account;
      if (body.accountId) account = await loadAccount(req, body.accountId, tx);
      else {
        if (!body.newAccount) throw badRequest('Escolha a conta bancária do extrato ou cadastre uma nova');
        if (!req.org!.can('bank.manage')) throw forbidden('Cadastrar a conta bancária do extrato exige a permissão de cadastrar contas bancárias. Peça para quem administra criar a conta antes.');
        const na = body.newAccount;
        const matchKey = na.accountNumber ? accountKey(na.bankCode, na.branch, na.accountNumber) : null;
        try {
          [account] = await tx.insert(schema.bankAccounts).values({ ...na, matchKey, orgId, createdBy: req.user!.id }).returning();
        } catch (err) {
          if (isUniqueViolation(err)) throw conflict('Essa conta bancária já está cadastrada: escolha-a na lista.');
          throw err;
        }
        await audit(req, { action: 'bank.account.create', entityType: 'bank_account', entityId: account.id, description: `Cadastrou a conta bancária ${account.name} (importação de extrato)` });
      }
      const [im] = await tx.insert(schema.bankImports).values({
        orgId, accountId: account.id, fileName: body.fileName, dateFrom: s.from, dateTo: s.to, balance: s.balance, balanceDate: s.balanceDate,
        txCount: s.transactions.length, createdBy: req.user!.id,
      }).returning();
      let inserted = 0;
      for (let i = 0; i < s.transactions.length; i += 500) {
        const chunk = s.transactions.slice(i, i + 500);
        const r = await tx.insert(schema.bankTransactions).values(chunk.map((t) => ({
          orgId, accountId: account.id, importId: im.id, fitId: t.fitId, postedAt: t.date, amount: t.amount, trnType: t.type,
          memo: t.memo?.slice(0, 255) ?? null, name: t.name?.slice(0, 255) ?? null, refNum: t.refNum?.slice(0, 64) ?? null, checkNum: t.checkNum?.slice(0, 64) ?? null,
        }))).onConflictDoNothing({ target: [schema.bankTransactions.accountId, schema.bankTransactions.fitId] }).returning({ id: schema.bankTransactions.id });
        inserted += r.length;
      }
      await tx.update(schema.bankImports).set({ newCount: inserted }).where(eq(schema.bankImports.id, im.id));
      await refreshBalance(tx, account.id);
      return { importId: im.id, accountId: account.id, accountName: account.name, inserted, duplicates: s.transactions.length - inserted, from: s.from, to: s.to };
    });
    await audit(req, { action: 'bank.import', entityType: 'bank_import', entityId: out.importId, description: `Importou o extrato "${body.fileName}" em ${out.accountName} (${out.inserted} lançamento(s) novos, ${out.duplicates} já importados)`, details: out });
    return out;
  });

  app.get<{ Querystring: { accountId?: string } }>('/api/bank/imports', view, async (req) => {
    const rows = await db.select({
      id: schema.bankImports.id, accountId: schema.bankImports.accountId, fileName: schema.bankImports.fileName, from: schema.bankImports.dateFrom, to: schema.bankImports.dateTo,
      txCount: schema.bankImports.txCount, newCount: schema.bankImports.newCount, createdAt: schema.bankImports.createdAt, createdByName: schema.users.name,
      linked: sql<number>`(select count(*)::int from bank_transactions t where t.import_id = ${schema.bankImports.id} and t.status = 'linked')`,
    }).from(schema.bankImports).leftJoin(schema.users, eq(schema.users.id, schema.bankImports.createdBy))
      .where(and(eq(schema.bankImports.orgId, req.org!.id), req.query.accountId ? eq(schema.bankImports.accountId, req.query.accountId) : undefined))
      .orderBy(desc(schema.bankImports.createdAt)).limit(100);
    return { items: rows };
  });

  /** Desfaz uma importação: apaga os lançamentos novos que ela trouxe (se nenhum estiver conciliado). */
  app.delete<{ Params: { id: string } }>('/api/bank/imports/:id', imp, async (req) => {
    const [im] = await db.select().from(schema.bankImports).where(and(eq(schema.bankImports.id, req.params.id), eq(schema.bankImports.orgId, req.org!.id)));
    if (!im) throw notFound('Importação não encontrada');
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.bankTransactions).where(and(eq(schema.bankTransactions.importId, im.id), eq(schema.bankTransactions.status, 'linked')));
    if (n) throw conflict(`${n} lançamento(s) desta importação estão ligados a contas. Desfaça essas conciliações antes de desfazer a importação.`);
    const removed = await db.transaction(async (tx) => {
      const r = await tx.delete(schema.bankTransactions).where(eq(schema.bankTransactions.importId, im.id)).returning({ id: schema.bankTransactions.id });
      await tx.delete(schema.bankImports).where(eq(schema.bankImports.id, im.id));
      await refreshBalance(tx, im.accountId);
      return r.length;
    });
    await audit(req, { action: 'bank.import_undo', entityType: 'bank_import', entityId: im.id, description: `Desfez a importação do extrato "${im.fileName}" (${removed} lançamento(s))`, details: { removed } });
    return { ok: true, removed };
  });

  // ------------------------------------------------------------ conciliação
  /**
   * Lançamentos do período e as contas candidatas (a pagar para saídas, a receber para entradas):
   * pendentes vencendo perto do período e pagas perto dele, que ainda não estão ligadas a outro lançamento.
   */
  app.get<{ Params: { id: string }; Querystring: { from?: string; to?: string } }>('/api/bank/accounts/:id/reconcile', view, async (req) => {
    const a = await loadAccount(req, req.params.id);
    const { from, to } = req.query;
    if (!isoOk(from) || !isoOk(to) || from > to) throw badRequest('Período inválido');
    const txs = await db.select().from(schema.bankTransactions)
      .where(and(eq(schema.bankTransactions.accountId, a.id), between(schema.bankTransactions.postedAt, from, to)))
      .orderBy(desc(schema.bankTransactions.postedAt), desc(schema.bankTransactions.amount));
    const types = (['payable', 'receivable'] as const).filter((t) => req.org!.can(billPerm(t, 'view')));
    const hidden = req.org!.can('bills.view_restricted') ? [] : await restrictedCategoryIds(req.org!.id);
    const linkedBills = txs.map((t) => t.billId).filter((x): x is string => !!x);
    const bills = types.length ? await db.select().from(schema.bills).where(and(
      eq(schema.bills.orgId, req.org!.id), inArray(schema.bills.type, types),
      or(
        and(eq(schema.bills.status, 'pending'), between(schema.bills.dueDate, addDays(from, -MATCH_WINDOW.pendingDays), addDays(to, MATCH_WINDOW.pendingDays))),
        and(eq(schema.bills.status, 'paid'), between(schema.bills.paidAt, addDays(from, -MATCH_WINDOW.paidDays), addDays(to, MATCH_WINDOW.paidDays))),
        linkedBills.length ? inArray(schema.bills.id, linkedBills) : undefined,
      ),
    )).limit(5000) : [];
    const visible = bills.filter((b) => !hidden.includes(b.categoryId));
    // contas já ligadas a algum lançamento (de qualquer conta bancária) não entram como candidatas
    const ids = visible.map((b) => b.id);
    const used = ids.length ? await db.select({ billId: schema.bankTransactions.billId, txId: schema.bankTransactions.id }).from(schema.bankTransactions)
      .where(and(inArray(schema.bankTransactions.billId, ids), eq(schema.bankTransactions.status, 'linked'))) : [];
    const usedBy = new Map(used.map((u) => [u.billId!, u.txId]));
    const byId = new Map(visible.map((b) => [b.id, b]));
    return {
      account: a,
      transactions: txs.map((t) => {
        const b = t.billId ? byId.get(t.billId) : undefined;
        // ligado a uma conta que a pessoa não vê (restrita/sem permissão): mostra só que está conciliado
        return { ...t, bill: b ? serialize(b) : null, hiddenBill: !!t.billId && !b };
      }),
      candidates: visible.filter((b) => !usedBy.has(b.id)).map((b) => serialize(b)),
    };
  });

  app.post<{ Params: { id: string } }>('/api/bank/accounts/:id/reconcile', imp, async (req) => {
    const a = await loadAccount(req, req.params.id);
    const body = parse(reconcileSchema, req.body);
    const orgId = req.org!.id;
    const done = { linked: 0, paid: 0, created: 0, ignored: 0 };
    const log: string[] = [];
    /** Categorias das contas tocadas: se alguma é restrita, o registro da auditoria também é. */
    const touched = new Set<string>();
    await db.transaction(async (tx) => {
      const txIds = body.actions.map((x) => x.txId);
      if (new Set(txIds).size !== txIds.length) throw badRequest('Lançamento repetido na conciliação');
      // trava os lançamentos até o fim: duas conciliações ao mesmo tempo não usam o mesmo lançamento
      const rows = await tx.select().from(schema.bankTransactions).where(and(eq(schema.bankTransactions.accountId, a.id), inArray(schema.bankTransactions.id, txIds))).for('update');
      const byId = new Map(rows.map((r) => [r.id, r]));
      const billIds = body.actions.flatMap((x) => (x.kind === 'link' ? [x.billId] : []));
      if (new Set(billIds).size !== billIds.length) throw badRequest('A mesma conta foi escolhida para dois lançamentos');
      for (const act of body.actions) {
        const t = byId.get(act.txId);
        if (!t) throw notFound('Lançamento do extrato não encontrado');
        if (t.status !== 'pending') throw conflict('Um dos lançamentos já foi conciliado (talvez em outra aba ou por outra pessoa). Recarregue a tela.');
        const type = typeOf(t.amount);
        const label = `${formatDateBR(t.postedAt)} ${formatBRL(t.amount.replace('-', ''))}`;
        const mark = (patch: Partial<typeof schema.bankTransactions.$inferInsert>) =>
          tx.update(schema.bankTransactions).set({ ...patch, reconciledBy: req.user!.id, reconciledAt: new Date() }).where(eq(schema.bankTransactions.id, t.id));
        if (act.kind === 'ignore') { await mark({ status: 'ignored' }); done.ignored++; continue; }
        if (act.kind === 'link') {
          const b = await loadBill(req, act.billId, 'view', tx);
          touched.add(b.categoryId);
          if (b.type !== type) throw badRequest(`"${b.description}" é ${b.type === 'payable' ? 'a pagar' : 'a receber'}, mas o lançamento de ${label} é ${type === 'payable' ? 'uma saída' : 'uma entrada'}.`);
          const [other] = await tx.select({ id: schema.bankTransactions.id }).from(schema.bankTransactions)
            .where(and(eq(schema.bankTransactions.billId, b.id), eq(schema.bankTransactions.status, 'linked'), ne(schema.bankTransactions.id, t.id)));
          if (other) throw conflict(`"${b.description}" já está ligada a outro lançamento do extrato.`);
          if (b.status === 'pending') {
            if (!req.org!.can(billPerm(type, 'pay'))) throw forbidden(`Para dar baixa em "${b.description}" pelo extrato é preciso poder dar baixa em ${type === 'payable' ? 'contas a pagar' : 'contas a receber'}.`);
            await tx.update(schema.bills).set({ status: 'paid', paidAt: t.postedAt, paidAmount: abs(t.amount) }).where(eq(schema.bills.id, b.id));
            await mark({ status: 'linked', action: 'paid', billId: b.id });
            done.paid++;
            log.push(`${label} → baixa em "${b.description}"`);
          } else {
            await mark({ status: 'linked', action: 'matched', billId: b.id });
            done.linked++;
            log.push(`${label} → "${b.description}" (já paga)`);
          }
          continue;
        }
        // criar conta já paga a partir do lançamento
        if (!req.org!.can(billPerm(type, 'create')) || !req.org!.can(billPerm(type, 'pay'))) {
          throw forbidden(`Criar ${type === 'payable' ? 'contas a pagar' : 'contas a receber'} pelo extrato exige poder cadastrar e dar baixa nelas.`);
        }
        await assertCategoryUsable(req, act.categoryId, type, tx);
        touched.add(act.categoryId);
        await assertFolder(req, act.folderId, tx);
        const [created] = await createBills(tx, orgId, req.user!.id, {
          type, description: act.description, categoryId: act.categoryId, folderId: act.folderId, recurrenceType: 'once', isIndefinite: false, dueDate: t.postedAt, amount: abs(t.amount),
          relatedPerson: act.relatedPerson ?? null, notes: `Criada pela conciliação do extrato (${a.name}): ${[t.memo, t.name].filter(Boolean).join(' · ')}`.slice(0, 1000),
          paidAt: t.postedAt, paidAmount: abs(t.amount),
        });
        await mark({ status: 'linked', action: 'created', billId: created.id });
        done.created++;
        log.push(`${label} → nova conta "${act.description}"`);
      }
    });
    await audit(req, {
      action: 'bank.reconcile', entityType: 'bank_account', entityId: a.id,
      description: `Conciliou o extrato de ${a.name}: ${done.paid} baixa(s), ${done.linked} ligação(ões) com contas já pagas, ${done.created} conta(s) criada(s), ${done.ignored} ignorado(s)`,
      details: { ...done, actions: log.slice(0, 300), restricted: (await restrictedCategoryIds(orgId)).some((c) => touched.has(c)) },
    });
    return done;
  });

  /** Desfaz a conciliação de um lançamento (volta a conta para pendente ou apaga a conta criada por ele). */
  app.post<{ Params: { id: string } }>('/api/bank/transactions/:id/undo', imp, async (req) => {
    const [t] = await db.select().from(schema.bankTransactions).where(and(eq(schema.bankTransactions.id, req.params.id), eq(schema.bankTransactions.orgId, req.org!.id)));
    if (!t) throw notFound('Lançamento do extrato não encontrado');
    if (t.status === 'pending') return { ok: true };
    const type = typeOf(t.amount);
    let what = 'Voltou a pendente o lançamento ignorado';
    let restricted = false;
    await db.transaction(async (tx) => {
      if (t.status === 'linked' && t.billId) {
        const b = await loadBill(req, t.billId, 'view', tx);
        restricted = (await restrictedCategoryIds(req.org!.id)).includes(b.categoryId);
        if (t.action === 'created') {
          if (!req.org!.can(billPerm(type, 'delete'))) throw forbidden(`Esta conta foi criada pelo extrato: desfazer apaga a conta, e você não pode apagar ${type === 'payable' ? 'contas a pagar' : 'contas a receber'}.`);
          if (b.statementId || b.payrollEntryId) throw conflict('Esta conta não pode ser apagada por aqui.');
          await tx.update(schema.bankTransactions).set({ billId: null }).where(eq(schema.bankTransactions.id, t.id));
          await deleteBillsWithFiles(tx, [b.id]);
          what = `Desfez a conciliação: apagou a conta "${b.description}" criada pelo extrato`;
        } else if (t.action === 'paid' && b.status === 'paid') {
          if (!req.org!.can(billPerm(type, 'pay'))) throw forbidden('Desfazer volta a conta para pendente, e você não pode reverter pagamentos.');
          await tx.update(schema.bills).set({ status: 'pending', paidAt: null, paidAmount: null }).where(eq(schema.bills.id, b.id));
          what = `Desfez a conciliação: "${b.description}" voltou a pendente`;
        } else what = `Desligou "${b.description}" do lançamento do extrato`;
      } else if (t.status === 'linked') what = 'Desligou o lançamento do extrato (a conta já tinha sido apagada)';
      await tx.update(schema.bankTransactions).set({ status: 'pending', action: null, billId: null, reconciledBy: null, reconciledAt: null }).where(eq(schema.bankTransactions.id, t.id));
    });
    await audit(req, { action: 'bank.reconcile_undo', entityType: 'bank_transaction', entityId: t.id, description: `${what} (${formatDateBR(t.postedAt)} ${formatBRL(t.amount)})`, details: { restricted } });
    return { ok: true };
  });
}

