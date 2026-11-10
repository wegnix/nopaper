import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  ACCOUNTING_KIND_LABEL, accountingHandleSchema, accountingUploadSchema, formatBRL, formatDateBR, parseBoleto, parsePayslips, refLabelPT,
  type AccountingDetected, type AccountingKind,
} from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { env } from '../env.js';
import { parse } from '../lib/validate.js';
import { badRequest, forbidden, HttpError, notFound } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { ALLOWED_UPLOADS, deleteFile, readStoredFile, saveFile, signFileToken, sniffMime, streamStoredFile, verifyFileToken } from '../lib/storage.js';
import { classifyDocument } from '../services/classifier.js';
import { pdfToCells } from '../services/pdf.js';
import { loadAlertConfig } from '../services/alerts.js';
import { escapeHtml, sendEmail, telegramSend, telegramToken } from '../services/notify.js';

type Doc = typeof schema.accountingDocuments.$inferSelect;
const MAX_FILES = 20;
/** Os links assinados dos documentos não valem para os anexos das contas (e vice-versa). */
const tokenId = (id: string) => `acc:${id}`;
const any = { preHandler: requirePerm('accounting.upload', 'accounting.review') };
const review = { preHandler: requirePerm('accounting.review') };

/** Quem só envia vê (e mexe) apenas no que enviou. */
async function loadDoc(req: FastifyRequest, id: string): Promise<Doc> {
  const [d] = await db.select().from(schema.accountingDocuments).where(and(eq(schema.accountingDocuments.id, id), eq(schema.accountingDocuments.orgId, req.org!.id)));
  const mine = d?.uploadedBy === req.user!.id;
  if (!d || (!req.org!.can('accounting.review') && !mine)) throw notFound('Documento não encontrado');
  const reviewer = req.org!.can('accounting.review');
  // cada lado só enxerga o que ainda está na lista dele
  if (reviewer ? !!d.hiddenAt && !(mine && !d.uploaderRemovedAt) : !!d.uploaderRemovedAt) throw notFound('Documento não encontrado');
  return d;
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
  /** Quantos documentos esperam conferência (selo no menu). */
  app.get('/api/accounting/summary', any, async (req) => {
    if (!req.org!.can('accounting.review')) return { pending: 0 };
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.accountingDocuments)
      .where(and(eq(schema.accountingDocuments.orgId, req.org!.id), eq(schema.accountingDocuments.status, 'new'), isNull(schema.accountingDocuments.hiddenAt)));
    return { pending: n };
  });

  app.get('/api/accounting/documents', any, async (req) => {
    const t = schema.accountingDocuments;
    const mineOnly = !req.org!.can('accounting.review');
    const rows = await db.select().from(t)
      // quem só envia: o registro fiel de tudo o que enviou (inclusive o que o espaço tirou da lista dele)
      .where(and(eq(t.orgId, req.org!.id), mineOnly ? and(eq(t.uploadedBy, req.user!.id), isNull(t.uploaderRemovedAt)) : isNull(t.hiddenAt)))
      .orderBy(desc(t.createdAt)).limit(mineOnly ? 3000 : 1000);
    const userIds = [...new Set(rows.flatMap((r) => [r.uploadedBy, r.handledBy]).filter((x): x is string => !!x))];
    const users = userIds.length ? await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, userIds)) : [];
    const uname = new Map(users.map((u) => [u.id, u.name]));
    // a conta ligada só aparece para quem confere (o contador não vê as contas do espaço)
    const billIds = mineOnly ? [] : rows.map((r) => r.billId).filter((x): x is string => !!x);
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

  /** Envio: campos (tipo, competência, observação) + um ou mais arquivos no mesmo pedido. */
  app.post('/api/accounting/documents', { preHandler: requirePerm('accounting.upload') }, async (req) => {
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
    const body = parse(accountingUploadSchema, fields);
    if (body.kind === 'payslip' && files.some((f) => f.mime !== 'application/pdf')) throw badRequest('Os holerites precisam ser enviados em PDF (o arquivo original do sistema de folha).');
    const saved: string[] = [];
    let docs: Doc[];
    try {
      const values = [];
      for (const f of files) {
        const { key, sha256 } = await saveFile(req.org!.id, f.buf, ALLOWED_UPLOADS[f.mime]);
        saved.push(key);
        values.push({
          orgId: req.org!.id, kind: body.kind, competence: body.competence ?? null, note: body.note, originalName: f.filename, mime: f.mime, size: f.buf.length,
          storageKey: key, sha256, detected: await detect(body.kind, f.buf, f.mime, f.filename), uploadedBy: req.user!.id,
        });
      }
      docs = await db.insert(schema.accountingDocuments).values(values).returning();
    } catch (e) {
      for (const k of saved) await deleteFile(k);
      throw e;
    }
    await audit(req, {
      action: 'accounting.upload', entityType: 'accounting_document', entityId: docs[0]!.id,
      description: `Enviou ${docs.length === 1 ? `o documento "${docs[0]!.originalName}"` : `${docs.length} documentos`} (${ACCOUNTING_KIND_LABEL[body.kind]}${body.competence ? ` – ${refLabelPT(body.competence)}` : ''}) pela área do contador`,
      details: { kind: body.kind, competence: body.competence ?? null, files: docs.map((d) => d.originalName) },
    });
    // o aviso não segura a resposta nem derruba o envio
    void notifyUpload(req.org!.id, req.user!.name, docs).catch((e) => req.log.error({ err: e }, 'aviso da área do contador falhou'));
    return { created: docs.length };
  });

  /** Marca como lançado (com a conta criada, se houver), dispensa ou volta para "novo". */
  app.put<{ Params: { id: string } }>('/api/accounting/documents/:id', review, async (req) => {
    const body = parse(accountingHandleSchema, req.body);
    const d = await loadDoc(req, req.params.id);
    if (d.hiddenAt) throw notFound('Documento não encontrado');
    if (body.billId) {
      const [b] = await db.select({ id: schema.bills.id }).from(schema.bills).where(and(eq(schema.bills.id, body.billId), eq(schema.bills.orgId, req.org!.id)));
      if (!b) throw badRequest('Conta inválida');
    }
    const handled = body.status !== 'new';
    const [u] = await db.update(schema.accountingDocuments).set({
      status: body.status, billId: body.status === 'done' ? body.billId ?? d.billId : null, handleNote: handled ? body.note : null,
      handledBy: handled ? req.user!.id : null, handledAt: handled ? new Date() : null,
    }).where(eq(schema.accountingDocuments.id, d.id)).returning();
    await audit(req, {
      action: 'accounting.handle', entityType: 'accounting_document', entityId: d.id,
      description: `${body.status === 'done' ? 'Marcou como lançado' : body.status === 'dismissed' ? 'Dispensou' : 'Voltou para novo'} o documento do contador "${d.originalName}"`,
      details: { changes: { status: { from: d.status, to: u.status }, ...(u.billId !== d.billId ? { billId: { from: d.billId, to: u.billId } } : {}) } },
    });
    return { ok: true };
  });

  /**
   * Remover. Cada lado tira o documento da própria lista:
   * - quem confere: some para ele; quem enviou continua com o registro e o arquivo no histórico;
   * - quem enviou: some do histórico dele; se ninguém conferiu ainda, some também para quem confere
   *   (envio cancelado); se já foi conferido/lançado, quem confere continua com o documento.
   * Quando os dois lados já tiraram, a linha e o arquivo são apagados de vez.
   */
  app.delete<{ Params: { id: string } }>('/api/accounting/documents/:id', any, async (req) => {
    const d = await loadDoc(req, req.params.id);
    const reviewer = req.org!.can('accounting.review');
    const now = new Date();
    const next = reviewer
      ? { hiddenAt: d.hiddenAt ?? now, hiddenBy: d.hiddenBy ?? req.user!.id, uploaderRemovedAt: d.uploaderRemovedAt }
      : { hiddenAt: d.hiddenAt ?? (d.status === 'new' ? now : null), hiddenBy: d.hiddenBy ?? (d.status === 'new' ? req.user!.id : null), uploaderRemovedAt: now };
    const gone = !!next.hiddenAt && !!next.uploaderRemovedAt;
    if (gone) {
      await db.delete(schema.accountingDocuments).where(eq(schema.accountingDocuments.id, d.id));
      await deleteFile(d.storageKey);
    } else await db.update(schema.accountingDocuments).set(next).where(eq(schema.accountingDocuments.id, d.id));
    await audit(req, {
      action: reviewer ? 'accounting.remove' : 'accounting.cancel', entityType: 'accounting_document', entityId: d.id,
      description: reviewer ? `Tirou da lista o documento do contador "${d.originalName}"`
        : d.status === 'new' ? `Removeu o documento "${d.originalName}" que tinha enviado (ainda não conferido)` : `Tirou do próprio histórico o documento "${d.originalName}" (já conferido; continua com o espaço)`,
      details: { kind: d.kind, competence: d.competence, status: d.status, deletedForGood: gone },
    });
    return { ok: true };
  });

  /** Lê os holerites de um documento enviado (mesma resposta de /api/payroll/payslips/read). */
  app.post<{ Params: { id: string } }>('/api/accounting/documents/:id/payslips', { preHandler: [requirePerm('accounting.review'), requirePerm('payroll.edit')] }, async (req) => {
    const d = await loadDoc(req, req.params.id);
    if (d.hiddenAt) throw notFound('Documento não encontrado');
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
    const d = await loadDoc(req, req.params.id);
    const t = signFileToken(tokenId(d.id));
    return { url: `/api/accounting/files/${d.id}?t=${t}`, downloadUrl: `/api/accounting/files/${d.id}?t=${t}&download=1`, name: d.originalName, mime: d.mime };
  });

  app.get<{ Params: { id: string }; Querystring: { t?: string; download?: string } }>('/api/accounting/files/:id', async (req, reply) => {
    if (!req.query.t || !verifyFileToken(tokenId(req.params.id), req.query.t)) throw new HttpError(401, 'Link expirado');
    const [d] = await db.select().from(schema.accountingDocuments).where(eq(schema.accountingDocuments.id, req.params.id));
    if (!d) throw notFound();
    reply.header('Content-Type', d.mime)
      .header('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(d.originalName)}`)
      .header('Cache-Control', 'private, max-age=600')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cross-Origin-Resource-Policy', 'same-origin');
    if (d.mime !== 'application/pdf') reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:");
    return reply.send(streamStoredFile(d.storageKey));
  });
}
