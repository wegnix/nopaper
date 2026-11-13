import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  ATTACHMENT_SLOTS, BILL_TYPES, CATEGORY_KINDS, COLOR_KEYS, MAX_OCCURRENCES, RECURRENCE_TYPES, isoDate, money, positiveMoney,
  type AttachmentSlot, type Permission,
} from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { parse } from '../lib/validate.js';
import { HttpError } from '../lib/errors.js';
import { attachmentsFor, deleteBillsWithFiles, loadBill, orgToday, seriesRows, visibilityCond, type AttachmentSummary, type BillRow } from '../services/bills.js';
import { createForward } from '../lib/forward.js';
import { claimIdempotencyKey, finishIdempotencyKey, releaseIdempotencyKey } from '../services/integrations.js';

/**
 * Gravação na API pública. As regras de negócio são as das rotas internas (as mesmas da tela):
 * aqui o corpo é validado no formato da v1, repassado à rota interna com o mesmo token (`forward`)
 * e a resposta volta no formato da v1. Assim série, categoria restrita, fatura de cartão, folha e
 * auditoria se comportam igual nos dois caminhos.
 */
export interface V1Helpers {
  limited: { config: { rateLimit: object } };
  need(req: FastifyRequest, ...anyOf: Permission[]): void;
  billV1(b: BillRow, today: string, att?: Partial<Record<AttachmentSlot, AttachmentSummary>>): unknown;
}

const text = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v === '' ? null : v));
const externalIdSchema = z.string().trim().min(1).max(120).regex(/^[\x21-\x7e]+$/, 'Use só letras, números e símbolos, sem espaços');
const sourceSchema = z.string().trim().min(1).max(40);

const createBody = z.object({
  type: z.enum(BILL_TYPES),
  description: z.string().trim().min(1, 'Informe a descrição').max(255),
  categoryId: z.string().uuid(),
  folderId: z.string().uuid().nullish(),
  amount: positiveMoney.optional(),
  dueDate: isoDate,
  relatedPerson: text(128), notes: text(2000), barcode: text(120), pixKey: text(600), paymentMethod: text(64),
  paidAt: isoDate.nullish(),
  paidAmount: money.nullish(),
  recurrence: z.object({
    type: z.enum(RECURRENCE_TYPES),
    indefinite: z.boolean().default(false),
    occurrences: z.number().int().min(1).max(MAX_OCCURRENCES).optional(),
    amounts: z.array(positiveMoney).max(MAX_OCCURRENCES).optional(),
    dueDates: z.array(isoDate).max(MAX_OCCURRENCES).optional(),
    firstInstallment: z.number().int().min(1).max(MAX_OCCURRENCES).optional(),
    /** Identificador externo de cada ocorrência, na ordem em que são criadas (a 1ª é a própria conta). */
    externalIds: z.array(externalIdSchema.nullable()).max(MAX_OCCURRENCES).optional(),
  }).strict().optional(),
  externalId: externalIdSchema.optional(),
  source: sourceSchema.optional(),
}).strict();

const patchBody = z.object({
  description: z.string().trim().min(1).max(255).optional(),
  categoryId: z.string().uuid().optional(),
  folderId: z.string().uuid().nullable().optional(),
  amount: positiveMoney.optional(),
  dueDate: isoDate.optional(),
  relatedPerson: text(128), notes: text(2000), barcode: text(120), pixKey: text(600), paymentMethod: text(64),
  paidAt: isoDate.optional(),
  paidAmount: money.optional(),
  /** Leva a mudança (menos o vencimento) às próximas contas em aberto da mesma série. */
  applyToFollowing: z.boolean().default(false),
  externalId: externalIdSchema.nullable().optional(),
  source: sourceSchema.nullable().optional(),
}).strict();

const payBody = z.object({ paidAt: isoDate.optional(), paidAmount: money.optional() }).strict();
const categoryBody = z.object({ name: z.string().trim().min(1).max(64), color: z.enum(COLOR_KEYS).optional(), kind: z.enum(CATEGORY_KINDS).optional(), restricted: z.boolean().optional() }).strict();
const folderBody = z.object({ name: z.string().trim().min(1).max(64), label: z.string().trim().min(1).max(32), color: z.enum(COLOR_KEYS).optional() }).strict();

const isUniqueViolation = (e: unknown) => { const x = e as { code?: string; cause?: { code?: string } }; return x.code === '23505' || x.cause?.code === '23505'; };
const externalConflict = () => new HttpError(409, 'Já existe outra conta neste espaço com este externalId.', 'external_id_conflict');

