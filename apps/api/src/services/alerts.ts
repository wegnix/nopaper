import { and, asc, eq, inArray, lt, notInArray, sql } from 'drizzle-orm';
import {
  addDaysISO, alertConfigSchema, formatBRL, formatDateBR, sumMoney, todayISO, diffDaysISO, type AlertConfig, type BillType,
} from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { env } from '../env.js';
import { getOrgSetting, setOrgSetting } from '../lib/settings.js';
import { restrictedCategoryIds } from './bills.js';
import { escapeHtml, sendEmail, telegramSend, telegramToken } from './notify.js';

export interface StoredAlerts extends AlertConfig {
  lastSentOn?: string | null;
  pendingLink?: { code: string; expiresAt: number } | null;
}

export async function loadAlertConfig(orgId: string): Promise<StoredAlerts> {
  const raw = await getOrgSetting<StoredAlerts>(orgId, 'alerts');
  const parsed = alertConfigSchema.safeParse(raw ?? {});
  const base = parsed.success ? parsed.data : alertConfigSchema.parse({});
  return { ...base, lastSentOn: raw?.lastSentOn ?? null, pendingLink: raw?.pendingLink ?? null };
}
export async function saveAlertConfig(orgId: string, cfg: StoredAlerts) {
  await setOrgSetting(orgId, 'alerts', cfg);
}

// ------------------------------------------------------------------ montagem do resumo
interface Item { description: string; amount: string; dueDate: string }
interface Section { title: string; items: Item[]; tone: 'overdue' | 'today' | 'soon' }
interface TypeDigest { type: BillType; sections: Section[] }

const TYPE_TITLE: Record<BillType, string> = { payable: 'Contas a pagar', receivable: 'Contas a receber' };
const MAX_ITEMS = 15;

async function digestFor(orgId: string, type: BillType, rule: AlertConfig['payable'], today: string, hidden: string[]): Promise<TypeDigest | null> {
  if (!rule.enabled) return null;
  const base = and(eq(schema.bills.orgId, orgId), eq(schema.bills.type, type), eq(schema.bills.status, 'pending'),
    hidden.length ? notInArray(schema.bills.categoryId, hidden) : undefined);
  const cols = { description: schema.bills.description, amount: schema.bills.amount, dueDate: schema.bills.dueDate };
  const sections: Section[] = [];
  if (rule.overdue) {
    const items = await db.select(cols).from(schema.bills).where(and(base, lt(schema.bills.dueDate, today))).orderBy(asc(schema.bills.dueDate), sql`lower(${schema.bills.description})`);
    if (items.length) sections.push({ title: type === 'payable' ? 'Vencidas' : 'Atrasadas', items, tone: 'overdue' });
  }
  const days = [...new Set(rule.daysBefore)].sort((a, b) => a - b);
  if (days.length) {
    const dates = days.map((d) => addDaysISO(today, d));
    const rows = await db.select(cols).from(schema.bills).where(and(base, inArray(schema.bills.dueDate, dates))).orderBy(asc(schema.bills.dueDate), sql`lower(${schema.bills.description})`);
    for (const d of days) {
      const date = addDaysISO(today, d);
      const items = rows.filter((r) => r.dueDate === date);
      if (items.length) sections.push({ title: d === 0 ? 'Vencem hoje' : d === 1 ? 'Vencem amanhã' : `Vencem em ${d} dias (${formatDateBR(date).slice(0, 5)})`, items, tone: d === 0 ? 'today' : 'soon' });
    }
  }
  return sections.length ? { type, sections } : null;
}

export interface Digest { orgName: string; today: string; parts: TypeDigest[]; count: number }

