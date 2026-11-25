import https from 'node:https';
import tls from 'node:tls';
import { gunzipSync } from 'node:zlib';
import { X509Certificate } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import {
  DIST_BLOCKED, DIST_FOUND, DIST_NONE, FISCAL_MAX_BATCHES, FISCAL_MIN_GAP_MS, NFE_EVENT_CANCEL, UF_CODES,
  distRequestXml, docKey, parseDistResponse, parseNfe, parseNfeEvent, parseNfeSummary, sameCnpjRoot, todayISO,
  type FiscalConfigView,
} from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { HttpError, badRequest } from '../lib/errors.js';
import { openCertificate } from '../lib/secrets.js';
import { notifyAdmins, orgAdmins } from './orgRemoval.js';

/**
 * Consulta de NF-e recebidas pela distribuição DF-e da SEFAZ (Ambiente Nacional).
 *
 * Regras de segurança:
 * - o .pfx e a senha só são decifrados na memória, na hora da consulta; nunca vão para disco, log ou tela;
 * - a SEFAZ bloqueia por 1 hora o CNPJ que consulta demais (656 "consumo indevido") — e o bloqueio vale para
 *   todos os sistemas do CNPJ (o ERP também). Por isso: no máximo 1 consulta automática por dia, folga de
 *   2 h entre consultas e, no primeiro 656 ou resposta inesperada, a consulta automática se desliga sozinha.
 */

const ENDPOINT = { host: 'www1.nfe.fazenda.gov.br', path: '/NFeDistribuicaoDFe/NFeDistribuicaoDFe.asmx' };
const MAX_RESPONSE = 20 * 1024 * 1024;
const MAX_DOC = 5 * 1024 * 1024;

export type FiscalConfig = typeof schema.fiscalConfigs.$inferSelect;

// ------------------------------------------------------------------ certificado
export interface CertInfo { subject: string; document: string | null; notBefore: Date; notAfter: Date; fingerprint: string }

/** Abre o .pfx na memória e devolve os dados públicos. Erros viram mensagens para a pessoa. */
export function readCertificate(pfx: Buffer, passphrase: string): CertInfo {
  let ctx: tls.SecureContext;
  try {
    ctx = tls.createSecureContext({ pfx, passphrase });
  } catch (e) {
    const msg = String((e as Error).message ?? '');
    if (/mac verify|password|bad decrypt/i.test(msg)) throw badRequest('A senha do certificado não confere.', 'cert_password');
    if (/unsupported/i.test(msg)) throw badRequest('Este certificado usa uma cifra antiga que o servidor não abre. Peça à certificadora o arquivo em formato atual (ou exporte de novo com AES).', 'cert_legacy');
    throw badRequest('Não foi possível abrir o arquivo. Envie o certificado A1 no formato .pfx ou .p12.', 'cert_invalid');
  }
  const sock = new tls.TLSSocket(null as never, { secureContext: ctx });
  try {
    const c = sock.getCertificate() as tls.PeerCertificate | null;
    if (!c || !('raw' in c) || !c.raw) throw badRequest('O arquivo não tem a chave do certificado. Envie o A1 completo (.pfx).', 'cert_invalid');
    const x = new X509Certificate(c.raw);
    const cn = /(?:^|\n)CN=([^\n]+)/.exec(x.subject)?.[1] ?? x.subject;
    // ICP-Brasil: "RAZÃO SOCIAL:CNPJ" no nome comum
    const doc = /:\s*([0-9A-Z]{14}|\d{11})\s*$/.exec(cn)?.[1] ?? null;
    return { subject: cn.slice(0, 300), document: doc, notBefore: new Date(x.validFrom), notAfter: new Date(x.validTo), fingerprint: x.fingerprint256 };
  } finally {
    sock.destroy();
  }
}

