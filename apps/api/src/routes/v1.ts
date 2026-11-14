import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, asc, eq, gte, inArray, isNull, lt, lte, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { BILL_TYPES, isoDate, type AttachmentSlot, type BillType, type Permission } from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { env } from '../env.js';
import { APP_VERSION } from '../lib/version.js';
import { parse } from '../lib/validate.js';
import { HttpError, notFound } from '../lib/errors.js';
import { signFileToken } from '../lib/storage.js';
import { attachmentsFor, loadBill, orgToday, summary, viewPerm, visibilityCond, type AttachmentSummary, type BillRow } from '../services/bills.js';
import { openApiDocument } from '../lib/openapi.js';
import { registerV1Writes } from './v1write.js';
import { registerV1Areas } from './v1areas.js';
import { latestEventCursor, listEvents } from '../services/events.js';
import { rateLimitFor } from '../services/integrations.js';

/**
 * API pública (`/api/v1`): superfície estável para outros sistemas, separada da API interna que o
 * front usa. Autenticação por token de integração (`Authorization: Bearer np_…`); o espaço e as
 * permissões vêm do token. Formato dos campos aqui é contrato: só acrescentar, nunca mudar ou tirar.
 */

const STATUS_CODES: Record<number, string> = { 400: 'invalid_request', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict', 413: 'too_large', 429: 'rate_limited', 503: 'maintenance' };

/** Cada token tem a própria cota (a chave é o hash do cabeçalho: o limite roda antes da autenticação). */
const limited = {
  config: {
    rateLimit: {
      // o padrão, ou o limite próprio do token (Configurações → Integrações)
      max: (req: FastifyRequest) => rateLimitFor(req.headers.authorization), timeWindow: '1 minute',
      keyGenerator: (req: FastifyRequest) => (req.headers.authorization ? `v1:${createHash('sha256').update(req.headers.authorization).digest('hex')}` : `v1ip:${req.ip}`),
    },
  },
};

async function requireToken(req: FastifyRequest) {
  if (req.integration && req.org) return;
  if (req.tokenFailure === 'ip') throw new HttpError(403, 'Este token não aceita chamadas deste endereço IP.', 'ip_not_allowed');
  if (req.tokenFailure === 'expired') throw new HttpError(401, 'A validade deste token terminou. Gere outro em Configurações → Integrações.', 'token_expired');
  throw new HttpError(401, 'Token ausente, inválido ou revogado. Envie "Authorization: Bearer np_…".', 'unauthorized');
}

/** Exige uma das permissões; a resposta diz qual faltou. */
function need(req: FastifyRequest, ...anyOf: Permission[]) {
  if (!anyOf.some((p) => req.org!.can(p))) throw new HttpError(403, `O token não tem a permissão necessária: ${anyOf.join(' ou ')}.`, 'forbidden', { required: anyOf });
}

const billV1 = (b: BillRow, today: string, att: Partial<Record<AttachmentSlot, AttachmentSummary>> = {}) => ({
  id: b.id,
  type: b.type,
  description: b.description,
  amount: b.amount,
  dueDate: b.dueDate,
  status: b.status,
  overdue: b.status === 'pending' && b.dueDate < today,
  paidAt: b.paidAt,
  paidAmount: b.paidAmount,
  categoryId: b.categoryId,
  folderId: b.folderId,
  relatedPerson: b.relatedPerson,
  notes: b.notes,
  barcode: b.barcode,
  pixKey: b.pixKey,
  paymentMethod: b.paymentMethod,
  recurrence: {
    type: b.recurrenceType,
    /** Id da 1ª conta da série (igual em todas as ocorrências); null em conta avulsa. */
    seriesId: b.parentId ?? (b.recurrenceType !== 'once' ? b.id : null),
    installmentNumber: b.installmentNumber,
    totalInstallments: b.totalInstallments,
    indefinite: b.isIndefinite,
  },
  /** De onde a conta vem: fatura de cartão e salário da folha têm valor e vencimento controlados lá. */
  origin: b.statementId ? 'card_statement' : b.payrollEntryId ? 'payroll' : 'manual',
  locked: !!(b.statementId || b.payrollEntryId),
  /** Identificador desta conta no sistema que a criou pela API, e o nome desse sistema. */
  externalId: b.externalId,
  source: b.source,
  attachments: Object.entries(att).map(([slot, a]) => ({ id: a!.id, slot, name: a!.name, mime: a!.mime, size: a!.size })),
  createdAt: b.createdAt,
  updatedAt: b.updatedAt,
});

const encodeCursor = (b: BillRow) => Buffer.from(`${b.dueDate}|${b.id}`).toString('base64url');
function decodeCursor(c: string) {
  const [dueDate, id] = Buffer.from(c, 'base64url').toString().split('|');
  if (!dueDate || !id || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(400, 'Cursor inválido. Use o valor de "nextCursor" da resposta anterior.', 'validation');
  return { dueDate, id };
}

const listQuery = z.object({
  type: z.enum(BILL_TYPES).optional(),
  status: z.enum(['pending', 'paid', 'overdue']).optional(),
  dueFrom: isoDate.optional(),
  dueTo: isoDate.optional(),
  paidFrom: isoDate.optional(),
  paidTo: isoDate.optional(),
  categoryId: z.string().uuid().optional(),
  folderId: z.union([z.string().uuid(), z.literal('none')]).optional(),
  search: z.string().trim().max(120).optional(),
  externalId: z.string().trim().min(1).max(120).optional(),
  updatedSince: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(200).optional(),
});

export default async function v1Routes(app: FastifyInstance) {
  // erros no formato da API pública: { error: { code, message, … } }
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      const status = err.statusCode === 422 ? 400 : err.statusCode;
      return reply.status(status).send({ error: { code: err.code ?? STATUS_CODES[status] ?? 'error', message: err.message, ...err.extra } });
    }
    const e = err as { statusCode?: number; message: string; code?: string; cause?: { code?: string } };
    if (e.code === '22P02' || e.cause?.code === '22P02') return reply.status(404).send({ error: { code: 'not_found', message: 'Não encontrado' } });
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: { code: STATUS_CODES[e.statusCode] ?? 'error', message: e.statusCode === 429 ? 'Limite de chamadas do token atingido. Tente de novo depois do tempo em Retry-After.' : e.message } });
    }
    req.log.error({ err }, 'erro não tratado');
    return reply.status(500).send({ error: { code: 'internal', message: 'Erro interno. Tente novamente.' } });
  });

  // a descrição da API é aberta: não traz dado de nenhum espaço
  app.get('/api/v1/openapi.json', async () => openApiDocument(env.APP_URL));

  await app.register(async (api) => {
    api.addHook('preHandler', requireToken);

    /** Teste de conexão: de qual espaço é o token e o que ele pode fazer. */
    api.get('/api/v1/space', limited, async (req) => {
      const [o] = await db.select({ document: schema.organizations.document, legalName: schema.organizations.legalName })
        .from(schema.organizations).where(eq(schema.organizations.id, req.org!.id));
      return {
        id: req.org!.id, name: req.org!.name, legalName: o?.legalName ?? null, document: o?.document ?? null,
        kind: req.org!.kind, timezone: req.org!.timezone, today: orgToday(req),
        integration: { id: req.integration!.id, name: req.integration!.name, permissions: [...req.org!.permissions], expiresAt: req.integration!.expiresAt },
        /** Cursor do evento mais recente: comece `/events` daqui para receber só o que acontecer a partir de agora. */
        eventsCursor: await latestEventCursor(req.org!.id),
        apiVersion: 'v1', serverVersion: APP_VERSION,
      };
    });

    // ------------------------------------------------------------ contas a pagar e a receber
    api.get('/api/v1/bills', limited, async (req) => {
      const q = parse(listQuery, req.query);
      const types = (q.type ? [q.type] : [...BILL_TYPES]).filter((t) => req.org!.can(viewPerm(t)));
      if (!types.length) need(req, ...(q.type ? [viewPerm(q.type)] : BILL_TYPES.map(viewPerm)));
      const today = orgToday(req);
      const t = schema.bills;
      const conds: (SQL | undefined)[] = [eq(t.orgId, req.org!.id), inArray(t.type, types), await visibilityCond(req)];
      if (q.status === 'overdue') conds.push(eq(t.status, 'pending'), lt(t.dueDate, today));
      else if (q.status) conds.push(eq(t.status, q.status));
      if (q.dueFrom) conds.push(gte(t.dueDate, q.dueFrom));
      if (q.dueTo) conds.push(lte(t.dueDate, q.dueTo));
      if (q.paidFrom) conds.push(gte(t.paidAt, q.paidFrom));
      if (q.paidTo) conds.push(lte(t.paidAt, q.paidTo));
      if (q.categoryId) conds.push(eq(t.categoryId, q.categoryId));
      if (q.folderId === 'none') conds.push(isNull(t.folderId));
      else if (q.folderId) conds.push(eq(t.folderId, q.folderId));
      if (q.externalId) conds.push(eq(t.externalId, q.externalId));
      if (q.updatedSince) conds.push(gte(t.updatedAt, new Date(q.updatedSince)));
      if (q.search) {
        const term = `%${q.search.toLowerCase()}%`;
        conds.push(or(
          sql`lower(${t.description}) like ${term}`,
          sql`lower(coalesce(${t.relatedPerson}, '')) like ${term}`,
          sql`lower(coalesce(${t.notes}, '')) like ${term}`,
        ));
      }
      if (q.cursor) {
        const c = decodeCursor(q.cursor);
        conds.push(sql`(${t.dueDate}, ${t.id}) > (${c.dueDate}::date, ${c.id}::uuid)`);
      }
      const rows = await db.select().from(t).where(and(...conds)).orderBy(asc(t.dueDate), asc(t.id)).limit(q.limit + 1);
      const page = rows.slice(0, q.limit);
      const att = await attachmentsFor(page.map((r) => r.id));
      return { items: page.map((r) => billV1(r, today, att.get(r.id))), nextCursor: rows.length > q.limit ? encodeCursor(page.at(-1)!) : null };
    });

    api.get('/api/v1/bills/summary', limited, async (req) => {
      const q = parse(z.object({ type: z.enum(BILL_TYPES), year: z.coerce.number().int().min(1900).max(2200), month: z.coerce.number().int().min(1).max(12) }), req.query);
      need(req, viewPerm(q.type));
      return { type: q.type, ...(await summary(req, q.type as BillType, q.year, q.month)) };
    });

    api.get<{ Params: { id: string } }>('/api/v1/bills/:id', limited, async (req) => {
      const b = await loadBill(req, req.params.id);
      return billV1(b, orgToday(req), (await attachmentsFor([b.id])).get(b.id));
    });

    /** URL assinada (10 min) de um anexo. Peça uma nova a cada uso. */
    api.get<{ Params: { id: string } }>('/api/v1/attachments/:id/url', limited, async (req) => {
      const [a] = await db.select().from(schema.attachments).where(and(eq(schema.attachments.id, req.params.id), eq(schema.attachments.orgId, req.org!.id)));
      if (!a) throw notFound('Anexo não encontrado');
      await loadBill(req, a.billId); // permissão do tipo e categoria restrita
      const base = `${env.APP_URL.replace(/\/$/, '')}/api/files/${a.id}?t=${signFileToken(a.id)}`;
      return { id: a.id, billId: a.billId, slot: a.slot, name: a.originalName, mime: a.mime, size: a.size, url: base, downloadUrl: `${base}&download=1`, expiresInSeconds: 600 };
    });

    // ------------------------------------------------------------ categorias e pastas
    api.get('/api/v1/categories', limited, async (req) => {
      need(req, 'payable.view', 'receivable.view', 'cards.view', 'reports.view');
      const seeRestricted = req.org!.can('bills.view_restricted');
      const rows = await db.select({
        id: schema.categories.id, name: schema.categories.label, color: schema.categories.color, kind: schema.categories.kind,
        restricted: schema.categories.isRestricted, updatedAt: schema.categories.updatedAt,
      }).from(schema.categories)
        .where(and(eq(schema.categories.orgId, req.org!.id), seeRestricted ? undefined : eq(schema.categories.isRestricted, false)));
      return { items: rows.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' })) };
    });

    api.get('/api/v1/folders', limited, async (req) => {
      need(req, 'payable.view', 'receivable.view');
      const rows = await db.select({
        id: schema.folders.id, name: schema.folders.name, label: schema.folders.label, color: schema.folders.color, updatedAt: schema.folders.updatedAt,
      }).from(schema.folders).where(eq(schema.folders.orgId, req.org!.id));
      return { items: rows.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR', { sensitivity: 'base' })) };
    });

    registerV1Writes(app, api, { limited, need, billV1 });
    registerV1Areas(app, api, { limited, need, billV1 });

    /** O que mudou no espaço desde o cursor, em ordem. Guarde `nextCursor` e mande de volta em `after`. */
    api.get('/api/v1/events', limited, async (req) => {
      const q = parse(z.object({
        after: z.string().regex(/^\d{1,18}$/, 'Use o valor de "nextCursor" (ou de "eventsCursor" em /space)').default('0'),
        limit: z.coerce.number().int().min(1).max(200).default(100),
        types: z.string().max(400).optional(),
      }), req.query);
      const prefixes = (q.types ?? '').split(',').map((s) => s.trim()).filter((s) => /^[a-z_.]+$/.test(s));
      return listEvents({ orgId: req.org!.id, can: req.org!.can }, q.after, q.limit, prefixes);
    });

    api.all('/api/v1/*', async () => { throw notFound('Este endereço não existe na API v1. Veja /api/v1/openapi.json.'); });
  });
}
