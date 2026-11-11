import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  ACCOUNTING_KIND_LABEL, accountingHandleSchema, accountingSendSchema, accountingUploadSchema, formatBRL, formatDateBR, parseBoleto, parsePayslips, refLabelPT,
  type AccountingDetected, type AccountingKind,
} from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { env } from '../env.js';
import { parse } from '../lib/validate.js';
import { badRequest, forbidden, HttpError, notFound } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { ALLOWED_UPLOADS, ARCHIVE_UPLOADS, deleteFile, readStoredFile, saveFile, saveUploadStream, signFileToken, sniffArchive, sniffMime, streamStoredFile, verifyFileToken } from '../lib/storage.js';
import { classifyDocument } from '../services/classifier.js';
import { pdfToCells } from '../services/pdf.js';
import { loadAlertConfig } from '../services/alerts.js';
import { escapeHtml, sendEmail, telegramSend, telegramToken } from '../services/notify.js';

type Doc = typeof schema.accountingDocuments.$inferSelect;
const MAX_FILES = 20;
/** Os links assinados dos documentos não valem para os anexos das contas (e vice-versa). */
const tokenId = (id: string) => `acc:${id}`;
const any = { preHandler: requirePerm('accounting.upload', 'accounting.review', 'accounting.send') };

/**
 * De que lado do documento a pessoa está. Cada documento tem quem enviou e quem recebe:
 * - do contador para o espaço: enviou = o próprio contador (só o que é dele); recebe = quem confere;
 * - do espaço para o contador: enviou = quem tem "enviar para o contador" (a equipe divide a lista);
 *   recebe = o contador (tem "enviar documentos" e não é da equipe).
 */
type Side = 'sender' | 'recipient';
function sideOf(req: FastifyRequest, d: Doc): Side | null {
  const can = req.org!.can;
  if (d.direction === 'to_accountant') return can('accounting.send') ? 'sender' : can('accounting.upload') ? 'recipient' : null;
  return can('accounting.review') ? 'recipient' : d.uploadedBy === req.user!.id ? 'sender' : null;
}
/** Cada lado só enxerga o que ainda está na lista dele. */
async function loadDoc(req: FastifyRequest, id: string): Promise<{ d: Doc; side: Side }> {
  const [d] = await db.select().from(schema.accountingDocuments).where(and(eq(schema.accountingDocuments.id, id), eq(schema.accountingDocuments.orgId, req.org!.id)));
  const side = d ? sideOf(req, d) : null;
  if (!d || !side || (side === 'sender' ? d.uploaderRemovedAt : d.hiddenAt)) throw notFound('Documento não encontrado');
  return { d, side };
}

const EXT: Record<string, string> = { ...ALLOWED_UPLOADS, ...ARCHIVE_UPLOADS };
/** Dá para abrir no navegador (PDF e imagem); o resto é só download. */
const previewable = (mime: string) => !!ALLOWED_UPLOADS[mime];

/** Lê os campos e os arquivos de um envio do contador (um pedido, vários arquivos, em memória: são pequenos). */
async function readUpload(req: FastifyRequest) {
  const fields: Record<string, string> = {};
  const files: Array<{ buf: Buffer; mime: string; filename: string }> = [];
  for await (const part of req.parts({ limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: MAX_FILES } })) {
    if (part.type === 'field') { fields[part.fieldname] = String(part.value ?? ''); continue; }
    const buf = await part.toBuffer();
    const filename = (part.filename || 'arquivo').slice(0, 200);
    if (part.file.truncated) throw badRequest(`"${filename}" é maior que ${env.MAX_UPLOAD_MB} MB`);
    if (!buf.length) throw badRequest(`"${filename}" está vazio`);
    const mime = sniffMime(buf);
    if (!mime || !ALLOWED_UPLOADS[mime]) throw badRequest(`"${filename}": formato não suportado. Envie PDF (ou imagem PNG/JPG).`);
    files.push({ buf, mime, filename });
  }
  if (!files.length) throw badRequest('Escolha ao menos um arquivo');
  return { fields, files };
}

