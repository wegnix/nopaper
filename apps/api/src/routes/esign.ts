import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import {
  ESIGN_LOCK_MINUTES, ESIGN_MAX_ATTEMPTS, ESIGN_TERM_COMPETENCE, ESIGN_TERM_VERSION, esignOpenSchema, esignSendAccountantSchema, esignSubmitSchema, esignTermText,
  formatDocument, isValidCPF, refLabelPT, type EsignKind, type EsignOpened, type EsignPublicInfo, type EsignTermParties, type Payslip, type PayslipSignatureRow,
} from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { env } from '../env.js';
import { parse } from '../lib/validate.js';
import { badRequest, conflict, forbidden, notFound, HttpError } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { decryptSecret, encryptSecret } from '../lib/secrets.js';
import { deleteFile, readStoredFile, saveFile, signFileToken, verifyFileToken } from '../lib/storage.js';
import { assertCompany, loadPeriod } from '../services/payroll.js';
import { buildSignedPdf, buildTermPdf, splitPayslips } from '../services/esign.js';

type Row = typeof schema.payslipSignatures.$inferSelect;
const digits = (v: string | null | undefined) => (v ?? '').replace(/\D/g, '');
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
type Org = typeof schema.organizations.$inferSelect;
type Employee = typeof schema.employees.$inferSelect;
const fileName = (r: Row, signed: boolean) => (r.kind === 'term'
  ? `Termo de assinatura eletrônica ${signed ? 'assinado ' : ''}- ${r.employeeName}.pdf`
  : `Holerite ${signed ? 'assinado ' : ''}- ${r.employeeName} - ${r.competence}.pdf`).replace(/[\\/:*?"<>|]/g, '');
/** Nome para documentos: a razão social (o nome do espaço é o nome fantasia). */
const legalName = (org: Org) => org.legalName?.trim() || org.name;
const what = (r: Row) => (r.kind === 'term' ? 'o termo de aceite' : `o holerite de ${refLabelPT(r.competence)}`);
const termAccepted = (e: Employee | undefined) => !!e?.esignAcceptedAt && e.esignTermVersion === ESIGN_TERM_VERSION;
const cpfOf = (e: Employee) => { const d = digits(e.document); return d.length === 11 && isValidCPF(d) ? d : null; };
const serialize = (r: Row, phone: string | null): PayslipSignatureRow => ({
  id: r.id, kind: r.kind as EsignKind, employeeId: r.employeeId, employeeName: r.employeeName, phone, competence: r.competence, net: r.net, status: r.status as PayslipSignatureRow['status'],
  createdAt: r.createdAt.toISOString(), viewedAt: r.viewedAt?.toISOString() ?? null, signedAt: r.signedAt?.toISOString() ?? null,
  sentToAccountantAt: r.sentToAccountantAt?.toISOString() ?? null,
});

export default async function esignRoutes(app: FastifyInstance) {
  const guard = (p: 'payroll.view' | 'payroll.edit') => ({ preHandler: [requirePerm(p), async (req: FastifyRequest) => { assertCompany(req); }] });
  const view = guard('payroll.view'), edit = guard('payroll.edit');

  const loadRow = async (req: FastifyRequest, id: string) => {
    const [r] = await db.select().from(schema.payslipSignatures).where(and(eq(schema.payslipSignatures.id, id), eq(schema.payslipSignatures.orgId, req.org!.id)));
    if (!r) throw notFound('Assinatura não encontrada');
    return r;
  };

  const orgOf = async (orgId: string) => (await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId)))[0]!;
  /** Termo e comprovante levam razão social e CNPJ: sem eles o documento não identifica a empresa. */
  const assertCompanyData = (org: Org) => {
    if (!org.legalName?.trim() || !org.document) throw badRequest('Antes, preencha a razão social e o CNPJ da empresa em Configurações → Espaço → Dados do espaço. Eles vão no termo de aceite e no comprovante de assinatura.', 'esign_company');
  };
  /** Cria o termo de aceite do funcionário (se ele ainda não assinou e não há um aguardando). Devolve a linha pendente. */
  const ensureTerm = async (org: Org, emp: Employee, createdBy: string | null): Promise<Row | null> => {
    if (termAccepted(emp)) return null;
    const cpf = cpfOf(emp);
    if (!cpf) return null;
    const [old] = await db.select().from(schema.payslipSignatures).where(and(eq(schema.payslipSignatures.orgId, org.id), eq(schema.payslipSignatures.employeeId, emp.id), eq(schema.payslipSignatures.kind, 'term')));
    if (old) return old.status === 'pending' ? old : null;
    const parties: EsignTermParties = { company: legalName(org), companyDocument: org.document, employeeName: emp.name, employeeDocument: formatDocument(cpf) };
    const pdf = await buildTermPdf(parties);
    const saved = await saveFile(org.id, pdf, 'pdf');
    const token = randomBytes(32).toString('base64url');
    const [row] = await db.insert(schema.payslipSignatures).values({
      orgId: org.id, kind: 'term', employeeId: emp.id, employeeName: emp.name, employeeDocument: parties.employeeDocument, competence: ESIGN_TERM_COMPETENCE, net: '0',
      slip: { term: esignTermText(parties), company: parties.company, companyDocument: parties.companyDocument }, tokenHash: hashToken(token), tokenEnc: encryptSecret(token),
      storageKey: saved.key, sha256: saved.sha256, size: pdf.length, createdBy,
    }).returning();
    return row!;
  };

  // ================================================================ tela da folha
  /** Termos de aceite do espaço (um por funcionário). */
  app.get('/api/payroll/signature-terms', view, async (req) => {
    const rows = await db.select({ r: schema.payslipSignatures, phone: schema.employees.phone }).from(schema.payslipSignatures)
      .leftJoin(schema.employees, eq(schema.employees.id, schema.payslipSignatures.employeeId))
      .where(and(eq(schema.payslipSignatures.orgId, req.org!.id), eq(schema.payslipSignatures.kind, 'term')))
      .orderBy(asc(schema.payslipSignatures.status), asc(schema.payslipSignatures.employeeName));
    return rows.map((x) => serialize(x.r, x.phone));
  });

  /** Gera o termo de aceite para os funcionários ativos que ainda não têm (precisam do CPF no cadastro). */
  app.post('/api/payroll/signature-terms', edit, async (req) => {
    const org = await orgOf(req.org!.id);
    assertCompanyData(org);
    const emps = await db.select().from(schema.employees).where(and(eq(schema.employees.orgId, org.id), eq(schema.employees.active, true))).orderBy(desc(schema.employees.name));
    const before = new Set((await db.select({ e: schema.payslipSignatures.employeeId }).from(schema.payslipSignatures).where(and(eq(schema.payslipSignatures.orgId, org.id), eq(schema.payslipSignatures.kind, 'term')))).map((x) => x.e));
    let created = 0;
    const skipped: Array<{ name: string; reason: string }> = [];
    for (const e of emps) {
      if (termAccepted(e) || before.has(e.id)) continue;
      if (!cpfOf(e)) { skipped.push({ name: e.name, reason: 'sem CPF no cadastro do funcionário (o CPF é o que abre o link)' }); continue; }
      if (await ensureTerm(org, e, req.user!.id)) created++;
    }
    if (created) await audit(req, { action: 'payroll.esign.terms', entityType: 'organization', entityId: org.id, description: `Gerou ${created} termo(s) de aceite de assinatura eletrônica`, details: { created } });
    return { created, skipped };
  });

  /** Holerites enviados para assinatura neste mês da folha. */
  app.get<{ Params: { id: string } }>('/api/payroll/periods/:id/signatures', view, async (req) => {
    const p = await loadPeriod(req.org!.id, req.params.id);
    const rows = await db.select({ r: schema.payslipSignatures, phone: schema.employees.phone }).from(schema.payslipSignatures)
      .leftJoin(schema.employees, eq(schema.employees.id, schema.payslipSignatures.employeeId))
      .where(and(eq(schema.payslipSignatures.orgId, req.org!.id), eq(schema.payslipSignatures.periodId, p.id), eq(schema.payslipSignatures.kind, 'payslip')))
      .orderBy(asc(schema.payslipSignatures.employeeName));
    return rows.map((x) => serialize(x.r, x.phone));
  });

  /**
   * Envia os holerites para assinatura: recebe o PDF do contador (arquivo, ou `docId` de um documento
   * da área do contador), separa a página de cada funcionário pela matrícula e cria um link pessoal.
   * Quem já assinou esta competência fica como está; quem ainda não assinou recebe o arquivo novo
   * (o link continua o mesmo).
   */
  app.post<{ Params: { id: string } }>('/api/payroll/periods/:id/signatures', edit, async (req) => {
    const orgId = req.org!.id;
    const p = await loadPeriod(orgId, req.params.id);
    const org = await orgOf(orgId);
    assertCompanyData(org);
    let buf: Buffer;
    if (req.isMultipart()) {
      const file = await req.file({ limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });
      if (!file) throw badRequest('Envie o PDF dos holerites');
      buf = await file.toBuffer();
      if (file.file.truncated) throw badRequest(`Arquivo maior que ${env.MAX_UPLOAD_MB} MB`);
    } else {
      const docId = String((req.body as { docId?: unknown } | null)?.docId ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(docId)) throw badRequest('Envie o PDF dos holerites');
      if (!req.org!.can('accounting.review')) throw forbidden();
      const [d] = await db.select().from(schema.accountingDocuments).where(and(eq(schema.accountingDocuments.id, docId), eq(schema.accountingDocuments.orgId, orgId), eq(schema.accountingDocuments.direction, 'to_client')));
      if (!d || d.hiddenAt) throw notFound('Documento não encontrado');
      buf = await readStoredFile(d.storageKey);
    }
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw badRequest('O arquivo não é um PDF. Envie o PDF dos holerites que o contador manda.');
    let split;
    try { split = await splitPayslips(buf); } catch { throw badRequest('Não consegui ler este PDF. Peça o arquivo de novo ao contador e tente outra vez.'); }
    if (!split.slips.length) throw badRequest('Não achei holerites neste PDF. Ele precisa ser o PDF original do contador, não uma foto ou digitalização.', 'payslips_unknown');
    if (!split.ref) throw badRequest('Não achei o mês (competência) neste PDF de holerites.');
    const competence = split.ref;

    const employees = await db.select().from(schema.employees).where(eq(schema.employees.orgId, orgId));
    const existing = await db.select().from(schema.payslipSignatures).where(and(eq(schema.payslipSignatures.orgId, orgId), eq(schema.payslipSignatures.competence, competence)));
    const existingTerms = new Set((await db.select({ e: schema.payslipSignatures.employeeId }).from(schema.payslipSignatures).where(and(eq(schema.payslipSignatures.orgId, orgId), eq(schema.payslipSignatures.kind, 'term')))).map((x) => x.e));
    const skipped: Array<{ name: string; reason: string }> = [];
    let created = 0, updated = 0, terms = 0;
    for (const { slip, pdf } of split.slips) {
      const emp = employees.find((e) => e.payslipCode === slip.code);
      if (!emp) { skipped.push({ name: slip.name, reason: `nenhum funcionário com a matrícula ${slip.code} (importe os holerites na folha ou preencha a matrícula no cadastro)` }); continue; }
      let cpf = digits(emp.document);
      if (!(cpf.length === 11 && isValidCPF(cpf))) {
        const fromSlip = digits(slip.document);
        if (fromSlip.length === 11 && isValidCPF(fromSlip)) {
          cpf = fromSlip;
          emp.document = formatDocument(fromSlip);
          await db.update(schema.employees).set({ document: emp.document }).where(eq(schema.employees.id, emp.id));
        } else { skipped.push({ name: emp.name, reason: 'sem CPF no cadastro do funcionário (o CPF é o que abre o link)' }); continue; }
      }
      const old = existing.find((x) => x.employeeId === emp.id);
      if (old?.status === 'signed') { skipped.push({ name: emp.name, reason: 'já assinou o holerite deste mês' }); continue; }
      const saved = await saveFile(orgId, pdf, 'pdf');
      const base = { employeeName: emp.name, employeeDocument: formatDocument(cpf), net: slip.net, slip: slip as unknown as Record<string, unknown>, storageKey: saved.key, sha256: saved.sha256, size: pdf.length, periodId: p.id };
      if (old) {
        await db.update(schema.payslipSignatures).set({ ...base, viewedAt: null, failedAttempts: 0, lockedUntil: null }).where(eq(schema.payslipSignatures.id, old.id));
        await deleteFile(old.storageKey);
        updated++;
      } else {
        const token = randomBytes(32).toString('base64url');
        await db.insert(schema.payslipSignatures).values({ ...base, orgId, employeeId: emp.id, competence, tokenHash: hashToken(token), tokenEnc: encryptSecret(token), createdBy: req.user!.id });
        created++;
      }
      // quem ainda não assinou o termo de aceite ganha o dele (assina antes do holerite)
      const hadTerm = existingTerms.has(emp.id);
      if (!hadTerm && (await ensureTerm(org, emp, req.user!.id))) terms++;
    }
    if (created + updated) {
      await audit(req, {
        action: 'payroll.esign.send', entityType: 'payroll_period', entityId: p.id,
        description: `Enviou ${created + updated} holerite(s) de ${refLabelPT(competence)} para assinatura`,
        details: { competence, created, updated, skipped: skipped.length },
      });
    }
    return { competence, created, updated, terms, skipped };
  });

  /** Token do link pessoal (o endereço é montado na tela: /assinar/<token>). */
  app.get<{ Params: { id: string } }>('/api/payroll/signatures/:id/link', edit, async (req) => {
    const r = await loadRow(req, req.params.id);
    const token = decryptSecret(r.tokenEnc);
    if (!token) throw badRequest('Não consegui recuperar o link. Cancele e envie o holerite de novo.');
    return { token };
  });

  /** Baixa o holerite (assinado, se já foi; senão o que aguarda assinatura). */
  app.get<{ Params: { id: string } }>('/api/payroll/signatures/:id/file', view, async (req, reply) => {
    const r = await loadRow(req, req.params.id);
    const signed = r.status === 'signed' && !!r.signedKey;
    reply.header('Content-Type', 'application/pdf').header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileName(r, signed))}`);
    return reply.send(await readStoredFile(signed ? r.signedKey! : r.storageKey));
  });

  /** Cancela um envio que ainda não foi assinado (o link para de funcionar). Assinado não se apaga. */
  app.delete<{ Params: { id: string } }>('/api/payroll/signatures/:id', edit, async (req) => {
    const r = await loadRow(req, req.params.id);
    if (r.status === 'signed') throw conflict('Este documento já foi assinado e não pode ser cancelado.');
    await db.delete(schema.payslipSignatures).where(eq(schema.payslipSignatures.id, r.id));
    await deleteFile(r.storageKey);
    await audit(req, { action: 'payroll.esign.cancel', entityType: 'payslip_signature', entityId: r.id, description: `Cancelou o envio d${what(r)} de ${r.employeeName} para assinatura` });
    return { ok: true };
  });

  /** Manda os holerites assinados para o contador (caixa "Recebidos" dele), um arquivo por funcionário. */
  app.post('/api/payroll/signatures/send-accountant', { preHandler: [...view.preHandler, requirePerm('accounting.send')] }, async (req) => {
    const { ids } = parse(esignSendAccountantSchema, req.body);
    const rows = await db.select().from(schema.payslipSignatures).where(and(eq(schema.payslipSignatures.orgId, req.org!.id), inArray(schema.payslipSignatures.id, ids)));
    const ready = rows.filter((r) => r.status === 'signed' && r.signedKey && !r.sentToAccountantAt);
    if (!ready.length) throw badRequest('Nenhum documento assinado para enviar (ou já foram enviados).');
    for (const r of ready) {
      const buf = await readStoredFile(r.signedKey!);
      const saved = await saveFile(req.org!.id, buf, 'pdf');
      const [doc] = await db.insert(schema.accountingDocuments).values({
        orgId: req.org!.id, direction: 'to_accountant', kind: r.kind === 'term' ? 'other' : 'payslip', competence: r.kind === 'term' ? null : r.competence,
        note: `${r.kind === 'term' ? 'Termo de aceite de assinatura eletrônica assinado' : 'Holerite assinado eletronicamente'} por ${r.employeeName}`.slice(0, 500),
        originalName: fileName(r, true), mime: 'application/pdf', size: buf.length, storageKey: saved.key, sha256: saved.sha256, detected: null, uploadedBy: req.user!.id,
      }).returning({ id: schema.accountingDocuments.id });
      await db.update(schema.payslipSignatures).set({ accountingDocId: doc!.id, sentToAccountantAt: new Date() }).where(eq(schema.payslipSignatures.id, r.id));
    }
    await audit(req, {
      action: 'payroll.esign.accountant', entityType: 'payslip_signature', entityId: ready[0]!.id,
      description: `Enviou ${ready.length} documento(s) assinado(s) para o contador (${[...new Set(ready.map((r) => (r.kind === 'term' ? 'termo de aceite' : `holerite de ${refLabelPT(r.competence)}`)))].join(', ')})`,
      details: { employees: ready.map((r) => r.employeeName) },
    });
    return { sent: ready.length };
  });

  // ================================================================ página pública (funcionário, sem login)
  const strict = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
  const gone = () => notFound('Este link não é válido. Peça um novo link à empresa.');
  const byToken = async (token: string) => {
    if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) throw gone();
    const [r] = await db.select().from(schema.payslipSignatures).where(eq(schema.payslipSignatures.tokenHash, hashToken(token)));
    if (!r) throw gone();
    const [org] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, r.orgId));
    if (!org) throw gone();
    return { r, org };
  };
  const checkKey = (r: Row, key: string | undefined) => {
    if (!key || !verifyFileToken(`esign:${r.id}`, key)) throw new HttpError(401, 'Sua sessão expirou. Informe o CPF de novo.', 'esign_expired');
  };

  /** Antes do CPF: só o nome da empresa, o primeiro nome e o mês. */
  app.get<{ Params: { token: string } }>('/api/sign/:token', strict, async (req): Promise<EsignPublicInfo> => {
    const { r, org } = await byToken(req.params.token);
    return { kind: r.kind as EsignKind, company: org.name, firstName: r.employeeName.trim().split(/\s+/)[0] ?? '', competence: r.competence, status: r.status as EsignPublicInfo['status'] };
  });

  /** Confere o CPF e abre o holerite. Depois de alguns erros o link trava por um tempo. */
  app.post<{ Params: { token: string } }>('/api/sign/:token/open', strict, async (req): Promise<EsignOpened> => {
    const { cpf } = parse(esignOpenSchema, req.body);
    const { r, org } = await byToken(req.params.token);
    if (r.lockedUntil && r.lockedUntil > new Date()) throw new HttpError(429, `Muitas tentativas. Tente de novo em ${Math.max(1, Math.ceil((r.lockedUntil.getTime() - Date.now()) / 60000))} min.`, 'esign_locked');
    if (digits(cpf) !== digits(r.employeeDocument)) {
      const n = r.failedAttempts + 1, lock = n >= ESIGN_MAX_ATTEMPTS;
      await db.update(schema.payslipSignatures).set({ failedAttempts: lock ? 0 : n, lockedUntil: lock ? new Date(Date.now() + ESIGN_LOCK_MINUTES * 60000) : null }).where(eq(schema.payslipSignatures.id, r.id));
      throw badRequest(lock ? `CPF não confere. O link ficou bloqueado por ${ESIGN_LOCK_MINUTES} minutos.` : 'CPF não confere com o do cadastro. Confira e tente de novo.', 'esign_cpf');
    }
    await db.update(schema.payslipSignatures).set({ failedAttempts: 0, lockedUntil: null, viewedAt: r.viewedAt ?? new Date() }).where(eq(schema.payslipSignatures.id, r.id));
    const [emp] = r.employeeId ? await db.select().from(schema.employees).where(eq(schema.employees.id, r.employeeId)) : [];
    const base = { key: signFileToken(`esign:${r.id}`, 30 * 60), kind: r.kind as EsignKind, company: legalName(org), employeeName: r.employeeName, competence: r.competence, status: r.status as EsignOpened['status'], signedAt: r.signedAt?.toISOString() ?? null };
    if (r.kind === 'term') {
      const t = r.slip as { term?: string[] };
      return { ...base, net: '0.00', totalEarnings: '0.00', totalDeductions: '0.00', items: [], termPending: false, termToken: null, term: t.term ?? [] };
    }
    // holerite: o termo de aceite vem antes (documento próprio, com o link dele)
    let termToken: string | null = null;
    const pending = r.status === 'pending' && !termAccepted(emp);
    if (pending && emp) {
      const term = await ensureTerm(org, emp, null);
      termToken = term ? decryptSecret(term.tokenEnc) : null;
    }
    const slip = r.slip as unknown as Payslip;
    return {
      ...base, net: r.net, totalEarnings: slip.totalEarnings, totalDeductions: slip.totalDeductions,
      items: (slip.items ?? []).map((i) => ({ name: i.name, ref: i.ref, kind: i.kind, amount: i.amount })),
      termPending: pending, termToken, term: [],
    };
  });

  /** O PDF: o holerite a assinar ou, depois de assinado, a via do funcionário. */
  app.get<{ Params: { token: string }; Querystring: { k?: string; download?: string } }>('/api/sign/:token/file', strict, async (req, reply) => {
    const { r } = await byToken(req.params.token);
    checkKey(r, req.query.k);
    const signed = r.status === 'signed' && !!r.signedKey;
    reply.header('Content-Type', 'application/pdf').header('Cache-Control', 'private, no-store')
      .header('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(fileName(r, signed))}`);
    return reply.send(await readStoredFile(signed ? r.signedKey! : r.storageKey));
  });

  /** Assina: grava o aceite do termo (1ª vez), gera o PDF com o comprovante e fecha o link para novas assinaturas. */
  app.post<{ Params: { token: string } }>('/api/sign/:token/sign', strict, async (req) => {
    const body = parse(esignSubmitSchema, req.body);
    const { r, org } = await byToken(req.params.token);
    checkKey(r, body.key);
    if (r.status === 'signed') throw conflict('Este documento já foi assinado.');
    const [emp] = r.employeeId ? await db.select().from(schema.employees).where(eq(schema.employees.id, r.employeeId)) : [];
    const term = r.kind === 'term';
    if (!term && !termAccepted(emp)) throw badRequest('Antes de assinar o holerite, assine o termo de aceite de assinatura eletrônica.', 'esign_term');
    const png = Buffer.from(body.signature.slice('data:image/png;base64,'.length), 'base64');
    if (png.length < 200 || png.subarray(0, 8).toString('latin1') !== '\x89PNG\r\n\x1a\n') throw badRequest('Desenhe a sua assinatura no quadro.');
    const now = new Date();
    const ip = req.ip ?? null, ua = req.headers['user-agent']?.slice(0, 400) ?? null;
    let pdf: Buffer;
    try {
      pdf = await buildSignedPdf({
        kind: r.kind as EsignKind, original: await readStoredFile(r.storageKey), originalSha256: r.sha256, id: r.id,
        company: term ? ((r.slip as { company?: string }).company ?? legalName(org)) : legalName(org), companyDocument: org.document,
        employeeName: r.employeeName, employeeDocument: r.employeeDocument, competence: r.competence, net: r.net, signaturePng: png,
        signedAt: now, timezone: org.timezone, ip, userAgent: ua, termAcceptedAt: term ? null : emp?.esignAcceptedAt ?? null, termVersion: ESIGN_TERM_VERSION,
      });
    } catch (err) {
      req.log.error({ err }, 'falha ao gerar o documento assinado');
      throw badRequest('Não consegui gerar o documento assinado. Limpe a assinatura, desenhe de novo e tente outra vez.');
    }
    const saved = await saveFile(r.orgId, pdf, 'pdf');
    // só uma assinatura vale: a troca de pending → signed é a trava
    const done = await db.update(schema.payslipSignatures)
      .set({ status: 'signed', signedKey: saved.key, signedSha256: saved.sha256, signedSize: pdf.length, signedAt: now, signerIp: ip, signerUa: ua, termVersion: ESIGN_TERM_VERSION })
      .where(and(eq(schema.payslipSignatures.id, r.id), eq(schema.payslipSignatures.status, 'pending'))).returning({ id: schema.payslipSignatures.id });
    if (!done.length) { await deleteFile(saved.key); throw conflict('Este documento já foi assinado.'); }
    if (term && emp) await db.update(schema.employees).set({ esignAcceptedAt: now, esignTermVersion: ESIGN_TERM_VERSION, esignAcceptedIp: ip }).where(eq(schema.employees.id, emp.id));
    await audit(req, {
      orgId: r.orgId, action: 'payroll.esign.signed', entityType: 'payslip_signature', entityId: r.id,
      description: `${r.employeeName} assinou eletronicamente ${what(r)}`,
      details: { kind: r.kind, competence: term ? null : r.competence, sha256: r.sha256, signedSha256: saved.sha256 },
    });
    return { ok: true, signedAt: now.toISOString() };
  });
}