/** O certificado precisa ser da mesma empresa do espaço (raiz do CNPJ) e estar na validade. */
export function assertCertificateFits(info: CertInfo, orgDocument: string | null) {
  const now = Date.now();
  if (info.notAfter.getTime() < now) throw badRequest('Este certificado já venceu. Envie o certificado novo.', 'cert_expired');
  if (info.notBefore.getTime() > now + 86_400_000) throw badRequest('Este certificado ainda não começou a valer.', 'cert_not_yet');
  if (!orgDocument || docKey(orgDocument).length !== 14) throw badRequest('Preencha o CNPJ do espaço em Configuração do espaço antes de enviar o certificado.', 'org_document');
  if (!info.document || !sameCnpjRoot(info.document, orgDocument)) {
    throw badRequest('Este certificado é de outra empresa: o CNPJ dele não é o do espaço.', 'cert_other_company');
  }
}

// ------------------------------------------------------------------ chamada à SEFAZ
function post(pfx: Buffer, passphrase: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.request({
      ...ENDPOINT, method: 'POST', pfx, passphrase, agent: false, timeout: 60_000,
      headers: { 'Content-Type': 'application/soap+xml; charset=utf-8', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_RESPONSE) { req.destroy(new Error('resposta grande demais')); return; }
        chunks.push(c);
      });
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if ((res.statusCode ?? 0) >= 400 && !text.includes('retDistDFeInt')) reject(new Error(`A SEFAZ respondeu HTTP ${res.statusCode}`));
        else resolve(text);
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('A SEFAZ não respondeu a tempo')));
    req.on('error', reject);
    req.end(body);
  });
}

// ------------------------------------------------------------------ gravação dos documentos
type Org = { id: string; document: string | null };

export async function ingestDocument(org: Org, nsu: number, schemaName: string, content: string) {
  let xml: string;
  try {
    xml = gunzipSync(Buffer.from(content, 'base64'), { maxOutputLength: MAX_DOC }).toString('utf8');
  } catch {
    return 'skipped' as const;
  }
  const t = schema.fiscalDocuments;
  if (schemaName.startsWith('procNFe')) {
    const n = parseNfe(xml);
    if (!n) return 'skipped' as const;
    const role = n.recipientDocument && sameCnpjRoot(n.recipientDocument, org.document) ? 'recipient' : 'other';
    const data = {
      nsu, kind: 'full', role, number: n.number, series: n.series, issuedAt: n.issuedAt, emitterDocument: n.emitterDocument,
      emitterName: n.emitterName?.slice(0, 200) ?? null, total: n.total, nature: n.nature?.slice(0, 120) ?? null,
      duplicates: n.duplicates, paymentKinds: n.paymentKinds, xml,
    };
    await db.insert(t).values({ orgId: org.id, accessKey: n.key, ...data })
      .onConflictDoUpdate({ target: [t.orgId, t.accessKey], set: { ...data, updatedAt: new Date() } });
    return 'note' as const;
  }
  if (schemaName.startsWith('resNFe')) {
    const s = parseNfeSummary(xml);
    if (!s) return 'skipped' as const;
    const data = {
      nsu, emitterDocument: s.emitterDocument, emitterName: s.emitterName?.slice(0, 200) ?? null, issuedAt: s.issuedAt,
      total: s.total, situation: s.situation,
    };
    // o resumo nunca sobrescreve uma nota já completa (só a situação)
    await db.insert(t).values({ orgId: org.id, accessKey: s.key, kind: 'summary', xml, ...data })
      .onConflictDoUpdate({ target: [t.orgId, t.accessKey], set: { situation: sql`case when excluded.situation = 'authorized' then ${t.situation} else excluded.situation end`, updatedAt: new Date() } });
    return 'note' as const;
  }
  if (schemaName.startsWith('resEvento') || schemaName.startsWith('procEvento')) {
    const e = parseNfeEvent(xml);
    if (e?.type === NFE_EVENT_CANCEL) {
      await db.update(t).set({ situation: 'canceled', updatedAt: new Date() }).where(and(eq(t.orgId, org.id), eq(t.accessKey, e.key)));
    }
    return 'event' as const;
  }
  return 'skipped' as const;
}

