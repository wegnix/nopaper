import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { alertConfigSchema } from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { parse } from '../lib/validate.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { getSystemSetting } from '../lib/settings.js';
import { buildDigest, deliver, loadAlertConfig, saveAlertConfig } from '../services/alerts.js';
import { smtpConfig, telegramSend, telegramToken, telegramUpdates, type StoredTelegram } from '../services/notify.js';

const LINK_TTL_MS = 10 * 60_000;

export default async function alertRoutes(app: FastifyInstance) {
  const guard = { preHandler: requirePerm('alerts.manage') };

  app.get('/api/alerts', guard, async (req) => {
    const cfg = await loadAlertConfig(req.org!.id);
    const tg = await getSystemSetting<StoredTelegram>('telegram');
    const deliveries = await db.select().from(schema.alertDeliveries).where(eq(schema.alertDeliveries.orgId, req.org!.id))
      .orderBy(desc(schema.alertDeliveries.createdAt)).limit(20);
    const { lastSentOn, pendingLink, ...config } = cfg;
    return {
      config, lastSentOn,
      telegramReady: !!tg?.tokenEnc, botUsername: tg?.botUsername ?? null,
      smtpReady: !!(await smtpConfig()),
      deliveries: deliveries.map((d) => ({ id: d.id, channel: d.channel, target: d.target, status: d.status, items: d.items, test: d.test, error: d.error, createdAt: d.createdAt })),
      pendingLink: pendingLink && pendingLink.expiresAt > Date.now() ? pendingLink.code : null,
    };
  });

  /**
   * O resumo leva descrição, valor e vencimento das contas: quem escolhe os destinatários (e-mail ou
   * chat do Telegram) precisa poder ver tudo o que o resumo traz — os tipos ligados e, se incluídas,
   * as categorias restritas. Senão bastaria "gerenciar alertas" para receber contas que não pode ver.
   */
  const assertCanReceive = (req: FastifyRequest, cfg: { payable: { enabled: boolean }; receivable: { enabled: boolean }; includeRestricted: boolean }) => {
    const o = req.org!;
    if ((cfg.payable.enabled && !o.can('payable.view')) || (cfg.receivable.enabled && !o.can('receivable.view')) || (cfg.includeRestricted && !o.can('bills.view_restricted'))) {
      throw forbidden('Só quem pode ver as contas que entram no resumo (e as categorias restritas, se incluídas) escolhe quem recebe os alertas.');
    }
  };

  app.put('/api/alerts', guard, async (req) => {
    const body = parse(alertConfigSchema, req.body);
    const cur = await loadAlertConfig(req.org!.id);
    // os chats só entram pelo fluxo de vínculo (não aceita IDs digitados)
    const next = { ...cur, ...body, telegram: { enabled: body.telegram.enabled, chats: cur.telegram.chats } };
    // quem não vê um tipo de conta (ou as restritas) não muda essa parte do resumo
    if (!req.org!.can('payable.view')) next.payable = cur.payable;
    if (!req.org!.can('receivable.view')) next.receivable = cur.receivable;
    if (!req.org!.can('bills.view_restricted')) next.includeRestricted = cur.includeRestricted;
    const newRecipients = next.email.recipients.some((r) => !cur.email.recipients.includes(r));
    if (newRecipients || (next.email.enabled && !cur.email.enabled) || (next.telegram.enabled && !cur.telegram.enabled)) assertCanReceive(req, next);
    // mudou a hora para mais tarde hoje? libera o envio de hoje de novo
    if (body.hour !== cur.hour) next.lastSentOn = null;
    await saveAlertConfig(req.org!.id, next);
    await audit(req, { action: 'alerts.update', entityType: 'alerts', description: `Atualizou os alertas (${body.enabled ? 'ligados' : 'desligados'})`, details: { hour: body.hour, telegram: body.telegram.enabled, email: body.email.recipients.length } });
    return { ok: true };
  });

  app.post('/api/alerts/test', guard, async (req) => {
    const cfg = await loadAlertConfig(req.org!.id);
    if (!(cfg.telegram.enabled && cfg.telegram.chats.length) && !(cfg.email.enabled && cfg.email.recipients.length)) {
      throw badRequest('Ative o Telegram ou o e-mail e salve antes de testar.');
    }
    const d = await buildDigest(req.org!.id, cfg);
    const results = await deliver(req.org!.id, cfg, d, true);
    return { items: d.count, results };
  });

  // ---------------------------------------------------------------- vínculo com o Telegram
  app.post('/api/alerts/telegram/link', guard, async (req) => {
    const token = await telegramToken();
    const tg = await getSystemSetting<StoredTelegram>('telegram');
    if (!token || !tg?.botUsername) throw badRequest('O bot do Telegram ainda não foi configurado pelo administrador da plataforma.');
    const cfg = await loadAlertConfig(req.org!.id);
    assertCanReceive(req, cfg);
    const code = `np${randomBytes(6).toString('hex')}`;
    await saveAlertConfig(req.org!.id, { ...cfg, pendingLink: { code, expiresAt: Date.now() + LINK_TTL_MS } });
    return { code, url: `https://t.me/${tg.botUsername}?start=${code}`, bot: tg.botUsername };
  });

  app.post('/api/alerts/telegram/check', guard, async (req) => {
    const cfg = await loadAlertConfig(req.org!.id);
    assertCanReceive(req, cfg);
    const link = cfg.pendingLink;
    if (!link || link.expiresAt < Date.now()) throw badRequest('O código expirou. Gere um novo.');
    const token = await telegramToken();
    if (!token) throw badRequest('Bot do Telegram não configurado');
    const updates = await telegramUpdates(token);
    const hit = [...updates].reverse().find((u) => u.message?.text?.trim() === `/start ${link.code}`);
    if (!hit?.message) return { linked: null };
    const c = hit.message.chat;
    const chat = { id: String(c.id), name: (c.title ?? [c.first_name, c.last_name].filter(Boolean).join(' ') ?? c.username ?? String(c.id)).slice(0, 120) || String(c.id) };
    const chats = [...cfg.telegram.chats.filter((x) => x.id !== chat.id), chat].slice(-10);
    await saveAlertConfig(req.org!.id, { ...cfg, pendingLink: null, telegram: { enabled: true, chats } });
    const [org] = await db.select({ name: schema.organizations.name }).from(schema.organizations).where(eq(schema.organizations.id, req.org!.id));
    await telegramSend(token, chat.id, `✅ Este chat vai receber os alertas do espaço <b>${(org?.name ?? '').replace(/[<>&]/g, '')}</b> no nopaper.`).catch(() => null);
    await audit(req, { action: 'alerts.telegram_link', entityType: 'alerts', description: `Vinculou o chat do Telegram "${chat.name}"` });
    return { linked: chat };
  });

  app.delete<{ Params: { id: string } }>('/api/alerts/telegram/chats/:id', guard, async (req) => {
    const cfg = await loadAlertConfig(req.org!.id);
    const chat = cfg.telegram.chats.find((c) => c.id === req.params.id);
    await saveAlertConfig(req.org!.id, { ...cfg, telegram: { ...cfg.telegram, chats: cfg.telegram.chats.filter((c) => c.id !== req.params.id) } });
    if (chat) await audit(req, { action: 'alerts.telegram_unlink', entityType: 'alerts', description: `Removeu o chat do Telegram "${chat.name}"` });
    return { ok: true };
  });
}
