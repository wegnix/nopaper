import http from 'node:http';
import https from 'node:https';
import { lookup as dnsLookup } from 'node:dns';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import { createHmac, randomBytes } from 'node:crypto';
import { and, eq, isNotNull, isNull, lte, ne, or } from 'drizzle-orm';
import { INTEGRATION_PERMISSIONS, WEBHOOK_GIVE_UP_HOURS, WEBHOOK_GROUPS, isPermission, todayISO, type Permission, type WebhookGroup } from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { env } from '../env.js';
import { decryptSecret, encryptSecret } from '../lib/secrets.js';
import { onWebhookKick } from '../lib/webhookKick.js';
import { APP_VERSION } from '../lib/version.js';
import { latestEventCursor, listEvents, type ApiEvent } from './events.js';

/**
 * Webhooks: cada token pode ter um endereço que recebe, por POST assinado, os eventos que o token
 * pode ver. A entrega segue um cursor por token (em ordem, pelo menos uma vez): se o destino falha,
 * para naquele evento e tenta de novo com intervalo crescente; 24 h falhando → pausa.
 */
const TIMEOUT_MS = 10_000;
const MAX_PER_RUN = 200;

// endereços que um webhook não pode alcançar: a própria máquina e redes internas (banco, atualizador…)
const internal = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.168.0.0', 16]] as const) internal.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 127], ['fc00::', 7], ['fe80::', 10]] as const) internal.addSubnet(net, bits, 'ipv6');
function isInternalAddress(addr: string) {
  const plain = addr.startsWith('::ffff:') && isIP(addr.slice(7)) === 4 ? addr.slice(7) : addr;
  return internal.check(plain, isIP(plain) === 6 ? 'ipv6' : 'ipv4');
}

/** Confere o endereço na hora de salvar (o DNS é conferido de novo a cada envio). */
export function webhookUrlError(raw: string): string | null {
  let u: URL;
  try { u = new URL(raw); } catch { return 'Endereço inválido'; }
  if (env.WEBHOOK_ALLOW_PRIVATE) return null;
  if (u.protocol !== 'https:') return 'O endereço do webhook precisa começar com https://';
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || (isIP(host) && isInternalAddress(host))) return 'O webhook não pode apontar para um endereço interno';
  return null;
}

const guardedLookup: LookupFunction = (hostname, options, cb) => {
  dnsLookup(hostname, { ...(options as object), all: true }, (err, found) => {
    if (err) return cb(err, '', 0);
    const list = found as unknown as Array<{ address: string; family: number }>;
    if (!env.WEBHOOK_ALLOW_PRIVATE && list.some((a) => isInternalAddress(a.address))) return cb(new Error('endereço interno não permitido'), '', 0);
    if ((options as { all?: boolean }).all) return (cb as unknown as (e: null, a: typeof list) => void)(null, list);
    cb(null, list[0]!.address, list[0]!.family);
  });
};

export const newWebhookSecret = () => `whsec_${randomBytes(24).toString('base64url')}`;

/** POST assinado: `X-NoPaper-Signature: t=<unix>,v1=<HMAC-SHA256 de "t.corpo">`. */
export function postWebhook(url: string, secret: string, event: ApiEvent | Record<string, unknown>): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  return new Promise((resolve) => {
    const problem = webhookUrlError(url);
    if (problem) return resolve({ ok: false, status: null, error: problem });
    const u = new URL(url);
    const body = JSON.stringify(event);
    const t = Math.floor(Date.now() / 1000);
    const sig = createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
    const req = (u.protocol === 'https:' ? https : http).request(u, {
      method: 'POST', timeout: TIMEOUT_MS, lookup: guardedLookup,
      headers: {
        'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'user-agent': `NoPaper-Webhook/${APP_VERSION}`,
        'x-nopaper-signature': `t=${t},v1=${sig}`, 'x-nopaper-event': String((event as { type?: string }).type ?? ''), 'x-nopaper-delivery': String((event as { id?: string }).id ?? ''),
      },
    }, (res) => {
      res.resume();
      const status = res.statusCode ?? 0;
      resolve(status >= 200 && status < 300 ? { ok: true, status, error: null } : { ok: false, status, error: `O destino respondeu ${status}` });
    });
    req.on('timeout', () => req.destroy(new Error(`sem resposta em ${TIMEOUT_MS / 1000} s`)));
    req.on('error', (e) => resolve({ ok: false, status: null, error: e.message.slice(0, 300) }));
    req.end(body);
  });
}

export const webhookPrefixes = (groups: string[]) => groups.flatMap((g) => [...(WEBHOOK_GROUPS[g as WebhookGroup]?.prefixes ?? [])]);