// ------------------------------------------------------------------ consulta
export interface QueryResult { status: string; message: string; notes: number; events: number; batches: number; paused: boolean }

const running = new Set<string>();

async function pause(orgId: string, orgName: string, reason: string) {
  await db.update(schema.fiscalConfigs).set({ pausedAt: new Date(), pausedReason: reason }).where(eq(schema.fiscalConfigs.orgId, orgId));
  await notifyAdmins(await orgAdmins(orgId), `NoPaper: consulta de notas fiscais pausada em ${orgName}`, [
    `A consulta automática de notas fiscais na SEFAZ do espaço "${orgName}" foi desligada por segurança.`,
    `Motivo: ${reason}`,
    'Nada foi perdido: as notas continuam na SEFAZ. Para voltar, religue a consulta em Configuração do espaço → Notas fiscais (SEFAZ).',
  ]).catch(() => undefined);
}

/**
 * Faz a consulta (lotes de 50 até chegar ao fim da fila, no máximo FISCAL_MAX_BATCHES).
 * Nunca roda duas ao mesmo tempo para o mesmo espaço; respeita `nextAllowedAt`.
 */
export async function runFiscalQuery(orgId: string, trigger: 'auto' | 'manual'): Promise<QueryResult> {
  if (running.has(orgId)) throw new HttpError(409, 'Já há uma consulta em andamento neste espaço.', 'fiscal_running');
  running.add(orgId);
  try {
    const lock = await db.execute<{ ok: boolean }>(sql`select pg_try_advisory_lock(hashtext(${'nopaper:fiscal:' + orgId})) as ok`);
    if (!lock.rows[0]?.ok) throw new HttpError(409, 'Já há uma consulta em andamento neste espaço.', 'fiscal_running');
    try {
      return await query(orgId, trigger);
    } finally {
      await db.execute(sql`select pg_advisory_unlock(hashtext(${'nopaper:fiscal:' + orgId}))`);
    }
  } finally {
    running.delete(orgId);
  }
}

