import nodemailer from 'nodemailer';
import { decryptSecret } from '../lib/secrets.js';
import { getSystemSetting } from '../lib/settings.js';
import { badRequest } from '../lib/errors.js';

export interface StoredSmtp { host: string; port: number; secure: boolean; user: string; passwordEnc: string | null; from: string }
export interface StoredTelegram { tokenEnc: string | null; botUsername?: string | null }

// ------------------------------------------------------------------ Telegram
const TG = 'https://api.telegram.org';

async function tgCall<T>(token: string, method: string, body?: object): Promise<T> {
  const r = await fetch(`${TG}/bot${token}/${method}`, {
    method: body ? 'POST' : 'GET',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const j = (await r.json().catch(() => null)) as { ok: boolean; result?: T; description?: string } | null;
  if (!j?.ok) throw new Error(j?.description ? `Telegram: ${j.description}` : `Telegram respondeu HTTP ${r.status}`);
  return j.result as T;
}

export async function telegramToken(): Promise<string | null> {
  const t = await getSystemSetting<StoredTelegram>('telegram');
  return decryptSecret(t?.tokenEnc);
}

export async function telegramGetMe(token: string) {
  return tgCall<{ id: number; username: string; first_name: string }>(token, 'getMe');
}

export async function telegramSend(token: string, chatId: string, html: string) {
  // limite do Telegram: 4096 caracteres por mensagem
  const text = html.length > 4000 ? html.slice(0, 3990) + '\n…' : html;
  await tgCall(token, 'sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
}

export interface TgUpdate {
  update_id: number;
  message?: { text?: string; chat: { id: number; type: string; title?: string; first_name?: string; last_name?: string; username?: string } };
}
export async function telegramUpdates(token: string) {
  return tgCall<TgUpdate[]>(token, 'getUpdates', { allowed_updates: ['message'], limit: 100 });
}

// ------------------------------------------------------------------ e-mail
export async function smtpConfig(): Promise<StoredSmtp | null> {
  const s = await getSystemSetting<StoredSmtp>('smtp');
  return s?.host ? s : null;
}

export async function sendEmail(to: string[], subject: string, html: string, text: string) {
  const s = await smtpConfig();
  if (!s) throw badRequest('O servidor de e-mail (SMTP) não está configurado. Peça ao administrador da plataforma.');
  const transport = nodemailer.createTransport({
    host: s.host, port: s.port, secure: s.secure,
    auth: s.user ? { user: s.user, pass: decryptSecret(s.passwordEnc) ?? '' } : undefined,
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  });
  await transport.sendMail({ from: s.from || s.user, to, subject, html, text });
}

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
