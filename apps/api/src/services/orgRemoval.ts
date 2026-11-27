import path from 'node:path';
import { rm } from 'node:fs/promises';
import { and, eq, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { env } from '../env.js';
import { audit } from '../lib/audit.js';
import { currentOperation } from './backup.js';
import { escapeHtml, sendEmail, telegramSend, telegramToken } from './notify.js';
import { storageUsage } from './storageQuota.js';

/**
 * Arquivar e remover um espaço.
 *
 * - **Arquivar**: só leitura (`assertOrgWritable` em lib/auth.ts), fora da lista principal do seletor,
 *   sem avisos, webhooks nem extensão de recorrências. Volta quando quiser.
 * - **Remover**: nunca na hora. O pedido (dono, ou a plataforma num espaço sem dono ativo) abre um prazo
 *   de `REMOVAL_DAYS` dias: o espaço some para os membros (o dono ainda vê, só leitura, e pode cancelar),
 *   os tokens de integração param. Avisos aos administradores no pedido, 1 dia antes e na remoção.
 *   O job `orgs.purge` apaga do banco e depois a pasta de anexos — nunca durante backup/restauração.
 */
export const REMOVAL_DAYS = 7;
const DAY = 86_400_000;

/** Nome que pode ir na auditoria da plataforma (lida por todos os administradores dela). */
export const platformLabel = (o: { name: string; isPrivate: boolean }) => (o.isPrivate ? 'um espaço privado' : `o espaço ${o.name}`);

export interface RemovalImpact {
  payable: number; receivable: number; attachments: number; storageBytes: number;
  cards: number; cardTransactions: number; bankTransactions: number;
  employees: number; payrollPeriods: number; signatures: number; accountingDocs: number;
  members: number; apiTokens: number;
  /** Avisos (não bloqueiam). */
  pendingSignatures: number; unreviewedAccounting: number;
}

export async function removalImpact(orgId: string): Promise<RemovalImpact> {
  const n = (t: string, extra = '') => sql.raw(`(select count(*) from ${t} where org_id = '${orgId}'${extra})::int`);
  // orgId vem sempre do banco/da sessão (uuid validado); conferido de novo aqui por segurança
  if (!/^[0-9a-f-]{36}$/i.test(orgId)) throw new Error('espaço inválido');
  const r = await db.execute<Omit<RemovalImpact, 'storageBytes'>>(sql`select
    ${n('bills', " and type = 'payable'")} as payable, ${n('bills', " and type = 'receivable'")} as receivable,
    ${n('attachments')} as attachments, ${n('cards')} as cards, ${n('card_transactions')} as "cardTransactions",
    ${n('bank_transactions')} as "bankTransactions", ${n('employees')} as employees, ${n('payroll_periods')} as "payrollPeriods",
    ${n('payslip_signatures', " and status = 'signed'")} as signatures, ${n('accounting_documents')} as "accountingDocs",
    ${n('memberships', ' and active')} as members, ${n('api_tokens')} as "apiTokens",
    ${n('payslip_signatures', " and status = 'pending'")} as "pendingSignatures",
    ${n('accounting_documents', " and status = 'new' and hidden_at is null")} as "unreviewedAccounting"`);
  return { ...r.rows[0]!, storageBytes: await storageUsage(orgId) };
}

/** Dono e administradores ativos do espaço (quem recebe os avisos da remoção). */
export async function orgAdmins(orgId: string) {
  const r = await db.execute<{ id: string; name: string; email: string; telegram_chat_id: string | null; is_owner: boolean }>(sql`
    select u.id, u.name, u.email, u.telegram_chat_id, m.is_owner
    from memberships m join users u on u.id = m.user_id
    where m.org_id = ${orgId} and m.active and u.active and u.deleted_at is null
      and (m.is_owner or exists (select 1 from membership_groups mg join groups g on g.id = mg.group_id where mg.membership_id = m.id and g.is_admin))`);
  return r.rows;
}

/** Espaço sem dono ativo (o dono teve a conta desativada/removida, ou saiu): só aí a plataforma pode pedir a remoção. */
export async function hasActiveOwner(orgId: string) {
  const r = await db.execute<{ ok: boolean }>(sql`select exists (
    select 1 from memberships m join users u on u.id = m.user_id
    where m.org_id = ${orgId} and m.is_owner and m.active and u.active and u.deleted_at is null) as ok`);
  return !!r.rows[0]?.ok;
}

type Admin = Awaited<ReturnType<typeof orgAdmins>>[number];

/** Aviso por e-mail (SMTP da plataforma) e Telegram (quem ligou o próprio chat). Falha de envio não interrompe nada. */
export async function notifyAdmins(admins: Admin[], subject: string, lines: string[]) {
  const text = lines.join('\n\n');
  const html = `<div style="font-family:system-ui,sans-serif;font-size:14px;line-height:1.5">${lines.map((l) => `<p>${escapeHtml(l)}</p>`).join('')}</div>`;
  const emails = admins.map((a) => a.email).filter((e) => e && !e.endsWith('.invalid'));
  if (emails.length) await sendEmail(emails, subject, html, text).catch(() => undefined);
  const chats = admins.map((a) => a.telegram_chat_id).filter((c): c is string => !!c);
  if (chats.length) {
    const token = await telegramToken().catch(() => null);
    if (token) for (const c of chats) await telegramSend(token, c, `<b>${escapeHtml(subject)}</b>\n\n${lines.map(escapeHtml).join('\n\n')}`).catch(() => undefined);
  }
}

const dateBR = (d: Date) => d.toLocaleString('pt-BR', { timeZone: env.TZ_DEFAULT, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const link = () => `${env.APP_URL.replace(/\/$/, '')}/config/organizacao`;

export async function notifyRequested(org: { id: string; name: string }, byName: string, dueAt: Date, byPlatform: boolean) {
  await notifyAdmins(await orgAdmins(org.id), `NoPaper: o espaço ${org.name} será removido em ${REMOVAL_DAYS} dias`, [
    `${byName}${byPlatform ? ' (administração da plataforma)' : ''} pediu a remoção do espaço "${org.name}".`,
    `Tudo o que está nele (contas, anexos, cartões, folha, documentos) será apagado de vez em ${dateBR(dueAt)}. Até lá o espaço fica fora do ar para os membros.`,
    byPlatform ? 'Se isso for um engano, fale com o administrador da plataforma para cancelar.' : `Para cancelar: ${link()}`,
  ]);
}

export async function notifyCancelled(org: { id: string; name: string }, byName: string) {
  await notifyAdmins(await orgAdmins(org.id), `NoPaper: remoção do espaço ${org.name} cancelada`, [
    `${byName} cancelou a remoção do espaço "${org.name}". Ele voltou ao normal para todos os membros.`,
  ]);
}

/** Apaga o espaço de vez: banco (em ordem, por causa das ligações "restrict" entre tabelas do espaço) e arquivos. */
export async function purgeOrg(orgId: string) {
  const [o] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
  if (!o || !o.deletionDueAt) return false;
  const admins = await orgAdmins(orgId);
  const impact = await removalImpact(orgId);
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'nopaper:purge:' + orgId}))`);
    // confere de novo dentro da transação: pode ter sido cancelada agora mesmo
    const [still] = await tx.select({ due: schema.organizations.deletionDueAt }).from(schema.organizations).where(eq(schema.organizations.id, orgId)).for('update');
    if (!still?.due || still.due > new Date()) throw new CancelledPurge();
    await tx.delete(schema.payrollEntries).where(eq(schema.payrollEntries.orgId, orgId));
    await tx.delete(schema.payrollThirteenth).where(eq(schema.payrollThirteenth.orgId, orgId));
    await tx.delete(schema.cardTransactions).where(eq(schema.cardTransactions.orgId, orgId));
    await tx.delete(schema.bills).where(eq(schema.bills.orgId, orgId));
    await tx.delete(schema.cards).where(eq(schema.cards.orgId, orgId));
    await tx.delete(schema.organizations).where(eq(schema.organizations.id, orgId));
  }).catch((e) => { if (e instanceof CancelledPurge) return 'cancelled'; throw e; });
  const [gone] = await db.select({ id: schema.organizations.id }).from(schema.organizations).where(eq(schema.organizations.id, orgId));
  if (gone) return false;
  // arquivos: só a pasta deste espaço (uuid conferido; nunca a raiz)
  if (/^[0-9a-f-]{36}$/i.test(orgId)) await rm(path.join(path.resolve(env.STORAGE_DIR), orgId), { recursive: true, force: true }).catch(() => undefined);
  await audit(null, {
    orgId: null, action: 'platform.org_deleted', entityType: 'organization', entityId: orgId,
    description: `Removeu ${platformLabel(o)} (pedido por ${o.deletionRequestedByName ?? 'alguém'}${o.deletionByPlatform ? ', pela plataforma' : ''})`,
    details: o.isPrivate ? { private: true } : { name: o.name, requestedBy: o.deletionRequestedByName, impact },
  });
  await notifyAdmins(admins, `NoPaper: o espaço ${o.name} foi removido`, [
    `O espaço "${o.name}" foi removido, como pedido por ${o.deletionRequestedByName ?? 'um administrador'}. Os dados e arquivos dele foram apagados.`,
    'Os backups da instalação feitos antes desta data ainda contêm esses dados até saírem do rodízio.',
  ]);
  return true;
}
class CancelledPurge extends Error {}

/** Job: aviso de 1 dia antes e remoção dos espaços com o prazo vencido. */
export async function runOrgPurgeTick() {
  const now = new Date();
  let reminded = 0, purged = 0, failed = 0;
  const soon = await db.select().from(schema.organizations).where(and(
    isNotNull(schema.organizations.deletionDueAt), isNull(schema.organizations.deletionReminderAt),
    lte(schema.organizations.deletionDueAt, new Date(now.getTime() + DAY)),
  ));
  for (const o of soon) {
    if (o.deletionDueAt! <= now) continue; // já vence agora: vai direto para a remoção
    await db.update(schema.organizations).set({ deletionReminderAt: now }).where(eq(schema.organizations.id, o.id));
    await notifyAdmins(await orgAdmins(o.id), `NoPaper: o espaço ${o.name} será removido amanhã`, [
      `Lembrete: o espaço "${o.name}" será apagado de vez em ${dateBR(o.deletionDueAt!)}.`,
      o.deletionByPlatform ? 'Se isso for um engano, fale com o administrador da plataforma para cancelar.' : `Para cancelar: ${link()}`,
    ]);
    reminded++;
  }
  // backup ou restauração em andamento: deixa para a próxima rodada (o arquivo de backup ficaria pela metade)
  if (currentOperation()) return { reminded, purged, waiting: 'operation' };
  const due = await db.select({ id: schema.organizations.id }).from(schema.organizations)
    .where(and(isNotNull(schema.organizations.deletionDueAt), lte(schema.organizations.deletionDueAt, now)));
  for (const o of due) {
    try { if (await purgeOrg(o.id)) purged++; } catch (err) { failed++; console.error(`[orgs.purge] espaço ${o.id}: ${(err as Error).message}`); }
  }
  return { reminded, purged, failed };
}