/** O que dá para ler do arquivo já no envio (ajuda quem confere; nada disso é obrigatório). */
async function detect(kind: AccountingKind, buf: Buffer, mime: string, filename: string): Promise<AccountingDetected | null> {
  try {
    if (kind === 'payslip') {
      if (mime !== 'application/pdf') return null;
      const r = parsePayslips(await pdfToCells(buf, 200));
      return r.slips.length ? { slips: r.slips.length, slipsRef: r.ref, company: r.company } : null;
    }
    const c = await classifyDocument(buf, mime, filename);
    // só vale o que veio de um boleto/guia reconhecido com segurança (números soltos de outro PDF enganam)
    if (c.kind !== 'boleto' || c.confidence === 'low' || (!c.amount && !c.dueDate && !c.barcode && !c.pixCode)) return null;
    // linha digitável que não fecha nos dígitos verificadores é coincidência de números no texto
    if (c.barcode && !parseBoleto(c.barcode)?.valid) return null;
    return { amount: c.amount, dueDate: c.dueDate, barcode: c.barcode, pix: !!c.pixCode };
  } catch { return null; }
}

/** Avisa pelos canais de alerta do espaço (Telegram / e-mail) que chegaram documentos. */
async function notifyUpload(orgId: string, uploader: string, docs: Doc[]) {
  const cfg = await loadAlertConfig(orgId);
  if (!cfg.enabled || !cfg.accounting) return;
  const [org] = await db.select({ name: schema.organizations.name }).from(schema.organizations).where(eq(schema.organizations.id, orgId));
  const line = (d: Doc) => {
    const det = d.detected as AccountingDetected | null;
    const extra = [det?.amount ? formatBRL(det.amount) : null, det?.dueDate ? `vence ${formatDateBR(det.dueDate)}` : null, det?.slips ? `${det.slips} holerite(s)` : null].filter(Boolean).join(' · ');
    return `${ACCOUNTING_KIND_LABEL[d.kind as AccountingKind]}${d.competence ? ` – ${refLabelPT(d.competence)}` : ''}${extra ? ` (${extra})` : ''}`;
  };
  const title = `${uploader} enviou ${docs.length === 1 ? '1 documento' : `${docs.length} documentos`}`;
  const url = `${env.APP_URL}/contador`;
  const results: Array<{ channel: 'telegram' | 'email'; target: string; ok: boolean; error?: string }> = [];
  if (cfg.telegram.enabled && cfg.telegram.chats.length) {
    const token = await telegramToken();
    const msg = [`<b>NoPaper · ${escapeHtml(org?.name ?? '')}</b>`, `📎 ${escapeHtml(title)} pela área do contador:`, ...docs.map((d) => `• ${escapeHtml(line(d))}`), `<a href="${url}">Conferir e lançar</a>`].join('\n');
    for (const c of cfg.telegram.chats) {
      try {
        if (!token) throw new Error('Bot do Telegram não configurado pelo administrador da plataforma');
        await telegramSend(token, c.id, msg);
        results.push({ channel: 'telegram', target: c.name, ok: true });
      } catch (e) { results.push({ channel: 'telegram', target: c.name, ok: false, error: (e as Error).message }); }
    }
  }
  if (cfg.email.enabled && cfg.email.recipients.length) {
    const html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:600px;margin:0 auto;color:#141a29">
<h2 style="margin:0 0 4px;font-size:20px">${escapeHtml(org?.name ?? 'NoPaper')}</h2><p style="margin:0 0 16px;color:#5b6478">${escapeHtml(title)} pela área do contador.</p>
<ul style="padding-left:18px;font-size:14px">${docs.map((d) => `<li style="margin:4px 0">${escapeHtml(line(d))} <span style="color:#8a93a8">— ${escapeHtml(d.originalName)}</span></li>`).join('')}</ul>
<p style="margin:16px 0 0"><a href="${url}" style="color:#5b4be8">Conferir e lançar</a></p></div>`;
    const textBody = [`${org?.name ?? 'NoPaper'} — ${title} pela área do contador.`, ...docs.map((d) => `  - ${line(d)} — ${d.originalName}`), url].join('\n');
    try {
      await sendEmail(cfg.email.recipients, `NoPaper · ${org?.name ?? ''}: ${title}`, html, textBody);
      results.push({ channel: 'email', target: cfg.email.recipients.join(', '), ok: true });
    } catch (e) { results.push({ channel: 'email', target: cfg.email.recipients.join(', '), ok: false, error: (e as Error).message }); }
  }
  if (results.length) {
    await db.insert(schema.alertDeliveries).values(results.map((r) => ({
      orgId, channel: r.channel, target: r.target.slice(0, 200), status: r.ok ? 'ok' : 'error', items: docs.length, test: false, error: r.error?.slice(0, 1000) ?? null,
    })));
  }
}

export default async function accountingRoutes(app: FastifyInstance) {
  /** Selos do menu: documentos do contador esperando conferência; e, para o contador, o que o espaço mandou e ele ainda não viu. */
  app.get('/api/accounting/summary', any, async (req) => {
    const t = schema.accountingDocuments;
    const count = async (direction: string) => (await db.select({ n: sql<number>`count(*)::int` }).from(t)
      .where(and(eq(t.orgId, req.org!.id), eq(t.direction, direction), eq(t.status, 'new'), isNull(t.hiddenAt))))[0]!.n;
    const can = req.org!.can;
    return {
      pending: can('accounting.review') ? await count('to_client') : 0,
      inbox: can('accounting.upload') && !can('accounting.send') ? await count('to_accountant') : 0,
    };
  });

  app.get<{ Querystring: { direction?: string } }>('/api/accounting/documents', any, async (req) => {
    const t = schema.accountingDocuments;
    const can = req.org!.can;
    const outbound = req.query.direction === 'to_accountant';
    // de que lado a pessoa vê esta lista (ver sideOf)
    const side: Side | null = outbound ? (can('accounting.send') ? 'sender' : can('accounting.upload') ? 'recipient' : null)
      : can('accounting.review') ? 'recipient' : can('accounting.upload') ? 'sender' : null;
    if (!side) throw forbidden();
    const rows = await db.select().from(t)
      .where(and(
        eq(t.orgId, req.org!.id), eq(t.direction, outbound ? 'to_accountant' : 'to_client'),
        // quem enviou vê o registro fiel do que mandou (mesmo o que o outro lado tirou da lista dele)
        side === 'sender' ? isNull(t.uploaderRemovedAt) : isNull(t.hiddenAt),
        side === 'sender' && !outbound ? eq(t.uploadedBy, req.user!.id) : undefined,
      )).orderBy(desc(t.createdAt)).limit(3000);
    const userIds = [...new Set(rows.flatMap((r) => [r.uploadedBy, r.handledBy]).filter((x): x is string => !!x))];
    const users = userIds.length ? await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, userIds)) : [];
    const uname = new Map(users.map((u) => [u.id, u.name]));
    // a conta ligada só aparece para quem confere (o contador não vê as contas do espaço)
    const billIds = !outbound && side === 'recipient' ? rows.map((r) => r.billId).filter((x): x is string => !!x) : [];
    const bills = billIds.length ? await db.select({ id: schema.bills.id, description: schema.bills.description, status: schema.bills.status, dueDate: schema.bills.dueDate, amount: schema.bills.amount })
      .from(schema.bills).where(inArray(schema.bills.id, billIds)) : [];
    const bmap = new Map(bills.map((b) => [b.id, b]));
    return {
      items: rows.map(({ storageKey: _k, sha256: _s, hiddenBy, ...r }) => ({
        hiddenByMe: !!r.hiddenAt && hiddenBy === req.user!.id,
        ...r, uploadedByName: r.uploadedBy ? uname.get(r.uploadedBy) ?? null : null, handledByName: r.handledBy ? uname.get(r.handledBy) ?? null : null,
        bill: r.billId ? bmap.get(r.billId) ?? null : null, mine: r.uploadedBy === req.user!.id,
      })),
    };
  });

  const store = async (req: FastifyRequest, files: Array<{ buf: Buffer; mime: string; filename: string }>, base: { direction: string; kind: AccountingKind; competence: string | null; note: string | null }, withDetect: boolean) => {
    const saved: string[] = [];
    try {
      const values = [];
      for (const f of files) {
        const { key, sha256 } = await saveFile(req.org!.id, f.buf, EXT[f.mime]!);
        saved.push(key);
        values.push({
          orgId: req.org!.id, ...base, originalName: f.filename, mime: f.mime, size: f.buf.length, storageKey: key, sha256,
          detected: withDetect ? await detect(base.kind, f.buf, f.mime, f.filename) : null, uploadedBy: req.user!.id,
        });
      }
      return await db.insert(schema.accountingDocuments).values(values).returning();
    } catch (e) {
      for (const k of saved) await deleteFile(k);
      throw e;
    }
  };

  /** Contador → espaço: campos (tipo, mês, observação) + um ou mais arquivos no mesmo pedido. */
  app.post('/api/accounting/documents', { preHandler: requirePerm('accounting.upload') }, async (req) => {
    const { fields, files } = await readUpload(req);
    const body = parse(accountingUploadSchema, fields);
    if (body.kind === 'payslip' && files.some((f) => f.mime !== 'application/pdf')) throw badRequest('Os holerites precisam ser enviados em PDF (o arquivo original do sistema de folha).');
    const docs = await store(req, files, { direction: 'to_client', kind: body.kind, competence: body.competence ?? null, note: body.note }, true);
    await audit(req, {
      action: 'accounting.upload', entityType: 'accounting_document', entityId: docs[0]!.id,
      description: `Enviou ${docs.length === 1 ? `o documento "${docs[0]!.originalName}"` : `${docs.length} documentos`} (${ACCOUNTING_KIND_LABEL[body.kind]}${body.competence ? ` – ${refLabelPT(body.competence)}` : ''}) pela área do contador`,
      details: { kind: body.kind, competence: body.competence ?? null, files: docs.map((d) => d.originalName) },
    });
    // o aviso não segura a resposta nem derruba o envio
    void notifyUpload(req.org!.id, req.user!.name, docs).catch((e) => req.log.error({ err: e }, 'aviso da área do contador falhou'));
    return { created: docs.length };
  });

  /**
   * Espaço → contador: notas fiscais e outros arquivos (até ACCOUNTING_MAX_UPLOAD_MB cada, gravados
   * direto no disco). O contador vê na caixa "Recebidos" dele.
   */
  app.post('/api/accounting/outbox', { preHandler: requirePerm('accounting.send') }, async (req) => {
    const max = env.ACCOUNTING_MAX_UPLOAD_MB;
    const fields: Record<string, string> = {};
    const saved: Array<{ key: string; sha256: string; size: number; mime: string; filename: string }> = [];
    const sniff = (head: Buffer) => { const mime = sniffMime(head) ?? sniffArchive(head); return mime && EXT[mime] ? { mime, ext: EXT[mime]! } : null; };
    let docs: Doc[];
    try {
      for await (const part of req.parts({ limits: { fileSize: max * 1024 * 1024, files: MAX_FILES } })) {
        if (part.type === 'field') { fields[part.fieldname] = String(part.value ?? ''); continue; }
        const filename = (part.filename || 'arquivo').slice(0, 200);
        const r = await saveUploadStream(req.org!.id, part.file, sniff);
        if (r.ok) saved.push({ ...r, filename });
        if (part.file.truncated) throw badRequest(`"${filename}" é maior que ${max} MB`);
        if (!r.ok) throw badRequest(r.size ? `"${filename}": formato não suportado. Envie PDF, imagem, XML ou arquivo compactado (ZIP, RAR, 7z).` : `"${filename}" está vazio`);
      }
      if (!saved.length) throw badRequest('Escolha ao menos um arquivo');
      const body = parse(accountingSendSchema, fields);
      docs = await db.insert(schema.accountingDocuments).values(saved.map((f) => ({
        orgId: req.org!.id, direction: 'to_accountant', kind: body.kind, competence: body.competence ?? null, note: body.note,
        originalName: f.filename, mime: f.mime, size: f.size, storageKey: f.key, sha256: f.sha256, detected: null, uploadedBy: req.user!.id,
      }))).returning();
    } catch (e) {
      for (const f of saved) await deleteFile(f.key);
      throw e;
    }
    await audit(req, {
      action: 'accounting.send', entityType: 'accounting_document', entityId: docs[0]!.id,
      description: `Enviou ${docs.length === 1 ? `"${docs[0]!.originalName}"` : `${docs.length} arquivos`} para o contador (${ACCOUNTING_KIND_LABEL[docs[0]!.kind as AccountingKind]}${docs[0]!.competence ? ` – ${refLabelPT(docs[0]!.competence)}` : ''})`,
      details: { kind: docs[0]!.kind, competence: docs[0]!.competence, files: docs.map((d) => d.originalName) },
    });
    return { created: docs.length };
  });

  /**
   * Quem recebe marca o que fez com o documento. Do contador: lançado (com a conta criada, se houver),
   * dispensado ou de volta para "novo". Para o contador: recebido ou de volta para "novo".
   */
  app.put<{ Params: { id: string } }>('/api/accounting/documents/:id', any, async (req) => {
    const body = parse(accountingHandleSchema, req.body);
    const { d, side } = await loadDoc(req, req.params.id);
    if (side !== 'recipient') throw forbidden('Só quem recebeu o documento marca a situação dele.');
    const outbound = d.direction === 'to_accountant';
    if (outbound && (body.status === 'dismissed' || body.billId)) throw badRequest('Situação inválida para este documento');
    if (body.billId) {
      const [b] = await db.select({ id: schema.bills.id }).from(schema.bills).where(and(eq(schema.bills.id, body.billId), eq(schema.bills.orgId, req.org!.id)));
      if (!b) throw badRequest('Conta inválida');
    }
    const handled = body.status !== 'new';
    if (d.status === body.status && !body.billId) return { ok: true };
    const [u] = await db.update(schema.accountingDocuments).set({
      status: body.status, billId: body.status === 'done' ? body.billId ?? d.billId : null, handleNote: handled ? body.note : null,
      handledBy: handled ? req.user!.id : null, handledAt: handled ? new Date() : null,
    }).where(eq(schema.accountingDocuments.id, d.id)).returning();
    await audit(req, {
      action: 'accounting.handle', entityType: 'accounting_document', entityId: d.id,
      description: outbound ? `${body.status === 'done' ? 'Recebeu' : 'Voltou para não visto'} o arquivo "${d.originalName}" enviado ao contador`
        : `${body.status === 'done' ? 'Marcou como lançado' : body.status === 'dismissed' ? 'Dispensou' : 'Voltou para novo'} o documento do contador "${d.originalName}"`,
      details: { changes: { status: { from: d.status, to: u.status }, ...(u.billId !== d.billId ? { billId: { from: d.billId, to: u.billId } } : {}) } },
    });
    return { ok: true };
  });

  /**
   * Remover. Cada lado tira o documento da própria lista:
   * - quem recebeu: some para ele; quem enviou continua com o registro e o arquivo no histórico;
   * - quem enviou: some do histórico dele; se o outro lado ainda não viu/conferiu, some também para
   *   ele (envio cancelado); se já viu, o outro lado continua com o documento.
   * Quando os dois lados já tiraram, a linha e o arquivo são apagados de vez.
   */
  app.delete<{ Params: { id: string } }>('/api/accounting/documents/:id', any, async (req) => {
    const { d, side } = await loadDoc(req, req.params.id);
    const now = new Date();
    const next = side === 'recipient'
      ? { hiddenAt: d.hiddenAt ?? now, hiddenBy: d.hiddenBy ?? req.user!.id, uploaderRemovedAt: d.uploaderRemovedAt }
      : { hiddenAt: d.hiddenAt ?? (d.status === 'new' ? now : null), hiddenBy: d.hiddenBy ?? (d.status === 'new' ? req.user!.id : null), uploaderRemovedAt: now };
    const gone = !!next.hiddenAt && !!next.uploaderRemovedAt;
    if (gone) {
      await db.delete(schema.accountingDocuments).where(eq(schema.accountingDocuments.id, d.id));
      await deleteFile(d.storageKey);
    } else await db.update(schema.accountingDocuments).set(next).where(eq(schema.accountingDocuments.id, d.id));
    const what = d.direction === 'to_accountant' ? 'arquivo enviado ao contador' : 'documento do contador';
    await audit(req, {
      action: side === 'recipient' ? 'accounting.remove' : 'accounting.cancel', entityType: 'accounting_document', entityId: d.id,
      description: side === 'recipient' ? `Tirou da lista o ${what} "${d.originalName}"`
        : d.status === 'new' ? `Removeu o ${what} "${d.originalName}" que tinha enviado (o outro lado ainda não tinha visto)` : `Tirou do próprio histórico o ${what} "${d.originalName}" (o outro lado continua com ele)`,
      details: { kind: d.kind, competence: d.competence, status: d.status, direction: d.direction, deletedForGood: gone },
    });
    return { ok: true };
  });

  /** Lê os holerites de um documento enviado (mesma resposta de /api/payroll/payslips/read). */
  app.post<{ Params: { id: string } }>('/api/accounting/documents/:id/payslips', { preHandler: [requirePerm('accounting.review'), requirePerm('payroll.edit')] }, async (req) => {
    const { d, side } = await loadDoc(req, req.params.id);
    if (side !== 'recipient' || d.direction !== 'to_client') throw notFound('Documento não encontrado');
    if (req.org!.kind !== 'company') throw badRequest('A folha de pagamento só está disponível em espaços do tipo Empresa.', 'company_only');
    if (d.mime !== 'application/pdf') throw badRequest('Este documento não é um PDF.');
    let cells;
    try { cells = await pdfToCells(await readStoredFile(d.storageKey), 200); } catch { throw badRequest('Não consegui ler este PDF.'); }
    const report = parsePayslips(cells);
    if (!report.slips.length) throw badRequest('Não achei holerites neste PDF. Ele precisa ser o PDF original do sistema de folha, não uma foto ou digitalização.', 'payslips_unknown');
    return { fileName: d.originalName, report };
  });

  /** URL assinada (10 min) para ver/baixar. */
  app.get<{ Params: { id: string } }>('/api/accounting/documents/:id/url', any, async (req) => {
    const { d } = await loadDoc(req, req.params.id);
    const t = signFileToken(tokenId(d.id));
    return { url: `/api/accounting/files/${d.id}?t=${t}`, downloadUrl: `/api/accounting/files/${d.id}?t=${t}&download=1`, name: d.originalName, mime: d.mime, previewable: previewable(d.mime) };
  });

  app.get<{ Params: { id: string }; Querystring: { t?: string; download?: string } }>('/api/accounting/files/:id', async (req, reply) => {
    if (!req.query.t || !verifyFileToken(tokenId(req.params.id), req.query.t)) throw new HttpError(401, 'Link expirado');
    const [d] = await db.select().from(schema.accountingDocuments).where(eq(schema.accountingDocuments.id, req.params.id));
    if (!d) throw notFound();
    reply.header('Content-Type', d.mime)
      // compactados e XML nunca abrem no navegador (XML pode carregar script): sempre download
      .header('Content-Disposition', `${req.query.download === '1' || !previewable(d.mime) ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(d.originalName)}`)
      .header('Cache-Control', 'private, max-age=600')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cross-Origin-Resource-Policy', 'same-origin');
    if (d.mime !== 'application/pdf') reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:");
    return reply.send(streamStoredFile(d.storageKey));
  });
}