export async function buildDigest(orgId: string, cfg: AlertConfig): Promise<Digest> {
  const [org] = await db.select({ name: schema.organizations.name, tz: schema.organizations.timezone }).from(schema.organizations).where(eq(schema.organizations.id, orgId));
  const today = todayISO(org?.tz);
  const hidden = cfg.includeRestricted ? [] : await restrictedCategoryIds(orgId);
  const parts = (await Promise.all([
    digestFor(orgId, 'payable', cfg.payable, today, hidden),
    digestFor(orgId, 'receivable', cfg.receivable, today, hidden),
  ])).filter((p): p is TypeDigest => !!p);
  const count = parts.reduce((a, p) => a + p.sections.reduce((b, s) => b + s.items.length, 0), 0);
  return { orgName: org?.name ?? 'NoPaper', today, parts, count };
}

const path = (t: BillType) => (t === 'payable' ? 'pagar' : 'receber');
const late = (today: string, due: string) => { const n = diffDaysISO(today, due); return n === 1 ? 'há 1 dia' : `há ${n} dias`; };

export function digestTelegram(d: Digest): string {
  const out: string[] = [`<b>NoPaper · ${escapeHtml(d.orgName)}</b>`, `Resumo de ${formatDateBR(d.today)}`];
  if (!d.parts.length) out.push('', 'Nenhuma conta vencida ou vencendo nos dias configurados. ✨');
  for (const p of d.parts) {
    out.push('', `<b>${TYPE_TITLE[p.type]}</b>`);
    for (const s of p.sections) {
      const icon = s.tone === 'overdue' ? '🔴' : s.tone === 'today' ? '🟡' : '🔵';
      out.push(`${icon} <b>${escapeHtml(s.title)}</b> — ${formatBRL(sumMoney(s.items.map((i) => i.amount)))}`);
      for (const i of s.items.slice(0, MAX_ITEMS)) {
        out.push(`• ${escapeHtml(i.description)} — ${formatBRL(i.amount)}${s.tone === 'overdue' ? ` <i>(${late(d.today, i.dueDate)})</i>` : ''}`);
      }
      if (s.items.length > MAX_ITEMS) out.push(`<i>… e mais ${s.items.length - MAX_ITEMS}</i>`);
    }
    out.push(`<a href="${env.APP_URL}/${path(p.type)}">Abrir ${TYPE_TITLE[p.type].toLowerCase()}</a>`);
  }
  return out.join('\n');
}

