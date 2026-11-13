import { and, asc, eq, gte, inArray, lt, lte, notInArray, sql } from 'drizzle-orm';
import {
  COLOR_PRESETS, addDaysISO, alertConfigSchema, billNames, isColorKey, formatBRL, formatDateBR, sumMoney, todayISO, diffDaysISO, type AlertConfig, type BillType,
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
interface Item {
  id: string; description: string; amount: string; dueDate: string; person: string | null;
  category: { label: string; color: string } | null;
  /** Linha digitável do boleto (para pagar direto do e-mail). */
  barcode: string | null;
  hasPix: boolean;
  /** Anexos da conta: boleto, nota fiscal. */
  slots: string[];
}
interface Section { title: string; items: Item[]; tone: 'overdue' | 'today' | 'soon' }
interface TypeDigest { type: BillType; sections: Section[] }

/** Telegram: mensagem tem limite de tamanho. E-mail: lista tudo, com um teto só de segurança. */
const MAX_ITEMS = 15;
const MAX_EMAIL_ITEMS = 300;

async function digestFor(orgId: string, type: BillType, rule: AlertConfig['payable'], today: string, hidden: string[]): Promise<TypeDigest | null> {
  if (!rule.enabled) return null;
  const base = and(eq(schema.bills.orgId, orgId), eq(schema.bills.type, type), eq(schema.bills.status, 'pending'),
    hidden.length ? notInArray(schema.bills.categoryId, hidden) : undefined,
    rule.categoryIds.length ? inArray(schema.bills.categoryId, rule.categoryIds) : undefined);
  const order = [asc(schema.bills.dueDate), sql`lower(${schema.bills.description})`] as const;
  const load = async (cond: ReturnType<typeof and>): Promise<Item[]> => {
    const rows = await db.select({
      id: schema.bills.id, description: schema.bills.description, amount: schema.bills.amount, dueDate: schema.bills.dueDate,
      person: schema.bills.relatedPerson, barcode: schema.bills.barcode, pixKey: schema.bills.pixKey,
      categoryLabel: schema.categories.label, categoryColor: schema.categories.color,
    }).from(schema.bills).leftJoin(schema.categories, eq(schema.categories.id, schema.bills.categoryId)).where(and(base, cond)).orderBy(...order);
    return rows.map((r) => ({
      id: r.id, description: r.description, amount: r.amount, dueDate: r.dueDate, person: r.person,
      category: r.categoryLabel ? { label: r.categoryLabel, color: r.categoryColor ?? 'slate' } : null,
      barcode: r.barcode?.trim() || null, hasPix: !!r.pixKey?.trim(), slots: [],
    }));
  };
  const sections: Section[] = [];
  if (rule.overdue) {
    const items = await load(lt(schema.bills.dueDate, today));
    if (items.length) sections.push({ title: type === 'payable' ? 'Vencidas' : 'Atrasadas', items, tone: 'overdue' });
  }
  if (rule.mode === 'window') {
    // tudo o que vence hoje e nos próximos N dias, todo dia
    const until = addDaysISO(today, rule.windowDays);
    const rows = await load(and(gte(schema.bills.dueDate, today), lte(schema.bills.dueDate, until)));
    const now = rows.filter((r) => r.dueDate === today), next = rows.filter((r) => r.dueDate !== today);
    if (now.length) sections.push({ title: 'Vencem hoje', items: now, tone: 'today' });
    if (next.length) sections.push({ title: rule.windowDays === 1 ? 'Vencem amanhã' : `Próximos ${rule.windowDays} dias (até ${formatDateBR(until).slice(0, 5)})`, items: next, tone: 'soon' });
  } else {
    const days = [...new Set(rule.daysBefore)].sort((a, b) => a - b);
    if (days.length) {
      const rows = await load(inArray(schema.bills.dueDate, days.map((d) => addDaysISO(today, d))));
      for (const d of days) {
        const date = addDaysISO(today, d);
        const items = rows.filter((r) => r.dueDate === date);
        if (items.length) sections.push({ title: d === 0 ? 'Vencem hoje' : d === 1 ? 'Vencem amanhã' : `Vencem em ${d} dias (${formatDateBR(date).slice(0, 5)})`, items, tone: d === 0 ? 'today' : 'soon' });
      }
    }
  }
  if (!sections.length) return null;
  // anexos de cada conta (boleto, nota fiscal), para o e-mail dizer o que já está guardado
  const all = sections.flatMap((s) => s.items);
  const byId = new Map(all.map((i) => [i.id, i]));
  for (let i = 0; i < all.length; i += 500) {
    const att = await db.select({ billId: schema.attachments.billId, slot: schema.attachments.slot }).from(schema.attachments)
      .where(inArray(schema.attachments.billId, all.slice(i, i + 500).map((x) => x.id)));
    for (const a of att) byId.get(a.billId)?.slots.push(a.slot);
  }
  return { type, sections };
}

export interface Digest { orgId: string; orgName: string; /** Perfil do espaço: no Pessoal as contas são Despesas / Receitas. */ orgKind: string; today: string; parts: TypeDigest[]; count: number }

export async function buildDigest(orgId: string, cfg: AlertConfig): Promise<Digest> {
  const [org] = await db.select({ name: schema.organizations.name, kind: schema.organizations.kind, tz: schema.organizations.timezone }).from(schema.organizations).where(eq(schema.organizations.id, orgId));
  const today = todayISO(org?.tz);
  const hidden = cfg.includeRestricted ? [] : await restrictedCategoryIds(orgId);
  const parts = (await Promise.all([
    digestFor(orgId, 'payable', cfg.payable, today, hidden),
    digestFor(orgId, 'receivable', cfg.receivable, today, hidden),
  ])).filter((p): p is TypeDigest => !!p);
  const count = parts.reduce((a, p) => a + p.sections.reduce((b, s) => b + s.items.length, 0), 0);
  return { orgId, orgName: org?.name ?? 'NoPaper', orgKind: org?.kind ?? 'company', today, parts, count };
}

const path = (t: BillType) => (t === 'payable' ? 'pagar' : 'receber');
const late = (today: string, due: string) => { const n = diffDaysISO(today, due); return n === 1 ? 'há 1 dia' : `há ${n} dias`; };
const emptyText = 'Nenhuma conta vencida ou vencendo no período configurado.';
/** Link que abre o NoPaper já com o código da conta na tela (boleto ou PIX), pronto para copiar. */
const codeLink = (d: Digest, t: BillType, id: string) => `${env.APP_URL}/${path(t)}?codigo=${id}&espaco=${d.orgId}`;
const SLOT_SHORT: Record<string, string> = { boleto: 'boleto', invoice: 'nota fiscal', payment_proof: 'comprovante' };

export function digestTelegram(d: Digest): string {
  const out: string[] = [`<b>NoPaper · ${escapeHtml(d.orgName)}</b>`, `Resumo de ${formatDateBR(d.today)}`];
  if (!d.parts.length) out.push('', `${emptyText} ✨`);
  for (const p of d.parts) {
    out.push('', `<b>${billNames(p.type, d.orgKind).title}</b>`);
    for (const s of p.sections) {
      const icon = s.tone === 'overdue' ? '🔴' : s.tone === 'today' ? '🟡' : '🔵';
      out.push(`${icon} <b>${escapeHtml(s.title)}</b> — ${formatBRL(sumMoney(s.items.map((i) => i.amount)))}`);
      // seção de vários dias (próximos N dias): cada conta mostra o seu vencimento
      const mixed = s.tone === 'soon' && new Set(s.items.map((i) => i.dueDate)).size > 1;
      for (const i of s.items.slice(0, MAX_ITEMS)) {
        out.push(`• ${escapeHtml(i.description)} — ${formatBRL(i.amount)}${s.tone === 'overdue' ? ` <i>(${late(d.today, i.dueDate)})</i>` : mixed ? ` <i>(${formatDateBR(i.dueDate).slice(0, 5)})</i>` : ''}`);
      }
      if (s.items.length > MAX_ITEMS) out.push(`<i>… e mais ${s.items.length - MAX_ITEMS}</i>`);
    }
    out.push(`<a href="${env.APP_URL}/${path(p.type)}">Abrir ${billNames(p.type, d.orgKind).title.toLowerCase()}</a>`);
  }
  return out.join('\n');
}

export function digestEmail(d: Digest): { subject: string; html: string; text: string } {
  const overdue = d.parts.flatMap((p) => p.sections.filter((s) => s.tone === 'overdue')).reduce((a, s) => a + s.items.length, 0);
  const subject = `NoPaper · ${d.orgName}: ${d.count} ${d.count === 1 ? 'conta' : 'contas'} para acompanhar${overdue ? ` (${overdue} em atraso)` : ''}`;
  const color = { overdue: '#d9483b', today: '#b7791f', soon: '#5b4be8' };
  const cell = 'padding:7px 0;border-bottom:1px solid #dfe3ee;vertical-align:top';
  let html = `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:640px;margin:0 auto;color:#141a29">
<h2 style="margin:0 0 4px;font-size:20px">${escapeHtml(d.orgName)}</h2><p style="margin:0 0 20px;color:#5b6478">Resumo de ${formatDateBR(d.today)}</p>`;
  const text: string[] = [`${d.orgName} — resumo de ${formatDateBR(d.today)}`];
  if (!d.parts.length) { html += `<p>${emptyText}</p>`; text.push('', emptyText); }
  for (const p of d.parts) {
    const names = billNames(p.type, d.orgKind);
    const all = p.sections.flatMap((s) => s.items);
    const grand = `${all.length} ${all.length === 1 ? 'conta' : 'contas'} · ${formatBRL(sumMoney(all.map((i) => i.amount)))}`;
    html += `<h3 style="margin:24px 0 2px;font-size:16px">${names.title}</h3><p style="margin:0 0 8px;font-size:13px;color:#5b6478">${grand}</p>`;
    text.push('', `${names.title.toUpperCase()} — ${grand}`);
    for (const s of p.sections) {
      const tot = formatBRL(sumMoney(s.items.map((i) => i.amount)));
      html += `<p style="margin:14px 0 6px;font-weight:600;color:${color[s.tone]}">${escapeHtml(s.title)} · ${tot}</p><table style="width:100%;border-collapse:collapse;font-size:14px">`;
      text.push(`${s.title} — ${tot}`);
      for (const i of s.items.slice(0, MAX_EMAIL_ITEMS)) {
        const dot = i.category ? `<span style="color:${isColorKey(i.category.color) ? COLOR_PRESETS[i.category.color].base : '#8a93a8'}">&#9679;</span> ${escapeHtml(i.category.label)}` : '';
        const files = i.slots.filter((x) => x !== 'payment_proof').map((x) => SLOT_SHORT[x] ?? x);
        const meta = [dot, files.length ? `anexos: ${files.join(', ')}` : ''].filter(Boolean).join(' &nbsp;·&nbsp; ');
        const link = codeLink(d, p.type, i.id);
        const pay = i.barcode
          ? `<div style="margin-top:5px;padding:6px 8px;background:#f3f4f9;border-radius:6px;font-size:12px"><span style="font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all">${escapeHtml(i.barcode)}</span> &nbsp;<a href="${link}" style="color:#5b4be8;white-space:nowrap">Copiar pelo NoPaper</a></div>`
          : i.hasPix ? `<div style="margin-top:5px;font-size:12px"><a href="${link}" style="color:#5b4be8">PIX: abrir no NoPaper para copiar</a></div>` : '';
        html += `<tr><td style="${cell}">${escapeHtml(i.description)}${i.person ? ` <span style="color:#5b6478">(${escapeHtml(i.person)})</span>` : ''}${meta ? `<div style="margin-top:2px;font-size:12px;color:#5b6478">${meta}</div>` : ''}${pay}</td>`
          + `<td style="${cell};width:84px;padding-left:10px;color:#5b6478;white-space:nowrap">${formatDateBR(i.dueDate)}</td><td style="${cell};width:104px;padding-left:10px;text-align:right;white-space:nowrap">${formatBRL(i.amount)}</td></tr>`;
        text.push(`  - ${i.description}${i.person ? ` (${i.person})` : ''}${i.category ? ` [${i.category.label}]` : ''} | ${formatDateBR(i.dueDate)} | ${formatBRL(i.amount)}`);
        if (i.barcode) text.push(`    ${i.barcode}`);
      }
      html += '</table>';
      if (s.items.length > MAX_EMAIL_ITEMS) {
        const more = `… e mais ${s.items.length - MAX_EMAIL_ITEMS} (veja todas no NoPaper)`;
        html += `<p style="margin:6px 0 0;font-size:13px;color:#5b6478">${more}</p>`; text.push(`  ${more}`);
      }
    }
    html += `<p style="margin:12px 0 0"><a href="${env.APP_URL}/${path(p.type)}" style="color:#5b4be8">Abrir ${names.title.toLowerCase()}</a></p>`;
    text.push(`${env.APP_URL}/${path(p.type)}`);
  }
  if (d.parts.some((p) => p.sections.some((s) => s.items.some((i) => i.barcode)))) {
    html += '<p style="margin:20px 0 0;font-size:12px;color:#5b6478">O código do boleto pode ser copiado daqui mesmo. “Copiar pelo NoPaper” abre o sistema com o código na tela, pronto para copiar ou ler com a câmera do banco.</p>';
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
  let sent = 0, skipped = 0, failed = 0;
  for (const r of rows) {
    // um espaço com problema (fuso gravado errado, destino fora do ar) não pode parar os outros
    try {
    const cfg = await loadAlertConfig(r.orgId);
    if (!cfg.enabled) continue;
    const today = todayISO(r.tz);
    const [hour, minute] = new Intl.DateTimeFormat('en-GB', { timeZone: r.tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()).split(':').map(Number);
    if (cfg.lastSentOn === today || hour * 60 + minute < cfg.hour * 60 + cfg.minute) continue;
    // marca antes de enviar: se algo falhar, não repete a cada verificação (o erro fica no histórico)
    await saveAlertConfig(r.orgId, { ...cfg, lastSentOn: today });
    const d = await buildDigest(r.orgId, cfg);
    if (!d.count) { skipped++; continue; }
    await deliver(r.orgId, cfg, d);
    sent++;
    } catch (err) { failed++; console.error(`[alerts] espaço ${r.orgId}: ${(err as Error).message}`); }
  }
  return { orgs: rows.length, sent, skipped, failed };
}
