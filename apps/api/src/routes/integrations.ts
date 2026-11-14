import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { API_TOKENS_MAX, PERMISSIONS, apiTokenSchema, webhookSchema, type ApiTokenInput, type Permission } from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { parse } from '../lib/validate.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { forgetRateLimits, listApiTokens, newApiToken } from '../services/integrations.js';
import { clearWebhook, rotateWebhookSecret, setWebhook, testWebhook, webhookUrlError } from '../services/webhooks.js';

const labels = (perms: string[]) => perms.map((p) => PERMISSIONS[p as Permission]?.label ?? p).join('; ');

/**
 * Mesma regra dos grupos: quem não é administrador do espaço só concede o que já tem, e não mexe
 * em token que dá o que ele não tem (nem para tirar permissões ou apagar).
 */
function assertCanGrant(req: FastifyRequest, next: string[], before: string[] | null) {
  if (req.org!.isAdmin) return;
  if (before?.some((p) => !req.org!.can(p as Permission))) throw forbidden('Só um administrador do espaço pode alterar um token com permissões que você não tem');
  const extra = next.filter((p) => !req.org!.can(p as Permission));
  if (extra.length) throw forbidden(`Você não pode conceder permissões que não tem: ${labels(extra)}`);
}

/** Tokens de integração do espaço (Configurações → Espaço → Integrações). */
export default async function integrationRoutes(app: FastifyInstance) {
  const guard = { preHandler: requirePerm('integrations.manage') };

  const assertName = async (orgId: string, body: ApiTokenInput, exceptId?: string) => {
    const [dup] = await db.select({ id: schema.apiTokens.id }).from(schema.apiTokens)
      .where(and(eq(schema.apiTokens.orgId, orgId), sql`lower(${schema.apiTokens.name}) = lower(${body.name})`));
    if (dup && dup.id !== exceptId) throw badRequest('Já existe uma integração com este nome');
  };

  app.get('/api/integrations/tokens', guard, async (req) => ({ items: await listApiTokens(req.org!.id, req.org!.timezone) }));

  app.post('/api/integrations/tokens', guard, async (req, reply) => {
    const body = parse(apiTokenSchema, req.body);
    assertCanGrant(req, body.permissions, null);
    await assertName(req.org!.id, body);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(schema.apiTokens).where(eq(schema.apiTokens.orgId, req.org!.id));
    if (n >= API_TOKENS_MAX) throw badRequest(`Este espaço já tem ${API_TOKENS_MAX} tokens. Apague um que não é mais usado.`);
    const t = newApiToken();
    const [row] = await db.insert(schema.apiTokens).values({
      orgId: req.org!.id, name: body.name, tokenHash: t.tokenHash, hint: t.hint, permissions: body.permissions,
      allowedIps: body.allowedIps, expiresAt: body.expiresAt, rateLimit: body.rateLimit ?? null, createdBy: req.user!.id,
    }).returning({ id: schema.apiTokens.id });
    await audit(req, {
      action: 'integration.token_create', entityType: 'api_token', entityId: row.id, description: `Criou o token de integração ${body.name}`,
      details: { permissions: body.permissions, allowedIps: body.allowedIps, expiresAt: body.expiresAt, rateLimit: body.rateLimit ?? null },
    });
    reply.code(201);
    const item = (await listApiTokens(req.org!.id, req.org!.timezone)).find((x) => x.id === row.id)!;
    // o texto do token só sai aqui, uma vez
    return { ...item, token: t.token };
  });

  app.put<{ Params: { id: string } }>('/api/integrations/tokens/:id', guard, async (req) => {
    const body = parse(apiTokenSchema, req.body);
    const [before] = await db.select().from(schema.apiTokens).where(and(eq(schema.apiTokens.id, req.params.id), eq(schema.apiTokens.orgId, req.org!.id)));
    if (!before) throw notFound('Token não encontrado');
    assertCanGrant(req, body.permissions, before.permissions);
    await assertName(req.org!.id, body, before.id);
    // limite ausente no pedido = fica como está
    const rateLimit = body.rateLimit === undefined ? before.rateLimit : body.rateLimit;
    await db.update(schema.apiTokens).set({ name: body.name, permissions: body.permissions, allowedIps: body.allowedIps, expiresAt: body.expiresAt, rateLimit })
      .where(eq(schema.apiTokens.id, before.id));
    forgetRateLimits();
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (before.name !== body.name) changes.name = { from: before.name, to: body.name };
    if (before.expiresAt !== body.expiresAt) changes.expiresAt = { from: before.expiresAt, to: body.expiresAt };
    if (before.rateLimit !== rateLimit) changes.rateLimit = { from: before.rateLimit, to: rateLimit };
    if (before.allowedIps.join() !== body.allowedIps.join()) changes.allowedIps = { from: before.allowedIps.join(', ') || null, to: body.allowedIps.join(', ') || null };
    await audit(req, {
      action: 'integration.token_update', entityType: 'api_token', entityId: before.id, description: `Editou o token de integração ${body.name}`,
      details: {
        changes,
        permissionsAdded: body.permissions.filter((p) => !before.permissions.includes(p)),
        permissionsRemoved: before.permissions.filter((p) => !(body.permissions as string[]).includes(p)),
      },
    });
    return (await listApiTokens(req.org!.id, req.org!.timezone)).find((x) => x.id === before.id)!;
  });

  // ------------------------------------------------------------ webhook do token
  const tokenOf = async (req: FastifyRequest, id: string) => {
    const [t] = await db.select().from(schema.apiTokens).where(and(eq(schema.apiTokens.id, id), eq(schema.apiTokens.orgId, req.org!.id)));
    if (!t) throw notFound('Token não encontrado');
    assertCanGrant(req, t.permissions, t.permissions);
    return t;
  };
  const infoOf = async (req: FastifyRequest, id: string) => (await listApiTokens(req.org!.id, req.org!.timezone)).find((x) => x.id === id)!;

  /** Liga ou altera o webhook. O segredo da assinatura só sai na 1ª vez (ou ao gerar outro). */
  app.put<{ Params: { id: string } }>('/api/integrations/tokens/:id/webhook', guard, async (req) => {
    const body = parse(webhookSchema, req.body);
    const t = await tokenOf(req, req.params.id);
    const problem = webhookUrlError(body.url);
    if (problem) throw badRequest(problem);
    const secret = await setWebhook(t.id, t.orgId, body.url, body.groups);
    await audit(req, { action: 'integration.webhook_set', entityType: 'api_token', entityId: t.id, description: `Configurou o webhook da integração ${t.name}`, details: { url: body.url, groups: body.groups } });
    return { ...(await infoOf(req, t.id)), ...(secret ? { webhookSecret: secret } : {}) };
  });

  app.post<{ Params: { id: string } }>('/api/integrations/tokens/:id/webhook/secret', guard, async (req) => {
    const t = await tokenOf(req, req.params.id);
    if (!t.webhookUrl) throw badRequest('Este token não tem webhook');
    const secret = await rotateWebhookSecret(t.id);
    await audit(req, { action: 'integration.webhook_secret', entityType: 'api_token', entityId: t.id, description: `Gerou outro segredo para o webhook da integração ${t.name}` });
    return { webhookSecret: secret };
  });

  app.post<{ Params: { id: string } }>('/api/integrations/tokens/:id/webhook/test', guard, async (req) => {
    const t = await tokenOf(req, req.params.id);
    return testWebhook(t.id);
  });

  app.delete<{ Params: { id: string } }>('/api/integrations/tokens/:id/webhook', guard, async (req) => {
    const t = await tokenOf(req, req.params.id);
    await clearWebhook(t.id);
    await audit(req, { action: 'integration.webhook_remove', entityType: 'api_token', entityId: t.id, description: `Removeu o webhook da integração ${t.name}` });
    return infoOf(req, t.id);
  });

  /** Revogar = apagar: o token para de valer na hora (o histórico fica na auditoria). */
  app.delete<{ Params: { id: string } }>('/api/integrations/tokens/:id', guard, async (req) => {
    const [before] = await db.select().from(schema.apiTokens).where(and(eq(schema.apiTokens.id, req.params.id), eq(schema.apiTokens.orgId, req.org!.id)));
    if (!before) throw notFound('Token não encontrado');
    assertCanGrant(req, [], before.permissions);
    await db.delete(schema.apiTokens).where(eq(schema.apiTokens.id, before.id));
    forgetRateLimits();
    await audit(req, { action: 'integration.token_revoke', entityType: 'api_token', entityId: before.id, description: `Revogou o token de integração ${before.name}` });
    return { ok: true };
  });
}