export function digestEmail(d: Digest): { subject: string; html: string; text: string } {
  const overdue = d.parts.flatMap((p) => p.sections.filter((s) => s.tone === 'overdue')).reduce((a, s) => a + s.items.length, 0);
  const subject = `NoPaper · ${d.orgName}: ${d.count} ${d.count === 1 ? 'conta' : 'contas'} para acompanhar${overdue ? ` (${overdue} em atraso)` : ''}`;
  const color = { overdue: '#d9483b', today: '#b7791f', soon: '#5b4be8' };
  let html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:600px;margin:0 auto;color:#141a29">
<h2 style="margin:0 0 4px;font-size:20px">${escapeHtml(d.orgName)}</h2><p style="margin:0 0 20px;color:#5b6478">Resumo de ${formatDateBR(d.today)}</p>`;
  const text: string[] = [`${d.orgName} — resumo de ${formatDateBR(d.today)}`];
  if (!d.parts.length) { html += '<p>Nenhuma conta vencida ou vencendo nos dias configurados.</p>'; text.push('', 'Nenhuma conta vencida ou vencendo nos dias configurados.'); }
  for (const p of d.parts) {
    html += `<h3 style="margin:24px 0 8px;font-size:16px">${TYPE_TITLE[p.type]}</h3>`;
    text.push('', TYPE_TITLE[p.type].toUpperCase());
    for (const s of p.sections) {
      const tot = formatBRL(sumMoney(s.items.map((i) => i.amount)));
      html += `<p style="margin:14px 0 6px;font-weight:600;color:${color[s.tone]}">${escapeHtml(s.title)} · ${tot}</p><table style="width:100%;border-collapse:collapse;font-size:14px">`;
      text.push(`${s.title} — ${tot}`);
      for (const i of s.items.slice(0, MAX_ITEMS * 2)) {
        html += `<tr><td style="padding:6px 0;border-bottom:1px solid #dfe3ee">${escapeHtml(i.description)}</td><td style="padding:6px 0;border-bottom:1px solid #dfe3ee;color:#5b6478;white-space:nowrap">${formatDateBR(i.dueDate)}</td><td style="padding:6px 0;border-bottom:1px solid #dfe3ee;text-align:right;white-space:nowrap">${formatBRL(i.amount)}</td></tr>`;
        text.push(`  - ${i.description} | ${formatDateBR(i.dueDate)} | ${formatBRL(i.amount)}`);
      }
      html += '</table>';
    }
    html += `<p style="margin:12px 0 0"><a href="${env.APP_URL}/${path(p.type)}" style="color:#5b4be8">Abrir ${TYPE_TITLE[p.type].toLowerCase()}</a></p>`;
    text.push(`${env.APP_URL}/${path(p.type)}`);
  }
  html += `<p style="margin:32px 0 0;font-size:12px;color:#8a93a8">Você recebe este e-mail porque está na lista de alertas do espaço ${escapeHtml(d.orgName)} no nopaper.</p></div>`;
  return { subject, html, text: text.join('\n') };
}

// ------------------------------------------------------------------ envio
export interface SendResult { channel: 'telegram' | 'email'; target: string; ok: boolean; error?: string }

export async function deliver(orgId: string, cfg: AlertConfig, d: Digest, test = false): Promise<SendResult[]> {
  const results: SendResult[] = [];
  if (cfg.telegram.enabled && cfg.telegram.chats.length) {
    const token = await telegramToken();
    const msg = digestTelegram(d);
    for (const c of cfg.telegram.chats) {
      try {
        if (!token) throw new Error('Bot do Telegram não configurado pelo administrador da plataforma');
        await telegramSend(token, c.id, msg);
        results.push({ channel: 'telegram', target: c.name, ok: true });
      } catch (e) { results.push({ channel: 'telegram', target: c.name, ok: false, error: (e as Error).message }); }
    }
  }
  if (cfg.email.enabled && cfg.email.recipients.length) {
    const m = digestEmail(d);
    try {
      await sendEmail(cfg.email.recipients, test ? `[teste] ${m.subject}` : m.subject, m.html, m.text);
      results.push({ channel: 'email', target: cfg.email.recipients.join(', '), ok: true });
    } catch (e) { results.push({ channel: 'email', target: cfg.email.recipients.join(', '), ok: false, error: (e as Error).message }); }
  }
  if (results.length) {
    await db.insert(schema.alertDeliveries).values(results.map((r) => ({
      orgId, channel: r.channel, target: r.target.slice(0, 200), status: r.ok ? 'ok' : 'error', items: d.count, test, error: r.error?.slice(0, 1000) ?? null,
    })));
  }
  return results;
}

/** Job periódico: envia o resumo diário de cada espaço na hora configurada (fuso do espaço). */
export async function runAlertsTick() {
  const rows = await db.select({ orgId: schema.orgSettings.orgId, tz: schema.organizations.timezone })
    .from(schema.orgSettings).innerJoin(schema.organizations, eq(schema.organizations.id, schema.orgSettings.orgId))
    .where(eq(schema.orgSettings.key, 'alerts'));
  let sent = 0, skipped = 0;
  for (const r of rows) {
    const cfg = await loadAlertConfig(r.orgId);
    if (!cfg.enabled) continue;
    const today = todayISO(r.tz);
    const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: r.tz, hour: '2-digit', hourCycle: 'h23' }).format(new Date()));
    if (cfg.lastSentOn === today || hour < cfg.hour) continue;
    // marca antes de enviar: se algo falhar, não repete a cada 15 min (o erro fica no histórico)
    await saveAlertConfig(r.orgId, { ...cfg, lastSentOn: today });
    const d = await buildDigest(r.orgId, cfg);
    if (!d.count) { skipped++; continue; }
    await deliver(r.orgId, cfg, d);
    sent++;
  }
  return { orgs: rows.length, sent, skipped };
}
