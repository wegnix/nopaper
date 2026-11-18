import type { FastifyInstance, FastifyRequest } from 'fastify';
import { asc, eq, inArray } from 'drizzle-orm';
import { MANUAL_MAX_MB, manualSchema, manualVisible, type ManualViewer } from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { parse } from '../lib/validate.js';
import { badRequest, HttpError, notFound } from '../lib/errors.js';
import { loadOrgContext, requireAuth, requireSuperadmin } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { deleteFile, MANUALS_DIR, saveUploadStream, signFileToken, sniffMime, streamStoredFile, verifyFileToken } from '../lib/storage.js';

/**
 * Manuais do sistema (PDF). O administrador da plataforma envia e diz para quem cada um aparece;
 * cada pessoa vê, pelo "?" do cabeçalho, os manuais do seu público no espaço em que está.
 * Os arquivos ficam em STORAGE_DIR/manuais (entram no backup junto com os anexos).
 */
type Manual = typeof schema.manuals.$inferSelect;
const DIR = MANUALS_DIR;
/** Os links assinados dos manuais não valem para anexos nem para documentos do contador. */
const tokenId = (id: string) => `man:${id}`;
const guard = { preHandler: [requireAuth, requireSuperadmin] };
const sniffPdf = (head: Buffer) => (sniffMime(head) === 'application/pdf' ? { mime: 'application/pdf', ext: 'pdf' } : null);

/** Quem está olhando: as permissões no espaço atual (sem espaço = só "todos" e "plataforma"). */
async function viewerOf(req: FastifyRequest): Promise<ManualViewer> {
  const orgId = req.headers['x-org-id'];
  const ctx = typeof orgId === 'string' && /^[0-9a-f-]{36}$/i.test(orgId) ? await loadOrgContext(req.user!.id, orgId) : null;
  return { can: (p) => ctx?.can(p) ?? false, isAdmin: ctx?.isAdmin ?? false, isSuperadmin: !!req.user!.isSuperadmin };
}
const pub = (m: Manual) => ({ id: m.id, title: m.title, description: m.description, size: m.size, updatedAt: m.updatedAt });

/** Lê o multipart: campos + no máximo um PDF (gravado direto no disco). */
async function readUpload(req: FastifyRequest) {
  const fields: Record<string, string> = {};
  let file: { key: string; sha256: string; size: number; filename: string } | null = null;
  try {
    for await (const part of req.parts({ limits: { fileSize: MANUAL_MAX_MB * 1024 * 1024, files: 1 } })) {
      if (part.type === 'field') { fields[part.fieldname] = String(part.value ?? ''); continue; }
      const filename = (part.filename || 'manual.pdf').slice(0, 200);
      const r = await saveUploadStream(DIR, part.file, sniffPdf);
      if (r.ok) file = { key: r.key, sha256: r.sha256, size: r.size, filename };
      if (part.file.truncated) throw badRequest(`O arquivo é maior que ${MANUAL_MAX_MB} MB. Exporte o PDF com imagens mais leves.`);
      if (!r.ok) throw badRequest(r.size ? 'O manual precisa ser um arquivo PDF.' : 'O arquivo está vazio.');
    }
  } catch (e) {
    if (file) await deleteFile(file.key);
    throw e;
  }
  return { fields, file };
}
function parseFields(fields: Record<string, string>) {
  let audiences: unknown = [];
  try { audiences = JSON.parse(fields.audiences || '[]'); } catch { throw badRequest('Lista de públicos inválida'); }
  return parse(manualSchema, { title: fields.title, description: fields.description, audiences });
}