async function query(orgId: string, trigger: 'auto' | 'manual'): Promise<QueryResult> {
  const [cfg] = await db.select().from(schema.fiscalConfigs).where(eq(schema.fiscalConfigs.orgId, orgId));
  const [org] = await db.select({ id: schema.organizations.id, name: schema.organizations.name, document: schema.organizations.document, state: schema.organizations.state, timezone: schema.organizations.timezone })
    .from(schema.organizations).where(eq(schema.organizations.id, orgId));
  if (!cfg || !org) throw badRequest('A consulta de notas fiscais não está configurada.', 'fiscal_not_configured');
  if (cfg.nextAllowedAt && cfg.nextAllowedAt.getTime() > Date.now()) {
    throw new HttpError(409, `Para não ser bloqueado pela SEFAZ, a próxima consulta só pode sair depois de ${cfg.nextAllowedAt.toLocaleTimeString('pt-BR', { timeZone: org.timezone, hour: '2-digit', minute: '2-digit' })}.`, 'fiscal_wait', { nextAllowedAt: cfg.nextAllowedAt.toISOString() });
  }
  const pfx = openCertificate(cfg.certEnc);
  const pass = openCertificate(cfg.certPassEnc)?.toString('utf8') ?? null;
  if (!pfx || pass === null) throw badRequest('Envie o certificado digital A1 antes de consultar.', 'fiscal_no_cert');
  if (cfg.certNotAfter && cfg.certNotAfter.getTime() < Date.now()) throw badRequest('O certificado digital venceu. Envie o novo.', 'cert_expired');
  const uf = UF_CODES[cfg.uf ?? org.state ?? ''];
  if (!uf) throw badRequest('Escolha o estado (UF) da empresa na configuração das notas fiscais.', 'fiscal_uf');
  if (!org.document) throw badRequest('Preencha o CNPJ do espaço.', 'org_document');

  const t = schema.fiscalConfigs;
  let lastNsu = cfg.lastNsu;
  let maxNsu = cfg.maxNsu;
  let notes = 0; let events = 0; let batches = 0;
  let status = 'error'; let message = '';
  let paused = false;
  const today = todayISO(org.timezone);
  // marca antes de chamar: mesmo que o processo caia no meio, a próxima não sai em seguida
  await db.update(t).set({ nextAllowedAt: new Date(Date.now() + FISCAL_MIN_GAP_MS), ...(trigger === 'auto' ? { lastAutoDate: today } : {}) }).where(eq(t.orgId, orgId));

  try {
    while (batches < FISCAL_MAX_BATCHES) {
      batches++;
      const body = distRequestXml({ production: true, uf, document: org.document, lastNsu: String(lastNsu) });
      const r = parseDistResponse(await post(pfx, pass, body));
      status = r.cStat ?? 'error';
      message = r.xMotivo ?? 'Resposta sem motivo';
      if (r.cStat === DIST_BLOCKED) {
        paused = true;
        await pause(orgId, org.name, `a SEFAZ respondeu "${message}" (656). O bloqueio da SEFAZ é temporário (cerca de 1 hora) e vale para todos os sistemas que consultam este CNPJ.`);
        break;
      }
      if (r.cStat !== DIST_FOUND && r.cStat !== DIST_NONE) {
        paused = true;
        await pause(orgId, org.name, `a SEFAZ respondeu ${r.cStat ?? 'algo inesperado'}: ${message}`);
        break;
      }
      for (const d of r.docs) {
        const kind = await ingestDocument(org, Number(d.nsu), d.schema, d.content);
        if (kind === 'note') notes++;
        else if (kind === 'event') events++;
      }
      if (r.ultNSU) lastNsu = Math.max(lastNsu, Number(r.ultNSU));
      if (r.maxNSU) maxNsu = Number(r.maxNSU);
      await db.update(t).set({ lastNsu, maxNsu }).where(eq(t.orgId, orgId));
      // fim da fila: para aqui (a regra de 1 hora vale a partir deste ponto)
      if (r.cStat === DIST_NONE || !r.ultNSU || !r.maxNSU || Number(r.ultNSU) >= Number(r.maxNSU)) break;
    }
  } catch (e) {
    status = 'error';
    message = (e as Error).message?.slice(0, 300) || 'Falha de comunicação com a SEFAZ';
  }
  await db.update(t).set({
    lastQueryAt: new Date(), lastStatus: status.slice(0, 16), lastMessage: message.slice(0, 500),
    nextAllowedAt: new Date(Date.now() + (paused ? 3 : 2) * 60 * 60 * 1000),
  }).where(eq(t.orgId, orgId));
  return { status, message, notes, events, batches, paused };
}

// ------------------------------------------------------------------ job diário
const hourIn = (tz: string) => Number(new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));

/** A cada 15 min: espaços com a consulta ligada cuja hora já chegou e que ainda não consultaram hoje. */
export async function runFiscalTick() {
  const rows = await db.select({ cfg: schema.fiscalConfigs, org: { id: schema.organizations.id, timezone: schema.organizations.timezone, kind: schema.organizations.kind, archivedAt: schema.organizations.archivedAt, deletionDueAt: schema.organizations.deletionDueAt } })
    .from(schema.fiscalConfigs).innerJoin(schema.organizations, eq(schema.organizations.id, schema.fiscalConfigs.orgId))
    .where(and(eq(schema.fiscalConfigs.enabled, true), sql`${schema.fiscalConfigs.pausedAt} is null`, sql`${schema.fiscalConfigs.certEnc} is not null`));
  let ran = 0;
  for (const { cfg, org } of rows) {
    if (org.kind !== 'company' || org.archivedAt || org.deletionDueAt) continue;
    try {
      await warnExpiry(cfg, org.id);
      if (cfg.lastAutoDate === todayISO(org.timezone)) continue;
      if (hourIn(org.timezone) < cfg.queryHour) continue;
      if (cfg.nextAllowedAt && cfg.nextAllowedAt.getTime() > Date.now()) continue;
      await runFiscalQuery(org.id, 'auto');
      ran++;
    } catch { /* um espaço com problema não para os outros */ }
  }
  return { ran };
}