export function registerV1Writes(app: FastifyInstance, api: FastifyInstance, h: V1Helpers) {
  const { forward } = createForward(app);

  /** `Idempotency-Key`: a mesma chave em até 24 h devolve a resposta da 1ª chamada, sem refazer. */
  async function idempotent(req: FastifyRequest, reply: FastifyReply, run: () => Promise<{ status?: number; body: unknown }>) {
    const key = req.headers['idempotency-key'];
    if (key === undefined) { const r = await run(); return reply.code(r.status ?? 200).send(r.body); }
    if (typeof key !== 'string' || !/^[\x21-\x7e]{1,120}$/.test(key)) throw new HttpError(400, 'Idempotency-Key inválida: use até 120 caracteres sem espaços (ex.: um UUID).', 'validation');
    const tokenId = req.integration!.id;
    const claim = await claimIdempotencyKey(tokenId, key, `${req.method} ${req.url} ${JSON.stringify(req.body ?? null)}`);
    if (claim.state === 'mismatch') throw new HttpError(409, 'Esta Idempotency-Key já foi usada em outra chamada, com outro endereço ou corpo.', 'idempotency_mismatch');
    if (claim.state === 'running') throw new HttpError(409, 'A chamada anterior com esta Idempotency-Key ainda está em andamento. Tente de novo em instantes.', 'idempotency_in_progress');
    if (claim.state === 'replay') return reply.code(claim.status).header('idempotent-replay', 'true').send(claim.response);
    try {
      const r = await run();
      const status = r.status ?? 200;
      await finishIdempotencyKey(tokenId, key, status, r.body);
      return reply.code(status).send(r.body);
    } catch (e) {
      await releaseIdempotencyKey(tokenId, key);
      throw e;
    }
  }

  /** Contas no formato da v1, relidas do banco (a resposta interna não traz externalId). */
  async function billsOut(req: FastifyRequest, ids: string[]) {
    if (!ids.length) return [];
    const rows = await db.select().from(schema.bills).where(and(eq(schema.bills.orgId, req.org!.id), inArray(schema.bills.id, ids)));
    const att = await attachmentsFor(ids);
    const today = orgToday(req);
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.map((id) => byId.get(id)).filter((r): r is BillRow => !!r).map((r) => h.billV1(r, today, att.get(r.id)));
  }
  const billOut = async (req: FastifyRequest, id: string) => (await billsOut(req, [id]))[0];

  async function findByExternalId(req: FastifyRequest, externalIds: string[]) {
    if (!externalIds.length) return [];
    return db.select().from(schema.bills).where(and(eq(schema.bills.orgId, req.org!.id), inArray(schema.bills.externalId, externalIds), await visibilityCond(req)));
  }

  // ------------------------------------------------------------ criar
  api.post('/api/v1/bills', h.limited, (req, reply) => idempotent(req, reply, async () => {
    const body = parse(createBody, req.body);
    h.need(req, `${body.type}.create`);
    const rec = body.recurrence;
    const occurrenceIds = (rec?.externalIds ?? []).map((v, i) => (i === 0 ? v ?? body.externalId ?? null : v));
    const headExternalId = body.externalId ?? occurrenceIds[0] ?? null;
    if (body.externalId && occurrenceIds[0] && occurrenceIds[0] !== body.externalId) throw new HttpError(400, 'recurrence.externalIds[0] é a própria conta: precisa ser igual a externalId.', 'validation');
    const wanted = [...new Set([headExternalId, ...occurrenceIds.slice(1)].filter((v): v is string => !!v))];
    if (wanted.length !== [headExternalId, ...occurrenceIds.slice(1)].filter(Boolean).length) throw new HttpError(400, 'Há externalId repetido nas ocorrências.', 'validation');

    // já existe conta com este externalId: devolve a que existe (e a série dela), sem criar outra
    const seriesOf = async (b: BillRow) => (await seriesRows(db, b)).map((r) => r.id);
    const found = await findByExternalId(req, wanted);
    const head = headExternalId ? found.find((b) => b.externalId === headExternalId) : undefined;
    if (head) return { status: 200, body: { created: false, seriesId: head.parentId ?? (head.recurrenceType !== 'once' ? head.id : null), items: await billsOut(req, await seriesOf(head)) } };
    if (found.length) throw externalConflict();

    const created = await forward<{ headId: string; items: Array<{ id: string }> }>(req, 'POST', '/api/bills', {
      type: body.type, description: body.description, categoryId: body.categoryId, folderId: body.folderId ?? null,
      amount: body.amount, dueDate: body.dueDate, relatedPerson: body.relatedPerson, notes: body.notes, barcode: body.barcode,
      pixKey: body.pixKey, paymentMethod: body.paymentMethod, paidAt: body.paidAt ?? null, paidAmount: body.paidAmount ?? null,
      recurrenceType: rec?.type ?? 'once', isIndefinite: rec?.indefinite ?? false, totalOccurrences: rec?.occurrences,
      installmentAmounts: rec?.amounts, installmentDueDates: rec?.dueDates, firstInstallment: rec?.firstInstallment,
    });
    const ids = created.items.map((i) => i.id);
    if (occurrenceIds.length > ids.length) {
      await deleteBillsWithFiles(db, ids);
      throw new HttpError(400, `recurrence.externalIds tem ${occurrenceIds.length} itens, mas a série gerou ${ids.length} conta(s).`, 'validation');
    }
    if (wanted.length || body.source) {
      try {
        await db.transaction(async (tx) => {
          if (body.source) await tx.update(schema.bills).set({ source: body.source }).where(inArray(schema.bills.id, ids));
          const marks = ids.map((id, i) => ({ id, externalId: i === 0 ? headExternalId : occurrenceIds[i] ?? null })).filter((m) => m.externalId);
          for (const m of marks) await tx.update(schema.bills).set({ externalId: m.externalId }).where(eq(schema.bills.id, m.id));
        });
      } catch (e) {
        // duas chamadas ao mesmo tempo com o mesmo externalId: a outra chegou antes; desfaz esta
        await deleteBillsWithFiles(db, ids);
        if (!isUniqueViolation(e)) throw e;
        const [other] = headExternalId ? await findByExternalId(req, [headExternalId]) : [];
        if (!other) throw externalConflict();
        return { status: 200, body: { created: false, seriesId: other.parentId ?? (other.recurrenceType !== 'once' ? other.id : null), items: await billsOut(req, await seriesOf(other)) } };
      }
    }
    return { status: 201, body: { created: true, seriesId: ids.length > 1 ? created.headId : null, items: await billsOut(req, ids) } };
  }));

  // ------------------------------------------------------------ editar
  api.patch<{ Params: { id: string } }>('/api/v1/bills/:id', h.limited, async (req) => {
    const { applyToFollowing, externalId, source, ...fields } = parse(patchBody, req.body);
    const b = await loadBill(req, req.params.id, 'edit');
    if ((b.statementId || b.payrollEntryId) && ((fields.amount && fields.amount !== b.amount) || (fields.dueDate && fields.dueDate !== b.dueDate))) {
      throw new HttpError(409, b.statementId
        ? 'O valor e o vencimento desta conta vêm da fatura do cartão: altere as compras do cartão.'
        : 'O valor e o vencimento deste salário vêm da folha de pagamento: altere o lançamento da folha.', 'locked');
    }
    if ((fields.paidAt || fields.paidAmount) && b.status !== 'paid') throw new HttpError(409, 'A conta está em aberto. Para dar baixa use POST /bills/{id}/pay.', 'not_paid');
    if (externalId && externalId !== b.externalId) {
      const [dup] = await db.select({ id: schema.bills.id }).from(schema.bills).where(and(eq(schema.bills.orgId, b.orgId), eq(schema.bills.externalId, externalId)));
      if (dup) throw externalConflict();
    }
    const changed = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
    if (Object.keys(changed).length) await forward(req, 'PUT', `/api/bills/${b.id}`, { ...changed, cascade: applyToFollowing });
    if (externalId !== undefined || source !== undefined) {
      try {
        await db.update(schema.bills).set({ ...(externalId !== undefined ? { externalId } : {}), ...(source !== undefined ? { source } : {}) }).where(eq(schema.bills.id, b.id));
      } catch (e) { if (isUniqueViolation(e)) throw externalConflict(); throw e; }
    }
    return billOut(req, b.id);
  });

  // ------------------------------------------------------------ baixa
  api.post<{ Params: { id: string } }>('/api/v1/bills/:id/pay', h.limited, (req, reply) => idempotent(req, reply, async () => {
    const body = parse(payBody, req.body ?? {});
    await forward(req, 'POST', `/api/bills/${req.params.id}/pay`, body);
    return { body: await billOut(req, req.params.id) };
  }));

  api.post<{ Params: { id: string } }>('/api/v1/bills/:id/unpay', h.limited, (req, reply) => idempotent(req, reply, async () => {
    await forward(req, 'POST', `/api/bills/${req.params.id}/unpay`, {});
    return { body: await billOut(req, req.params.id) };
  }));

  // ------------------------------------------------------------ série e exclusão
  api.get<{ Params: { id: string } }>('/api/v1/bills/:id/series', h.limited, async (req) => {
    const b = await loadBill(req, req.params.id);
    const hidden = req.org!.can('bills.view_restricted') ? [] : (await db.select({ id: schema.categories.id }).from(schema.categories)
      .where(and(eq(schema.categories.orgId, b.orgId), eq(schema.categories.isRestricted, true)))).map((c) => c.id);
    const rows = (await seriesRows(db, b)).filter((r) => !hidden.includes(r.categoryId));
    return { seriesId: b.parentId ?? (b.recurrenceType !== 'once' ? b.id : null), items: await billsOut(req, rows.map((r) => r.id)) };
  });

  api.delete<{ Params: { id: string }; Querystring: { scope?: string } }>('/api/v1/bills/:id', h.limited, async (req) => {
    const scope = parse(z.enum(['one', 'following', 'series']).default('one'), req.query.scope);
    const r = await forward<{ deleted: number; preservedPaid: number }>(req, 'DELETE', `/api/bills/${req.params.id}?mode=${scope === 'following' ? 'forward' : scope}`);
    return { deleted: r.deleted, preservedPaid: r.preservedPaid };
  });

  // ------------------------------------------------------------ anexos
  api.post<{ Params: { id: string }; Querystring: { slot?: string } }>('/api/v1/bills/:id/attachments', h.limited, async (req) => {
    const slot = parse(z.enum(['auto', ...ATTACHMENT_SLOTS]).default('auto'), req.query.slot);
    if (!req.isMultipart()) throw new HttpError(400, 'Envie o arquivo em multipart/form-data, no campo "file".', 'validation');
    const r = await forward<{ slot: string; classification: unknown }>(req, 'POST', `/api/bills/${req.params.id}/attachments?slot=${slot}`, undefined, true);
    return { slot: r.slot, detected: r.classification, bill: await billOut(req, req.params.id) };
  });

  api.delete<{ Params: { id: string; slot: string } }>('/api/v1/bills/:id/attachments/:slot', h.limited, async (req) => {
    const slot = parse(z.enum(ATTACHMENT_SLOTS), req.params.slot);
    await forward(req, 'DELETE', `/api/bills/${req.params.id}/attachments/${slot}`);
    return billOut(req, req.params.id);
  });

  /** Lê um boleto, nota ou comprovante sem guardar: tipo, valor, vencimento e linha digitável. */
  api.post('/api/v1/documents/analyze', h.limited, async (req) => {
    if (!req.isMultipart()) throw new HttpError(400, 'Envie o arquivo em multipart/form-data, no campo "file".', 'validation');
    return forward(req, 'POST', '/api/documents/analyze', undefined, true);
  });

  // ------------------------------------------------------------ categorias e pastas
  type Cat = { id: string; label: string; color: string; kind: string; isRestricted: boolean; updatedAt: string };
  const catOut = (c: Cat) => ({ id: c.id, name: c.label, color: c.color, kind: c.kind, restricted: c.isRestricted, updatedAt: c.updatedAt });
  const catIn = (b: Partial<z.output<typeof categoryBody>>) => ({ label: b.name, color: b.color, kind: b.kind, isRestricted: b.restricted });

  api.post('/api/v1/categories', h.limited, (req, reply) => idempotent(req, reply, async () => (
    { status: 201, body: catOut(await forward<Cat>(req, 'POST', '/api/categories', catIn(parse(categoryBody, req.body)))) }
  )));
  api.patch<{ Params: { id: string } }>('/api/v1/categories/:id', h.limited, async (req) => catOut(await forward<Cat>(req, 'PUT', `/api/categories/${req.params.id}`, catIn(parse(categoryBody.partial(), req.body)))));
  api.delete<{ Params: { id: string } }>('/api/v1/categories/:id', h.limited, async (req) => { await forward(req, 'DELETE', `/api/categories/${req.params.id}`); return { deleted: true }; });

  type Folder = { id: string; name: string; label: string; color: string; updatedAt: string };
  const folderOut = (f: Folder) => ({ id: f.id, name: f.name, label: f.label, color: f.color, updatedAt: f.updatedAt });
  api.post('/api/v1/folders', h.limited, (req, reply) => idempotent(req, reply, async () => (
    { status: 201, body: folderOut(await forward<Folder>(req, 'POST', '/api/folders', parse(folderBody, req.body))) }
  )));
  api.patch<{ Params: { id: string } }>('/api/v1/folders/:id', h.limited, async (req) => folderOut(await forward<Folder>(req, 'PUT', `/api/folders/${req.params.id}`, parse(folderBody.partial(), req.body))));
  api.delete<{ Params: { id: string } }>('/api/v1/folders/:id', h.limited, async (req) => { await forward(req, 'DELETE', `/api/folders/${req.params.id}`); return { deleted: true }; });
}