export default async function manualRoutes(app: FastifyInstance) {
  /** Manuais que aparecem para quem está logado, no espaço atual. */
  app.get('/api/manuals', { preHandler: requireAuth }, async (req) => {
    const v = await viewerOf(req);
    const rows = await db.select().from(schema.manuals).orderBy(asc(schema.manuals.title));
    return { items: rows.filter((m) => manualVisible(m.audiences, v)).map(pub) };
  });

  /** URL assinada (10 min) para ver/baixar. */
  app.get<{ Params: { id: string } }>('/api/manuals/:id/url', { preHandler: requireAuth }, async (req) => {
    const [m] = await db.select().from(schema.manuals).where(eq(schema.manuals.id, req.params.id));
    // o administrador da plataforma abre qualquer manual (é ele quem publica), mesmo fora do público marcado
    if (!m || !(req.user!.isSuperadmin || manualVisible(m.audiences, await viewerOf(req)))) throw notFound('Manual não encontrado');
    const t = signFileToken(tokenId(m.id));
    return { url: `/api/manuals/files/${m.id}?t=${t}`, downloadUrl: `/api/manuals/files/${m.id}?t=${t}&download=1`, name: m.originalName, mime: 'application/pdf' };
  });

  app.get<{ Params: { id: string }; Querystring: { t?: string; download?: string } }>('/api/manuals/files/:id', async (req, reply) => {
    if (!req.query.t || !verifyFileToken(tokenId(req.params.id), req.query.t)) throw new HttpError(401, 'Link expirado');
    const [m] = await db.select().from(schema.manuals).where(eq(schema.manuals.id, req.params.id));
    if (!m) throw notFound();
    reply.header('Content-Type', 'application/pdf')
      .header('Content-Disposition', `${req.query.download === '1' ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(m.originalName)}`)
      .header('Cache-Control', 'private, max-age=600')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Cross-Origin-Resource-Policy', 'same-origin');
    return reply.send(streamStoredFile(m.storageKey));
  });

  // ---------------------------------------------------------- plataforma
  app.get('/api/system/manuals', guard, async () => {
    const rows = await db.select().from(schema.manuals).orderBy(asc(schema.manuals.title));
    const ids = [...new Set(rows.map((m) => m.updatedBy).filter((x): x is string => !!x))];
    const users = ids.length ? await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users).where(inArray(schema.users.id, ids)) : [];
    const uname = new Map(users.map((u) => [u.id, u.name]));
    return { items: rows.map((m) => ({ ...pub(m), audiences: m.audiences, originalName: m.originalName, updatedByName: m.updatedBy ? uname.get(m.updatedBy) ?? null : null })) };
  });

  app.post('/api/system/manuals', guard, async (req) => {
    const { fields, file } = await readUpload(req);
    let m: Manual;
    try {
      if (!file) throw badRequest('Escolha o PDF do manual.');
      const body = parseFields(fields);
      [m] = await db.insert(schema.manuals).values({ ...body, originalName: file.filename, size: file.size, storageKey: file.key, sha256: file.sha256, updatedBy: req.user!.id }).returning();
    } catch (e) {
      if (file) await deleteFile(file.key);
      throw e;
    }
    await audit(req, { orgId: null, action: 'platform.manual_create', entityType: 'manual', entityId: m.id, description: `Publicou o manual "${m.title}"`, details: { audiences: m.audiences, file: m.originalName } });
    return { id: m.id };
  });

  /** Altera título, descrição e públicos; com arquivo, troca o PDF. */
  app.put<{ Params: { id: string } }>('/api/system/manuals/:id', guard, async (req) => {
    const [old] = await db.select().from(schema.manuals).where(eq(schema.manuals.id, req.params.id));
    if (!old) throw notFound('Manual não encontrado');
    const { fields, file } = await readUpload(req);
    let m: Manual;
    try {
      const body = parseFields(fields);
      [m] = await db.update(schema.manuals).set({
        ...body, updatedBy: req.user!.id, updatedAt: new Date(),
        ...(file ? { originalName: file.filename, size: file.size, storageKey: file.key, sha256: file.sha256 } : {}),
      }).where(eq(schema.manuals.id, old.id)).returning();
    } catch (e) {
      if (file) await deleteFile(file.key);
      throw e;
    }
    if (file) await deleteFile(old.storageKey);
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (old.title !== m.title) changes.title = { from: old.title, to: m.title };
    if ((old.description ?? '') !== (m.description ?? '')) changes.description = { from: old.description, to: m.description };
    if (JSON.stringify(old.audiences) !== JSON.stringify(m.audiences)) changes.audiences = { from: old.audiences, to: m.audiences };
    if (file) changes.file = { from: old.originalName, to: m.originalName };
    await audit(req, { orgId: null, action: 'platform.manual_update', entityType: 'manual', entityId: m.id, description: `Alterou o manual "${m.title}"${file ? ' (PDF novo)' : ''}`, details: { changes } });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/system/manuals/:id', guard, async (req) => {
    const [m] = await db.delete(schema.manuals).where(eq(schema.manuals.id, req.params.id)).returning();
    if (!m) throw notFound('Manual não encontrado');
    await deleteFile(m.storageKey);
    await audit(req, { orgId: null, action: 'platform.manual_delete', entityType: 'manual', entityId: m.id, description: `Apagou o manual "${m.title}"` });
    return { ok: true };
  });
}