/** Aviso aos administradores 30 dias antes de o certificado vencer (uma vez por certificado). */
async function warnExpiry(cfg: FiscalConfig, orgId: string) {
  if (!cfg.certNotAfter) return;
  const left = cfg.certNotAfter.getTime() - Date.now();
  if (left > 30 * 86_400_000) return;
  if (cfg.expiryWarnedFor && cfg.expiryWarnedFor.getTime() === cfg.certNotAfter.getTime()) return;
  const [org] = await db.select({ name: schema.organizations.name }).from(schema.organizations).where(eq(schema.organizations.id, orgId));
  await db.update(schema.fiscalConfigs).set({ expiryWarnedFor: cfg.certNotAfter }).where(eq(schema.fiscalConfigs.orgId, orgId));
  await notifyAdmins(await orgAdmins(orgId), `NoPaper: certificado digital de ${org?.name ?? 'um espaço'} vence em breve`, [
    `O certificado digital A1 usado para consultar as notas fiscais do espaço "${org?.name}" vence em ${cfg.certNotAfter.toLocaleDateString('pt-BR')}.`,
    'Renove com a certificadora e envie o arquivo novo em Configuração do espaço → Notas fiscais (SEFAZ). Depois do vencimento a consulta para.',
  ]).catch(() => undefined);
}

// ------------------------------------------------------------------ tela
export async function fiscalView(orgId: string): Promise<FiscalConfigView> {
  const [cfg] = await db.select().from(schema.fiscalConfigs).where(eq(schema.fiscalConfigs.orgId, orgId));
  const d = schema.fiscalDocuments;
  const start = cfg?.startDate ?? null;
  const inRange = start ? sql`(${d.issuedAt} is null or ${d.issuedAt} >= ${start})` : sql`true`;
  const [{ n, total, older }] = await db.select({
    n: sql<number>`(count(*) filter (where ${d.status} = 'new' and ${d.role} = 'recipient' and ${inRange}))::int`,
    total: sql<number>`(count(*) filter (where ${inRange}))::int`,
    older: sql<number>`(count(*) filter (where not ${inRange}))::int`,
  }).from(d).where(eq(d.orgId, orgId));
  const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
  return {
    enabled: cfg?.enabled ?? false,
    queryHour: cfg?.queryHour ?? 6,
    startDate: cfg?.startDate ?? null,
    uf: cfg?.uf ?? null,
    categoryId: cfg?.categoryId ?? null,
    folderId: cfg?.folderId ?? null,
    certificate: cfg?.certEnc ? {
      subject: cfg.certSubject ?? '', document: cfg.certDocument, notBefore: iso(cfg.certNotBefore)!, notAfter: iso(cfg.certNotAfter)!,
      fingerprint: cfg.certFingerprint ?? '', uploadedAt: iso(cfg.certUploadedAt), uploadedByName: cfg.certUploadedByName,
    } : null,
    lastQueryAt: iso(cfg?.lastQueryAt), lastStatus: cfg?.lastStatus ?? null, lastMessage: cfg?.lastMessage ?? null,
    pausedAt: iso(cfg?.pausedAt), pausedReason: cfg?.pausedReason ?? null, nextAllowedAt: iso(cfg?.nextAllowedAt),
    lastNsu: String(cfg?.lastNsu ?? 0),
    newCount: n,
    docCount: total,
    olderCount: older,
  };
}
