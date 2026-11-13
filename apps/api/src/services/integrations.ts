import { BlockList, isIP } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyRequest } from 'fastify';
import { API_TOKEN_PREFIX, INTEGRATION_PERMISSIONS, isPermission, todayISO, type ApiTokenInfo, type Permission, type WebhookGroup, type WebhookInfo } from '@nopaper/shared';
import { db, schema } from '../db/client.js';

/** Quem está chamando a API pública: um token de integração de um espaço. */
export interface Integration { id: string; name: string; orgId: string; expiresAt: string | null }
export type TokenFailure = 'invalid' | 'expired' | 'ip';

/**
 * Chave do processo: a API pública repassa algumas chamadas às rotas internas (mesmas regras da tela)
 * e só com ela um token de integração é aceito fora de `/api/v1`. Nunca sai do servidor.
 */
export const INTERNAL_KEY = randomBytes(32).toString('base64url');

const sha256 = (t: string) => createHash('sha256').update(t).digest('hex');

/** Token novo: `np_` + 40 caracteres aleatórios. Só o hash é guardado. */
export function newApiToken() {
  const token = API_TOKEN_PREFIX + randomBytes(30).toString('base64url');
  return { token, tokenHash: sha256(token), hint: token.slice(0, 7) };
}

/** O IP de quem chama está na lista do token? (lista vazia = qualquer IP) */
export function ipAllowed(allowed: string[], ip: string) {
  if (!allowed.length) return true;
  const family = isIP(ip) === 6 ? 'ipv6' : 'ipv4';
  // IPv4 que chega como ::ffff:a.b.c.d
  const plain = ip.startsWith('::ffff:') && isIP(ip.slice(7)) === 4 ? ip.slice(7) : ip;
  const list = new BlockList();
  for (const entry of allowed) {
    const [addr, bits] = entry.split('/');
    const fam = isIP(addr!) === 6 ? 'ipv6' : 'ipv4';
    try {
      if (bits !== undefined) list.addSubnet(addr!, Number(bits), fam);
      else list.addAddress(addr!, fam);
    } catch { /* entrada inválida: ignora */ }
  }
  return list.check(plain, plain === ip ? family : 'ipv4');
}

/**
 * Confere o token do cabeçalho e devolve o espaço e as permissões dele. As permissões são as
 * gravadas no token, cortadas pelo que um token pode ter (o catálogo pode ter mudado desde a criação).
 */
export async function resolveApiToken(req: FastifyRequest, token: string): Promise<
  { ok: true; integration: Integration; org: { id: string; name: string; kind: string; timezone: string }; permissions: Permission[] } | { ok: false; reason: TokenFailure }
> {
  const [t] = await db.select({
    id: schema.apiTokens.id, name: schema.apiTokens.name, orgId: schema.apiTokens.orgId, permissions: schema.apiTokens.permissions,
    allowedIps: schema.apiTokens.allowedIps, expiresAt: schema.apiTokens.expiresAt,
    orgName: schema.organizations.name, kind: schema.organizations.kind, timezone: schema.organizations.timezone,
  }).from(schema.apiTokens)
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.apiTokens.orgId))
    .where(eq(schema.apiTokens.tokenHash, sha256(token))).limit(1);
  if (!t) return { ok: false, reason: 'invalid' };
  if (t.expiresAt && t.expiresAt < todayISO(t.timezone)) return { ok: false, reason: 'expired' };
  if (!ipAllowed(t.allowedIps, req.ip)) return { ok: false, reason: 'ip' };
  // "último uso" no máximo uma vez por minuto, para não gravar a cada chamada
  await db.update(schema.apiTokens).set({ lastUsedAt: new Date(), lastUsedIp: req.ip.slice(0, 64), updatedAt: sql`${schema.apiTokens.updatedAt}` })
    .where(and(eq(schema.apiTokens.id, t.id), or(isNull(schema.apiTokens.lastUsedAt), lt(schema.apiTokens.lastUsedAt, new Date(Date.now() - 60_000)))));
  const permissions = t.permissions.filter((p): p is Permission => isPermission(p) && INTEGRATION_PERMISSIONS.includes(p));
  return {
    ok: true, permissions,
    integration: { id: t.id, name: t.name, orgId: t.orgId, expiresAt: t.expiresAt },
    org: { id: t.orgId, name: t.orgName, kind: t.kind, timezone: t.timezone },
  };
}

