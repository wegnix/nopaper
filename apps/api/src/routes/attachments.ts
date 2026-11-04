import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { ATTACHMENT_SLOTS, ATTACHMENT_SLOT_LABEL, billPerm, type AttachmentSlot, type BillType } from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { env } from '../env.js';
import { badRequest, forbidden, HttpError, notFound } from '../lib/errors.js';
import { requireOrg } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { ALLOWED_UPLOADS, saveFile, deleteFile, sniffMime, signFileToken, verifyFileToken, streamStoredFile } from '../lib/storage.js';
import { loadBill, serialize, attachmentsFor, restrictedCategoryIds } from '../services/bills.js';
import { classifyDocument } from '../services/classifier.js';

async function readUpload(req: FastifyRequest) {
  const file = await req.file({ limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });
  if (!file) throw badRequest('Envie um arquivo');
  const buf = await file.toBuffer();
  if (file.file.truncated) throw badRequest(`Arquivo maior que ${env.MAX_UPLOAD_MB} MB`);
  if (!buf.length) throw badRequest('Arquivo vazio');
  const mime = sniffMime(buf);
  if (!mime || !ALLOWED_UPLOADS[mime]) throw badRequest('Formato não suportado. Envie PDF, PNG, JPG ou WEBP.');
  return { buf, mime, filename: (file.filename || 'arquivo').slice(0, 200) };
}

export default async function attachmentRoutes(app: FastifyInstance) {
  /** Analisa um documento sem salvar (usado no formulário de nova conta para auto-preencher). */
  app.post('/api/documents/analyze', { preHandler: requireOrg }, async (req) => {
    const { buf, mime, filename } = await readUpload(req);
    return classifyDocument(buf, mime, filename);
  });

  app.post<{ Params: { id: string }; Querystring: { slot?: string } }>('/api/bills/:id/attachments', { preHandler: requireOrg }, async (req) => {
    // comprovante: quem dá baixa ou edita; boleto/nota: quem cadastra ou edita (o "auto" é conferido depois)
    const requested = req.query.slot ?? 'auto';
    const b = await loadBill(req, req.params.id, requested === 'payment_proof' ? ['pay', 'edit'] : requested === 'auto' ? ['create', 'edit', 'pay'] : ['create', 'edit']);
    const { buf, mime, filename } = await readUpload(req);
    let slot: AttachmentSlot;
    let classification = null;
    if (requested === 'auto') {
      classification = await classifyDocument(buf, mime, filename);
      if (classification.kind === 'unknown') {
        throw new HttpError(422, 'Não consegui identificar automaticamente o tipo do arquivo. Escolha manualmente.', 'classification_unknown', { reasons: classification.reasons });
      }
      slot = classification.kind;
    } else if ((ATTACHMENT_SLOTS as readonly string[]).includes(requested)) {
      slot = requested as AttachmentSlot;
    } else throw badRequest('Tipo de anexo inválido');
    const t = b.type as BillType;
    const okSlot = slot === 'payment_proof'
      ? req.org!.can(billPerm(t, 'pay')) || req.org!.can(billPerm(t, 'edit'))
      : req.org!.can(billPerm(t, 'create')) || req.org!.can(billPerm(t, 'edit'));
    if (!okSlot) throw forbidden(`Sem permissão para anexar ${ATTACHMENT_SLOT_LABEL[slot].toLowerCase()} nesta conta`);

    const { key, sha256 } = await saveFile(b.orgId, buf, ALLOWED_UPLOADS[mime]);
    const [old] = await db.select().from(schema.attachments).where(and(eq(schema.attachments.billId, b.id), eq(schema.attachments.slot, slot)));
    await db.transaction(async (tx) => {
      if (old) await tx.delete(schema.attachments).where(eq(schema.attachments.id, old.id));
      await tx.insert(schema.attachments).values({
        orgId: b.orgId, billId: b.id, slot, originalName: filename, mime, size: buf.length, storageKey: key, sha256, createdBy: req.user!.id,
      });
      if (classification?.barcode && !b.barcode && slot === 'boleto') {
        await tx.update(schema.bills).set({ barcode: classification.barcode }).where(eq(schema.bills.id, b.id));
      }
      if (classification?.pixCode && !b.pixKey && slot === 'boleto') {
        await tx.update(schema.bills).set({ pixKey: classification.pixCode }).where(eq(schema.bills.id, b.id));
      }
    });
    if (old) await deleteFile(old.storageKey);
    const restricted = (await restrictedCategoryIds(b.orgId)).includes(b.categoryId);
    await audit(req, { action: `${b.type}.attach.${slot}`, entityType: 'bill', entityId: b.id, description: `Anexou ${ATTACHMENT_SLOT_LABEL[slot]} em "${b.description}"`, details: { filename, size: buf.length, auto: requested === 'auto', classification, restricted } });
    const [fresh] = await db.select().from(schema.bills).where(eq(schema.bills.id, b.id));
    return { bill: serialize(fresh, (await attachmentsFor([b.id])).get(b.id)), classification, slot };
  });

  app.delete<{ Params: { id: string; slot: string } }>('/api/bills/:id/attachments/:slot', { preHandler: requireOrg }, async (req) => {
    const b = await loadBill(req, req.params.id, req.params.slot === 'payment_proof' ? ['pay', 'edit'] : 'edit');
    const [a] = await db.delete(schema.attachments).where(and(eq(schema.attachments.billId, b.id), eq(schema.attachments.slot, req.params.slot))).returning();
    if (!a) throw notFound('Anexo não encontrado');
    await deleteFile(a.storageKey);
    const restricted = (await restrictedCategoryIds(b.orgId)).includes(b.categoryId);
    await audit(req, { action: `${b.type}.detach.${a.slot}`, entityType: 'bill', entityId: b.id, description: `Removeu anexo de "${b.description}"`, details: { filename: a.originalName, restricted } });
    return serialize(b, (await attachmentsFor([b.id])).get(b.id));
  });

  /** Gera URL assinada (10 min) para visualizar/baixar um anexo. */
  app.get<{ Params: { id: string } }>('/api/attachments/:id/url', { preHandler: requireOrg }, async (req) => {
    const [a] = await db.select().from(schema.attachments).where(and(eq(schema.attachments.id, req.params.id), eq(schema.attachments.orgId, req.org!.id)));
    if (!a) throw notFound('Anexo não encontrado');
    await loadBill(req, a.billId); // checa permissão/restrição
    const t = signFileToken(a.id);
    return { url: `/api/files/${a.id}?t=${t}`, downloadUrl: `/api/files/${a.id}?t=${t}&download=1`, name: a.originalName, mime: a.mime };
  });

  app.get<{ Params: { id: string }; Querystring: { t?: string; download?: string } }>('/api/files/:id', async (req, reply) => {
    if (!req.query.t || !verifyFileToken(req.params.id, req.query.t)) throw new HttpError(401, 'Link expirado');
    const [a] = await db.select().from(schema.attachments).where(eq(schema.attachments.id, req.params.id));
    if (!a) throw notFound();
    const disp = req.query.download === '1' ? 'attachment' : 'inline';
    reply.header('Content-Type', a.mime)
      .header('Content-Disposition', `${disp}; filename*=UTF-8''${encodeURIComponent(a.originalName)}`)
      .header('Cache-Control', 'private, max-age=600')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cross-Origin-Resource-Policy', 'same-origin');
    if (a.mime !== 'application/pdf') reply.header('Content-Security-Policy', "default-src 'none'; img-src 'self' data:");
    return reply.send(streamStoredFile(a.storageKey));
  });
}