export async function setWebhook(tokenId: string, orgId: string, url: string, groups: string[]) {
  const [cur] = await db.select({ secret: schema.apiTokens.webhookSecret, url: schema.apiTokens.webhookUrl }).from(schema.apiTokens).where(eq(schema.apiTokens.id, tokenId));
  const secret = cur?.secret ? null : newWebhookSecret();
  await db.update(schema.apiTokens).set({
    webhookUrl: url, webhookGroups: groups, ...(secret ? { webhookSecret: encryptSecret(secret) } : {}),
    // webhook novo começa do que acontecer daqui em diante; salvar de novo também destrava um pausado
    ...(cur?.url ? {} : { webhookCursor: Number(await latestEventCursor(orgId)) }),
    webhookStatus: null, webhookError: null, webhookFailSince: null, webhookNextAt: null, webhookAttempts: 0,
  }).where(eq(schema.apiTokens.id, tokenId));
  return secret;
}

export async function rotateWebhookSecret(tokenId: string) {
  const secret = newWebhookSecret();
  await db.update(schema.apiTokens).set({ webhookSecret: encryptSecret(secret) }).where(eq(schema.apiTokens.id, tokenId));
  return secret;
}

export async function clearWebhook(tokenId: string) {
  await db.update(schema.apiTokens).set({
    webhookUrl: null, webhookSecret: null, webhookGroups: [], webhookCursor: null, webhookStatus: null, webhookError: null,
    webhookLastAt: null, webhookFailSince: null, webhookNextAt: null, webhookAttempts: 0,
  }).where(eq(schema.apiTokens.id, tokenId));
}

/** Envia um evento `ping` na hora, para conferir endereço e assinatura. */
export async function testWebhook(tokenId: string) {
  const [t] = await db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, tokenId));
  const secret = decryptSecret(t?.webhookSecret);
  if (!t?.webhookUrl || !secret) return { ok: false, status: null, error: 'Webhook não configurado' };
  return postWebhook(t.webhookUrl, secret, { id: '0', type: 'ping', occurredAt: new Date().toISOString(), resource: { type: null, id: null }, actor: { type: 'system', name: 'NoPaper' } });
}

let running = false;
/** Entrega os eventos pendentes de todos os webhooks ativos. */
export async function deliverWebhooks() {
  if (running) return { skipped: true };
  running = true;
  let sent = 0, failed = 0;
  try {
    const t = schema.apiTokens;
    const hooks = await db.select({ token: t, timezone: schema.organizations.timezone }).from(t)
      .innerJoin(schema.organizations, eq(schema.organizations.id, t.orgId))
      .where(and(isNotNull(t.webhookUrl), or(isNull(t.webhookStatus), ne(t.webhookStatus, 'stopped')), or(isNull(t.webhookNextAt), lte(t.webhookNextAt, new Date()))));
    for (const { token: h, timezone } of hooks) {
      const secret = decryptSecret(h.webhookSecret);
      if (!secret || (h.expiresAt && h.expiresAt < todayISO(timezone))) continue;
      const perms = new Set(h.permissions.filter((p): p is Permission => isPermission(p) && INTEGRATION_PERMISSIONS.includes(p)));
      const reader = { orgId: h.orgId, can: (p: Permission) => perms.has(p) };
      let cursor = String(h.webhookCursor ?? 0);
      let delivered = 0;
      let failure: string | null = null;
      for (let more = true; more && !failure && delivered < MAX_PER_RUN;) {
        const page = await listEvents(reader, cursor, 50, webhookPrefixes(h.webhookGroups));
        for (const ev of page.items) {
          const r = await postWebhook(h.webhookUrl!, secret, ev);
          if (!r.ok) { failure = r.error ?? 'falha no envio'; break; }
          cursor = ev.id; delivered++;
        }
        if (!failure) cursor = page.nextCursor;
        more = page.hasMore;
      }
      sent += delivered;
      const progress = { webhookCursor: Number(cursor), ...(delivered ? { webhookLastAt: new Date() } : {}), updatedAt: h.updatedAt };
      if (!failure) {
        if (delivered || h.webhookAttempts || Number(cursor) !== (h.webhookCursor ?? 0)) {
          await db.update(t).set({ ...progress, ...(delivered || h.webhookAttempts ? { webhookStatus: 'ok' } : {}), webhookError: null, webhookFailSince: null, webhookNextAt: null, webhookAttempts: 0 }).where(eq(t.id, h.id));
        }
        continue;
      }
      failed++;
      const attempts = h.webhookAttempts + 1;
      const since = h.webhookFailSince ?? new Date();
      const giveUp = Date.now() - since.getTime() > WEBHOOK_GIVE_UP_HOURS * 3600_000;
      await db.update(t).set({
        ...progress, webhookStatus: giveUp ? 'stopped' : 'failing', webhookError: failure, webhookFailSince: since, webhookAttempts: attempts,
        webhookNextAt: giveUp ? null : new Date(Date.now() + Math.min(2 ** attempts, 60) * 60_000),
      }).where(eq(t.id, h.id));
    }
  } finally { running = false; }
  return { sent, failed };
}

onWebhookKick(deliverWebhooks);