export async function listApiTokens(orgId: string, timezone: string): Promise<ApiTokenInfo[]> {
  const rows = await db.select({
    id: schema.apiTokens.id, name: schema.apiTokens.name, hint: schema.apiTokens.hint, permissions: schema.apiTokens.permissions,
    allowedIps: schema.apiTokens.allowedIps, expiresAt: schema.apiTokens.expiresAt, lastUsedAt: schema.apiTokens.lastUsedAt,
    lastUsedIp: schema.apiTokens.lastUsedIp, createdAt: schema.apiTokens.createdAt, createdByName: schema.users.name,
    webhookUrl: schema.apiTokens.webhookUrl, webhookGroups: schema.apiTokens.webhookGroups, webhookStatus: schema.apiTokens.webhookStatus,
    webhookError: schema.apiTokens.webhookError, webhookLastAt: schema.apiTokens.webhookLastAt,
  }).from(schema.apiTokens).leftJoin(schema.users, eq(schema.users.id, schema.apiTokens.createdBy))
    .where(eq(schema.apiTokens.orgId, orgId)).orderBy(schema.apiTokens.createdAt);
  const today = todayISO(timezone);
  return rows.map(({ webhookUrl, webhookGroups, webhookStatus, webhookError, webhookLastAt, ...r }) => ({
    ...r,
    webhook: webhookUrl ? { url: webhookUrl, groups: webhookGroups as WebhookGroup[], status: webhookStatus as WebhookInfo['status'], error: webhookError, lastAt: webhookLastAt?.toISOString() ?? null } : null,
    permissions: r.permissions.filter(isPermission), expired: !!r.expiresAt && r.expiresAt < today,
    lastUsedAt: r.lastUsedAt?.toISOString() ?? null, createdAt: r.createdAt.toISOString(),
  }));
}

// ------------------------------------------------------------------ Idempotency-Key
const IDEMPOTENCY_TTL_MS = 24 * 3600_000;

/** Apaga as respostas guardadas há mais de 24 h (job diário). */
export async function cleanIdempotencyKeys() {
  const r = await db.delete(schema.apiIdempotencyKeys).where(lt(schema.apiIdempotencyKeys.createdAt, new Date(Date.now() - IDEMPOTENCY_TTL_MS))).returning({ key: schema.apiIdempotencyKeys.key });
  return { deleted: r.length };
}

export type IdempotencyState = { state: 'new' } | { state: 'replay'; status: number; response: unknown } | { state: 'mismatch' } | { state: 'running' };

/** Reserva a chave para esta chamada, ou diz o que já aconteceu com ela. */
export async function claimIdempotencyKey(tokenId: string, key: string, request: string): Promise<IdempotencyState> {
  const t = schema.apiIdempotencyKeys;
  const requestHash = sha256(request);
  // vencidas e chamadas que morreram no meio (mais de 1 min sem resposta) não seguram a chave
  await db.delete(t).where(and(eq(t.tokenId, tokenId), eq(t.key, key),
    or(lt(t.createdAt, new Date(Date.now() - IDEMPOTENCY_TTL_MS)), and(isNull(t.status), lt(t.createdAt, new Date(Date.now() - 60_000))))));
  const [mine] = await db.insert(t).values({ tokenId, key, requestHash }).onConflictDoNothing().returning({ key: t.key });
  if (mine) return { state: 'new' };
  const [row] = await db.select().from(t).where(and(eq(t.tokenId, tokenId), eq(t.key, key)));
  if (!row) return { state: 'running' };
  if (row.requestHash !== requestHash) return { state: 'mismatch' };
  if (row.status == null) return { state: 'running' };
  return { state: 'replay', status: row.status, response: row.response };
}

export async function finishIdempotencyKey(tokenId: string, key: string, status: number, response: unknown) {
  const t = schema.apiIdempotencyKeys;
  await db.update(t).set({ status, response: response as never }).where(and(eq(t.tokenId, tokenId), eq(t.key, key)));
}

/** A chamada falhou: solta a chave para a próxima tentativa refazer. */
export async function releaseIdempotencyKey(tokenId: string, key: string) {
  const t = schema.apiIdempotencyKeys;
  await db.delete(t).where(and(eq(t.tokenId, tokenId), eq(t.key, key)));
}
