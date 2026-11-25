import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  FISCAL_CERT_MAX_BYTES, FISCAL_DOC_STATUSES, docKey, fiscalLaunchSchema, fiscalSettingsSchema, toCents, fromCents,
  type FiscalDocumentRow,
} from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { parse } from '../lib/validate.js';
import { HttpError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { sealCertificate } from '../lib/secrets.js';
import { assertCurrentPassword } from './auth.js';
import { assertCertificateFits, fiscalView, readCertificate, runFiscalQuery } from '../services/fiscal.js';

/** Notas fiscais da SEFAZ: só espaço Empresa; nada daqui é alcançável por token de integração. */
const companyOnly = async (req: FastifyRequest) => {
  if (!req.user || req.integration) throw forbidden();
  if (req.org!.kind !== 'company') throw badRequest('As notas fiscais da SEFAZ só estão disponíveis em espaços do tipo Empresa.', 'company_only');
};
const guard = (...p: Parameters<typeof requirePerm>) => ({ preHandler: [requirePerm(...p), companyOnly] });

type DocRow = typeof schema.fiscalDocuments.$inferSelect;
const docView = (d: DocRow): FiscalDocumentRow => ({
  id: d.id, key: d.accessKey, kind: d.kind as FiscalDocumentRow['kind'], status: d.status as FiscalDocumentRow['status'],
  situation: d.situation as FiscalDocumentRow['situation'], role: d.role as FiscalDocumentRow['role'],
  number: d.number, series: d.series, issuedAt: d.issuedAt, emitterDocument: d.emitterDocument, emitterName: d.emitterName,
  total: d.total, duplicates: d.duplicates, paymentKinds: d.paymentKinds, nature: d.nature, billIds: d.billIds,
  handledByName: d.handledByName, handledAt: d.handledAt?.toISOString() ?? null, receivedAt: d.createdAt.toISOString(),
});

async function loadDoc(req: FastifyRequest, id: string) {
  const [d] = await db.select().from(schema.fiscalDocuments).where(and(eq(schema.fiscalDocuments.id, id), eq(schema.fiscalDocuments.orgId, req.org!.id)));
  if (!d) throw notFound('Nota não encontrada');
  return d;
}

async function orgDocument(orgId: string) {
  const [o] = await db.select({ document: schema.organizations.document, state: schema.organizations.state }).from(schema.organizations).where(eq(schema.organizations.id, orgId));
  return o;
}

/** Só o administrador do espaço mexe no certificado, sempre confirmando a senha da própria conta. */
async function assertCertAdmin(req: FastifyRequest, password: string | null | undefined) {
  if (!req.org!.isAdmin) throw forbidden('Só o administrador do espaço envia ou remove o certificado digital.');
  const [u] = await db.select({ id: schema.users.id, passwordHash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, req.user!.id));
  if (!u) throw forbidden();
  await assertCurrentPassword(req, u, password, 'A senha da sua conta não confere.', 'password_invalid');
}

export async function fiscalRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------ configuração
  app.get('/api/fiscal/config', guard('fiscal.view'), async (req) => {
    const v = await fiscalView(req.org!.id);
    const o = await orgDocument(req.org!.id);
    return { ...v, uf: v.uf ?? o?.state ?? null, orgDocument: o?.document ?? null };
  });

  app.put('/api/fiscal/config', guard('fiscal.manage'), async (req) => {
    const body = parse(fiscalSettingsSchema, req.body);
    const orgId = req.org!.id;
    const [cur] = await db.select().from(schema.fiscalConfigs).where(eq(schema.fiscalConfigs.orgId, orgId));
    if (body.enabled && !cur?.certEnc) throw badRequest('Envie o certificado digital A1 antes de ligar a consulta.', 'fiscal_no_cert');
    if (body.categoryId) {
      const [c] = await db.select({ id: schema.categories.id }).from(schema.categories).where(and(eq(schema.categories.id, body.categoryId), eq(schema.categories.orgId, orgId)));
      if (!c) throw badRequest('Categoria inválida');
    }
    if (body.folderId) {
      const [f] = await db.select({ id: schema.folders.id }).from(schema.folders).where(and(eq(schema.folders.id, body.folderId), eq(schema.folders.orgId, orgId)));
      if (!f) throw badRequest('Pasta inválida');
    }
    // ligar de novo (ou mudar a configuração com a consulta ligada) tira a pausa automática
    const unpause = body.enabled ? { pausedAt: null, pausedReason: null } : {};
    const values = { ...body, ...unpause, updatedAt: new Date() };
    await db.insert(schema.fiscalConfigs).values({ orgId, ...values })
      .onConflictDoUpdate({ target: schema.fiscalConfigs.orgId, set: values });
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of ['enabled', 'queryHour', 'startDate', 'uf', 'categoryId', 'folderId'] as const) {
      const from = cur?.[k] ?? null;
      if (from !== body[k]) changes[k] = { from, to: body[k] };
    }
    if (cur?.pausedAt && body.enabled) changes.paused = { from: true, to: false };
    await audit(req, { action: 'fiscal.config', entityType: 'fiscal', description: `${body.enabled ? 'Configurou' : 'Desligou'} a consulta de notas fiscais na SEFAZ`, details: { changes } });
    return fiscalView(orgId);
  });

  // ------------------------------------------------------------ certificado
  app.post('/api/fiscal/certificate', guard('fiscal.manage'), async (req) => {
    const fields: Record<string, string> = {};
    let file: Buffer | null = null;
    for await (const part of req.parts({ limits: { fileSize: FISCAL_CERT_MAX_BYTES, files: 1, fields: 5, fieldSize: 1024 } })) {
      if (part.type === 'field') { fields[part.fieldname] = String(part.value ?? ''); continue; }
      file = await part.toBuffer();
      if (part.file.truncated) throw badRequest('Este arquivo é grande demais para um certificado A1.', 'cert_invalid');
    }
    await assertCertAdmin(req, fields.password);
    if (!file?.length) throw badRequest('Escolha o arquivo do certificado (.pfx ou .p12).', 'cert_invalid');
    const certPassword = fields.certPassword ?? '';
    if (!certPassword) throw badRequest('Informe a senha do certificado.', 'cert_password');
    const info = readCertificate(file, certPassword);
    const o = await orgDocument(req.org!.id);
    assertCertificateFits(info, o?.document ?? null);
    const orgId = req.org!.id;
    const [cur] = await db.select({ fp: schema.fiscalConfigs.certFingerprint }).from(schema.fiscalConfigs).where(eq(schema.fiscalConfigs.orgId, orgId));
    const values = {
      certEnc: sealCertificate(file), certPassEnc: sealCertificate(Buffer.from(certPassword, 'utf8')),
      certSubject: info.subject, certDocument: info.document, certNotBefore: info.notBefore, certNotAfter: info.notAfter,
      certFingerprint: info.fingerprint, certUploadedBy: req.user!.id, certUploadedByName: req.user!.name.slice(0, 120), certUploadedAt: new Date(),
      expiryWarnedFor: null, updatedAt: new Date(),
    };
    await db.insert(schema.fiscalConfigs).values({ orgId, uf: o?.state && o.state.length === 2 ? o.state : null, ...values })
      .onConflictDoUpdate({ target: schema.fiscalConfigs.orgId, set: values });
    file.fill(0);
    await audit(req, {
      action: cur?.fp ? 'fiscal.certificate_replace' : 'fiscal.certificate_add', entityType: 'fiscal',
      description: `${cur?.fp ? 'Trocou' : 'Enviou'} o certificado digital A1 (${info.subject}, válido até ${info.notAfter.toLocaleDateString('pt-BR')})`,
      details: { subject: info.subject, notAfter: info.notAfter.toISOString(), fingerprint: info.fingerprint },
    });
    return fiscalView(orgId);
  });

  app.delete('/api/fiscal/certificate', guard('fiscal.manage'), async (req) => {
    const body = parse(z.object({ password: z.string().max(200) }), req.body ?? {});
    await assertCertAdmin(req, body.password);
    const orgId = req.org!.id;
    await db.update(schema.fiscalConfigs).set({
      enabled: false, certEnc: null, certPassEnc: null, certSubject: null, certDocument: null, certNotBefore: null, certNotAfter: null,
      certFingerprint: null, certUploadedBy: null, certUploadedByName: null, certUploadedAt: null, expiryWarnedFor: null, updatedAt: new Date(),
    }).where(eq(schema.fiscalConfigs.orgId, orgId));
    await audit(req, { action: 'fiscal.certificate_remove', entityType: 'fiscal', description: 'Removeu o certificado digital A1 (a consulta de notas foi desligada)' });
    return fiscalView(orgId);
  });

  // ------------------------------------------------------------ consulta manual
  app.post('/api/fiscal/query', guard('fiscal.manage'), async (req) => {
    const r = await runFiscalQuery(req.org!.id, 'manual');
    await audit(req, { action: 'fiscal.query', entityType: 'fiscal', description: `Consultou as notas fiscais na SEFAZ (${r.notes} nota(s), resposta ${r.status})`, details: { ...r } });
    return { result: r, config: await fiscalView(req.org!.id) };
  });

  // ------------------------------------------------------------ notas
  app.get<{ Querystring: { status?: string; q?: string; role?: string } }>('/api/fiscal/documents', guard('fiscal.view'), async (req) => {
    const t = schema.fiscalDocuments;
    const conds = [eq(t.orgId, req.org!.id)];
    const [cfg] = await db.select({ startDate: schema.fiscalConfigs.startDate }).from(schema.fiscalConfigs).where(eq(schema.fiscalConfigs.orgId, req.org!.id));
    if (cfg?.startDate) conds.push(sql`(${t.issuedAt} is null or ${t.issuedAt} >= ${cfg.startDate})`);
    const status = (req.query.status ?? '').split(',').filter((s) => (FISCAL_DOC_STATUSES as readonly string[]).includes(s));
    if (status.length) conds.push(inArray(t.status, status));
    if (req.query.role === 'other') conds.push(eq(t.role, 'other'));
    else if (req.query.role !== 'all') conds.push(eq(t.role, 'recipient'));
    const q = req.query.q?.trim().slice(0, 100);
    if (q) {
      const term = `%${q.toLowerCase()}%`;
      const digits = docKey(q);
      conds.push(sql`(lower(coalesce(${t.emitterName}, '')) like ${term} or coalesce(${t.number}, '') = ${q} or (${digits.length >= 4} and (${t.accessKey} like ${'%' + digits + '%'} or coalesce(${t.emitterDocument}, '') like ${'%' + digits + '%'})))`);
    }
    const rows = await db.select().from(t).where(and(...conds)).orderBy(desc(t.issuedAt), desc(t.createdAt)).limit(500);
    return { items: rows.map(docView) };
  });

  app.get<{ Params: { id: string } }>('/api/fiscal/documents/:id/xml', guard('fiscal.view'), async (req, reply) => {
    const d = await loadDoc(req, req.params.id);
    if (!d.xml) throw notFound('XML não disponível');
    reply.header('content-type', 'application/xml; charset=utf-8');
    reply.header('content-disposition', `attachment; filename="NFe${d.accessKey}.xml"`);
    return d.xml;
  });

  app.put<{ Params: { id: string } }>('/api/fiscal/documents/:id', guard('fiscal.view'), async (req) => {
    const body = parse(z.object({ status: z.enum(FISCAL_DOC_STATUSES) }), req.body);
    const d = await loadDoc(req, req.params.id);
    const handled = body.status === 'new' ? { handledBy: null, handledByName: null, handledAt: null } : { handledBy: req.user!.id, handledByName: req.user!.name.slice(0, 120), handledAt: new Date() };
    const [r] = await db.update(schema.fiscalDocuments).set({ status: body.status, ...handled }).where(eq(schema.fiscalDocuments.id, d.id)).returning();
    const label = { new: 'voltou para "a lançar"', done: 'marcou como lançada', dismissed: 'dispensou' }[body.status];
    await audit(req, { action: 'fiscal.document_status', entityType: 'fiscal_document', entityId: d.id, description: `NF ${d.number ?? d.accessKey} de ${d.emitterName ?? 'fornecedor'}: ${label}`, details: { changes: { status: { from: d.status, to: body.status } } } });
    return docView(r!);
  });

  /** Lança as contas a pagar da nota (uma por duplicata) pela mesma rota da tela — permissões e categorias restritas valem iguais. */
  app.post<{ Params: { id: string } }>('/api/fiscal/documents/:id/launch', guard('fiscal.view'), async (req) => {
    const body = parse(fiscalLaunchSchema, req.body);
    const d = await loadDoc(req, req.params.id);
    if (d.status === 'done' && d.billIds.length) throw new HttpError(409, 'As contas desta nota já foram lançadas.', 'already_launched');
    if (d.situation !== 'authorized') throw badRequest('Esta nota foi cancelada ou denegada pela SEFAZ: não lance contas para ela.', 'nfe_canceled');
    const parts = body.installments.map((p) => ({ dueDate: p.dueDate, amount: fromCents(toCents(String(p.amount))) }));
    if (parts.some((p) => toCents(p.amount) <= 0)) throw badRequest('Cada parcela precisa ter um valor maior que zero.');
    const ref = `NF-e ${d.number ?? ''}${d.series ? ` série ${d.series}` : ''} — chave ${d.accessKey}`.replace(/\s+/g, ' ');
    const notes = [body.notes?.trim(), ref].filter(Boolean).join('\n');
    const payload = parts.length === 1
      ? { type: 'payable', description: body.description, categoryId: body.categoryId, folderId: body.folderId ?? null, relatedPerson: body.relatedPerson ?? null, notes, amount: parts[0]!.amount, dueDate: parts[0]!.dueDate, recurrenceType: 'once', paymentMethod: d.paymentKinds.includes('15') ? 'Boleto' : null }
      : { type: 'payable', description: body.description, categoryId: body.categoryId, folderId: body.folderId ?? null, relatedPerson: body.relatedPerson ?? null, notes, dueDate: parts[0]!.dueDate, recurrenceType: 'installments', totalOccurrences: parts.length, installmentAmounts: parts.map((p) => p.amount), installmentDueDates: parts.map((p) => p.dueDate), paymentMethod: d.paymentKinds.includes('15') ? 'Boleto' : null };
    const res = await app.inject({
      method: 'POST', url: '/api/bills', payload,
      headers: { authorization: String(req.headers.authorization ?? ''), cookie: String(req.headers.cookie ?? ''), 'x-org-id': req.org!.id },
      remoteAddress: req.ip,
    });
    const out = res.json() as { items?: { id: string }[]; error?: string; code?: string };
    if (res.statusCode >= 400) throw new HttpError(res.statusCode, out.error ?? 'Não foi possível lançar as contas', out.code);
    const billIds = (out.items ?? []).map((b) => b.id);
    const [r] = await db.update(schema.fiscalDocuments).set({ status: 'done', billIds, handledBy: req.user!.id, handledByName: req.user!.name.slice(0, 120), handledAt: new Date() })
      .where(eq(schema.fiscalDocuments.id, d.id)).returning();
    await audit(req, { action: 'fiscal.launch', entityType: 'fiscal_document', entityId: d.id, description: `Lançou ${billIds.length} conta(s) da NF ${d.number ?? d.accessKey} de ${d.emitterName ?? 'fornecedor'}`, details: { billIds } });
    return docView(r!);
  });
}
