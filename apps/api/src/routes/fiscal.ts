import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  FISCAL_CERT_MAX_BYTES, FISCAL_DOC_STATUSES, FISCAL_MATCH_AFTER_DAYS, FISCAL_MATCH_BEFORE_DAYS, addDaysISO, billPerm, descriptionRoot, diffDaysISO, noteRefDate,
  docKey, fiscalLaunchSchema, fiscalLinkNoteLine, fiscalLinkSchema, fiscalSettingsSchema, notesAfterLink, parseNfeDetails, scoreBillForNote,
  toCents, fromCents, todayISO,
  type FiscalCandidate, type FiscalDocumentRow, type FiscalLinkedBill,
} from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { parse } from '../lib/validate.js';
import { HttpError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { sealCertificate } from '../lib/secrets.js';
import { assertCurrentPassword } from './auth.js';
import { hiddenCategoryIds, restrictedCategoryIds } from '../services/bills.js';
import { assertCertificateFits, fiscalView, readCertificate, runFiscalQuery } from '../services/fiscal.js';

/** Notas fiscais da SEFAZ: só espaço Empresa; nada daqui é alcançável por token de integração. */
const companyOnly = async (req: FastifyRequest) => {
  if (!req.user || req.integration) throw forbidden();
  if (req.org!.kind !== 'company') throw badRequest('As notas fiscais da SEFAZ só estão disponíveis em espaços do tipo Empresa.', 'company_only');
};
const guard = (...p: Parameters<typeof requirePerm>) => ({ preHandler: [requirePerm(...p), companyOnly] });

type DocRow = typeof schema.fiscalDocuments.$inferSelect;

/** Notas completas recebidas antes da coluna `details`: lê itens e veículo do XML guardado (uma vez). */
async function fillDetails(orgId: string) {
  const t = schema.fiscalDocuments;
  const rows = await db.select({ id: t.id, xml: t.xml }).from(t)
    .where(and(eq(t.orgId, orgId), eq(t.kind, 'full'), sql`${t.details} is null`)).limit(2000);
  for (const r of rows) {
    const details = parseNfeDetails(r.xml ?? '') ?? { items: [], itemCount: 0, vehicle: null };
    await db.update(t).set({ details }).where(eq(t.id, r.id));
  }
}
type LinkedMap = Map<string, Omit<FiscalLinkedBill, 'linked'>>;
const docView = (d: DocRow, bills: LinkedMap = new Map()): FiscalDocumentRow => ({
  id: d.id, key: d.accessKey, kind: d.kind as FiscalDocumentRow['kind'], status: d.status as FiscalDocumentRow['status'],
  situation: d.situation as FiscalDocumentRow['situation'], role: d.role as FiscalDocumentRow['role'],
  number: d.number, series: d.series, issuedAt: d.issuedAt, emitterDocument: d.emitterDocument, emitterName: d.emitterName,
  total: d.total, duplicates: d.duplicates, paymentKinds: d.paymentKinds, nature: d.nature, details: d.kind === 'full' ? d.details ?? null : null, billIds: d.billIds, linkedBillIds: d.linkedBillIds,
  bills: d.billIds.flatMap((id) => { const b = bills.get(id); return b ? [{ ...b, linked: d.linkedBillIds.includes(id) }] : []; }),
  handledByName: d.handledByName, handledAt: d.handledAt?.toISOString() ?? null, receivedAt: d.createdAt.toISOString(),
});

/** Resumo das contas ligadas às notas, sem as das categorias restritas que a pessoa não vê. */
async function linkedBills(req: FastifyRequest, ids: string[]): Promise<LinkedMap> {
  const map: LinkedMap = new Map();
  if (!ids.length || !req.org!.can('payable.view')) return map;
  const hidden = await hiddenCategoryIds(req);
  const b = schema.bills;
  const rows = await db.select({ id: b.id, description: b.description, dueDate: b.dueDate, amount: b.amount, status: b.status, categoryId: b.categoryId })
    .from(b).where(and(eq(b.orgId, req.org!.id), inArray(b.id, [...new Set(ids)])));
  for (const r of rows) if (!hidden.includes(r.categoryId)) map.set(r.id, { id: r.id, description: r.description, dueDate: r.dueDate, amount: r.amount, status: r.status as 'pending' | 'paid' });
  return map;
}
async function oneView(req: FastifyRequest, d: DocRow) {
  return docView(d, await linkedBills(req, d.billIds));
}

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
    await fillDetails(req.org!.id);
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
      const plate = q.replace(/[\s-]/g, '').toUpperCase();
      conds.push(sql`(lower(coalesce(${t.emitterName}, '')) like ${term}
        or (${plate.length >= 3} and coalesce(${t.details}->'vehicle'->>'plate', '') like ${'%' + plate + '%'})
        or lower(coalesce(${t.details}->'vehicle'->>'model', '')) like ${term}
        or exists (select 1 from jsonb_array_elements(coalesce(${t.details}->'items', '[]'::jsonb)) i where lower(i->>'name') like ${term})
        or coalesce(${t.number}, '') = ${q} or (${digits.length >= 4} and (${t.accessKey} like ${'%' + digits + '%'} or coalesce(${t.emitterDocument}, '') like ${'%' + digits + '%'})))`);
    }
    const rows = await db.select().from(t).where(and(...conds)).orderBy(desc(t.issuedAt), desc(t.createdAt)).limit(500);
    const bills = await linkedBills(req, rows.flatMap((r) => r.billIds));
    return { items: rows.map((r) => docView(r, bills)) };
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
    if (body.status !== 'done' && d.billIds.length) throw badRequest('Esta nota tem contas ligadas: desvincule as contas antes.', 'has_bills');
    const handled = body.status === 'new' ? { handledBy: null, handledByName: null, handledAt: null } : { handledBy: req.user!.id, handledByName: req.user!.name.slice(0, 120), handledAt: new Date() };
    const [r] = await db.update(schema.fiscalDocuments).set({ status: body.status, ...handled }).where(eq(schema.fiscalDocuments.id, d.id)).returning();
    const label = { new: 'voltou para "a lançar"', done: 'marcou como lançada', dismissed: 'dispensou' }[body.status];
    await audit(req, { action: 'fiscal.document_status', entityType: 'fiscal_document', entityId: d.id, description: `NF ${d.number ?? d.accessKey} de ${d.emitterName ?? 'fornecedor'}: ${label}`, details: { changes: { status: { from: d.status, to: body.status } } } });
    return oneView(req, r!);
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
    return oneView(req, r!);
  });

  // ------------------------------------------------------------ vincular a contas já lançadas
  /**
   * Contas a pagar que podem ser desta nota (nada é vinculado aqui). Sem `q`: só as de vencimento perto da nota,
   * pontuadas e separadas em encontradas / podem ser. Com `q`: busca manual por texto, em qualquer data.
   */
  app.get<{ Params: { id: string }; Querystring: { q?: string } }>('/api/fiscal/documents/:id/candidates', guard('fiscal.view'), async (req) => {
    if (!req.org!.can('payable.view')) throw forbidden('Você não tem permissão para ver as contas a pagar.');
    const d = await loadDoc(req, req.params.id);
    const orgId = req.org!.id;
    const b = schema.bills;
    const hidden = await hiddenCategoryIds(req);
    const conds = [eq(b.orgId, orgId), eq(b.type, 'payable'), sql`${b.payrollEntryId} is null`, sql`${b.payrollThirteenthId} is null`];
    if (hidden.length) conds.push(sql`${b.categoryId} not in (${sql.join(hidden.map((h) => sql`${h}::uuid`), sql`, `)})`);
    const q = req.query.q?.trim().slice(0, 100) ?? '';
    const base = d.issuedAt ?? todayISO(req.org!.timezone);
    const lastDue = d.duplicates.map((x) => x.dueDate).filter((x): x is string => !!x).sort().at(-1);
    if (q) {
      const term = `%${q.toLowerCase()}%`;
      conds.push(sql`(lower(${b.description}) like ${term} or lower(coalesce(${b.relatedPerson}, '')) like ${term} or lower(coalesce(${b.notes}, '')) like ${term})`);
    } else {
      const to = addDaysISO(lastDue && lastDue > base ? lastDue : base, FISCAL_MATCH_AFTER_DAYS);
      conds.push(sql`${b.dueDate} between ${addDaysISO(base, -FISCAL_MATCH_BEFORE_DAYS)} and ${to}`);
    }
    const rows = await db.select({
      id: b.id, description: b.description, relatedPerson: b.relatedPerson, notes: b.notes, amount: b.amount, dueDate: b.dueDate,
      status: b.status, installmentNumber: b.installmentNumber, totalInstallments: b.totalInstallments, categoryLabel: schema.categories.label,
    }).from(b).leftJoin(schema.categories, eq(schema.categories.id, b.categoryId))
      .where(and(...conds)).orderBy(sql`abs(${b.dueDate} - ${base}::date)`).limit(q ? 60 : 3000);

    // o que já foi vinculado a outras notas do mesmo fornecedor faz o papel do CNPJ (que a conta não tem)
    let roots: string[] = [];
    if (d.emitterDocument) {
      const prev = await db.execute<{ description: string }>(sql`
        select distinct bl.description from fiscal_documents f join bills bl on bl.id = any(f.bill_ids)
        where f.org_id = ${orgId} and f.emitter_document = ${d.emitterDocument} and f.id <> ${d.id}`);
      roots = [...new Set(prev.rows.map((r) => descriptionRoot(r.description)).filter(Boolean))];
    }
    const ref = noteRefDate(d) ?? base;
    const note = { number: d.number, key: d.accessKey, issuedAt: d.issuedAt, total: d.total, emitterName: d.emitterName, duplicates: d.duplicates, details: d.details ?? null };
    const scored = rows.map((r) => ({ r, m: scoreBillForNote(note, r, roots) }))
      .filter((x) => q || x.m.level !== 'none' || d.billIds.includes(x.r.id))
      .sort((a, z) => z.m.score - a.m.score || Math.abs(diffDaysISO(a.r.dueDate, ref)) - Math.abs(diffDaysISO(z.r.dueDate, ref))).slice(0, 40);

    // outras notas já ligadas a estas contas (posto: várias notas para a conta do mês)
    const ids = scored.map((x) => x.r.id);
    const others = ids.length ? await db.execute<{ bill_id: string; number: string | null; total: string | null }>(sql`
      select u.bill_id, f.number, f.total from fiscal_documents f, unnest(f.bill_ids) as u(bill_id)
      where f.org_id = ${orgId} and f.id <> ${d.id} and u.bill_id in (${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)})`) : { rows: [] };
    const canEdit = req.org!.can(billPerm('payable', 'edit'));
    const items: FiscalCandidate[] = scored.map(({ r, m }) => ({
      id: r.id, description: r.description, dueDate: r.dueDate, amount: r.amount, status: r.status as 'pending' | 'paid',
      linked: d.billIds.includes(r.id), relatedPerson: r.relatedPerson, notes: r.notes,
      installment: r.installmentNumber && r.totalInstallments ? `${r.installmentNumber}/${r.totalInstallments}` : null,
      categoryLabel: r.categoryLabel, score: m.score, level: m.level, reasons: m.reasons, canEdit,
      otherNotes: others.rows.filter((o) => o.bill_id === r.id).map((o) => ({ number: o.number, total: o.total })),
    }));
    return { items, noteLine: fiscalLinkNoteLine({ number: d.number, series: d.series, total: d.total, key: d.accessKey }) };
  });

  /** Liga a nota a contas já lançadas; opcionalmente acrescenta a referência da nota nas observações de cada conta. */
  app.post<{ Params: { id: string } }>('/api/fiscal/documents/:id/link', guard('fiscal.view'), async (req) => {
    if (!req.org!.can('payable.view')) throw forbidden('Você não tem permissão para ver as contas a pagar.');
    const body = parse(fiscalLinkSchema, req.body);
    if (body.updateNotes && !req.org!.can(billPerm('payable', 'edit'))) throw forbidden('Você não tem permissão para editar contas a pagar: vincule sem alterar as observações.');
    const d = await loadDoc(req, req.params.id);
    if (d.situation !== 'authorized') throw badRequest('Esta nota foi cancelada ou denegada pela SEFAZ: não vincule contas a ela.', 'nfe_canceled');
    const orgId = req.org!.id;
    const b = schema.bills;
    const ids = [...new Set(body.billIds)];
    const hidden = await hiddenCategoryIds(req);
    const line = fiscalLinkNoteLine({ number: d.number, series: d.series, total: d.total, key: d.accessKey });
    const restricted = await restrictedCategoryIds(orgId);
    const result = await db.transaction(async (tx) => {
      const rows = await tx.select({ id: b.id, type: b.type, notes: b.notes, description: b.description, categoryId: b.categoryId })
        .from(b).where(and(eq(b.orgId, orgId), inArray(b.id, ids))).for('update');
      if (rows.length !== ids.length || rows.some((r) => r.type !== 'payable' || hidden.includes(r.categoryId))) throw notFound('Conta não encontrada');
      const changed: Array<{ id: string; description: string; from: string | null; to: string }> = [];
      if (body.updateNotes) {
        for (const r of rows) {
          const to = notesAfterLink(r.notes, line, d.accessKey);
          if (to === (r.notes ?? '').trimEnd()) continue;
          if (to.length > 2000) throw badRequest(`As observações de "${r.description}" passariam do limite de 2.000 caracteres: vincule sem alterar as observações.`, 'notes_too_long');
          await tx.update(b).set({ notes: to, updatedAt: new Date() }).where(eq(b.id, r.id));
          changed.push({ id: r.id, description: r.description, from: r.notes, to });
        }
      }
      const [doc] = await tx.update(schema.fiscalDocuments).set({
        billIds: sql`(select array(select distinct unnest(${schema.fiscalDocuments.billIds} || ${sql`array[${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}]`})))`,
        linkedBillIds: sql`(select array(select distinct unnest(${schema.fiscalDocuments.linkedBillIds} || ${sql`array[${sql.join(ids.map((i) => sql`${i}::uuid`), sql`, `)}]`})))`,
        status: 'done', handledBy: req.user!.id, handledByName: req.user!.name.slice(0, 120), handledAt: new Date(),
      }).where(eq(schema.fiscalDocuments.id, d.id)).returning();
      return { doc: doc!, rows, changed };
    });
    const isRestricted = result.rows.some((r) => restricted.includes(r.categoryId));
    const ref = `NF ${d.number ?? d.accessKey} de ${d.emitterName ?? 'fornecedor'}`;
    await audit(req, {
      action: 'fiscal.link', entityType: 'fiscal_document', entityId: d.id,
      description: `Vinculou a ${ref} a ${result.rows.length === 1 ? `"${result.rows[0]!.description}"` : `${result.rows.length} contas`}${result.changed.length ? ' (observações atualizadas)' : ''}`,
      details: { billIds: ids, notesUpdated: result.changed.length, ...(isRestricted ? { restricted: true } : {}) },
    });
    for (const c of result.changed) {
      await audit(req, {
        action: 'payable.update', entityType: 'bill', entityId: c.id,
        description: `Observações de "${c.description}": referência da ${ref}`,
        details: { changes: { notes: { from: c.from, to: c.to } }, restricted: restricted.includes(result.rows.find((r) => r.id === c.id)!.categoryId) },
      });
    }
    return oneView(req, result.doc);
  });

  /** Desfaz um vínculo (só os feitos pelo Vincular; a conta e as observações dela ficam como estão). */
  app.delete<{ Params: { id: string; billId: string } }>('/api/fiscal/documents/:id/link/:billId', guard('fiscal.view'), async (req) => {
    const d = await loadDoc(req, req.params.id);
    if (!d.linkedBillIds.includes(req.params.billId)) throw notFound('Esta conta não está vinculada a esta nota.');
    const billIds = d.billIds.filter((x) => x !== req.params.billId);
    const [r] = await db.update(schema.fiscalDocuments).set({
      billIds, linkedBillIds: d.linkedBillIds.filter((x) => x !== req.params.billId),
      ...(billIds.length ? {} : { status: 'new', handledBy: null, handledByName: null, handledAt: null }),
    }).where(eq(schema.fiscalDocuments.id, d.id)).returning();
    const [bill] = await db.select({ description: schema.bills.description, categoryId: schema.bills.categoryId }).from(schema.bills).where(and(eq(schema.bills.id, req.params.billId), eq(schema.bills.orgId, req.org!.id)));
    const isRestricted = bill ? (await restrictedCategoryIds(req.org!.id)).includes(bill.categoryId) : false;
    await audit(req, {
      action: 'fiscal.unlink', entityType: 'fiscal_document', entityId: d.id,
      description: `Desvinculou a NF ${d.number ?? d.accessKey} de ${d.emitterName ?? 'fornecedor'}${bill && !isRestricted ? ` da conta "${bill.description}"` : ''}`,
      details: { billId: req.params.billId, ...(isRestricted ? { restricted: true } : {}) },
    });
    return oneView(req, r!);
  });
}
