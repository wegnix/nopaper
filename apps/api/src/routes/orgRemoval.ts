import type { FastifyInstance, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { ORG_REMOVAL_DAYS, orgArchiveSchema, orgDeletionSchema, orgNameMatches } from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { parse } from '../lib/validate.js';
import { HttpError, badRequest, forbidden, notFound } from '../lib/errors.js';
import { requireOrg, requireSuperadmin } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { assertCurrentPassword } from './auth.js';
import { currentOperation } from '../services/backup.js';
import { hasActiveOwner, notifyCancelled, notifyRequested, platformLabel, purgeOrg, removalImpact } from '../services/orgRemoval.js';
import { privacyFor } from '../services/privacy.js';
import { storageUsage } from '../services/storageQuota.js';

const loadOrg = async (id: string) => {
  const [o] = await db.select().from(schema.organizations).where(eq(schema.organizations.id, id));
  if (!o) throw notFound('Espaço não encontrado');
  return o;
};
type Org = Awaited<ReturnType<typeof loadOrg>>;

const deletionView = (o: Org) => (o.deletionDueAt ? {
  requestedAt: o.deletionRequestedAt!.toISOString(), dueAt: o.deletionDueAt.toISOString(),
  byName: o.deletionRequestedByName, byPlatform: o.deletionByPlatform,
} : null);

/** Nome digitado, senha da própria conta e caixa marcada; nada de remoção com backup/restauração rodando. */
async function assertConfirmed(req: FastifyRequest, o: Org): Promise<{ now: boolean }> {
  const body = parse(orgDeletionSchema, req.body);
  if (!orgNameMatches(body.confirmName, o.name)) throw badRequest('O nome digitado não é o nome do espaço. Digite exatamente como aparece.', 'name_mismatch');
  const [u] = await db.select({ id: schema.users.id, passwordHash: schema.users.passwordHash }).from(schema.users).where(eq(schema.users.id, req.user!.id));
  if (!u) throw forbidden();
  await assertCurrentPassword(req, u, body.password, 'Senha incorreta', 'password_invalid');
  if (currentOperation()) throw new HttpError(409, 'Há um backup, restauração ou atualização em andamento. Espere terminar e tente de novo.', 'operation_running');
  // já agendada: só "apagar agora" (antecipar) faz sentido
  if (o.deletionDueAt && !body.now) throw new HttpError(409, 'A remoção deste espaço já foi pedida.', 'already_requested');
  return { now: body.now };
}

/** Apagar na hora: grava o pedido com prazo vencido e roda a remoção já (mesmo caminho do job). */
async function removeNow(req: FastifyRequest, o: Org, byPlatform: boolean) {
  const now = new Date();
  const byName = req.user!.name.slice(0, 120);
  await db.update(schema.organizations).set({
    deletionRequestedAt: o.deletionRequestedAt ?? now, deletionDueAt: now, deletionRequestedBy: req.user!.id, deletionRequestedByName: byName,
    deletionByPlatform: byPlatform, deletionReminderAt: now,
  }).where(eq(schema.organizations.id, o.id));
  await audit(req, { orgId: null, action: 'platform.org_deletion_now', entityType: 'organization', entityId: o.id,
    description: `Pediu a remoção imediata de ${platformLabel(o)}${byPlatform ? ' (espaço sem dono)' : ''}${o.deletionDueAt ? ' (antecipou o prazo)' : ''}` });
  if (!(await purgeOrg(o.id))) throw new HttpError(500, 'Não foi possível apagar o espaço agora. Tente de novo em alguns minutos.', 'purge_failed');
  return { deleted: true };
}

async function schedule(req: FastifyRequest, o: Org, byPlatform: boolean) {
  const now = new Date();
  const dueAt = new Date(now.getTime() + ORG_REMOVAL_DAYS * 86_400_000);
  const byName = req.user!.name.slice(0, 120);
  await db.update(schema.organizations).set({
    deletionRequestedAt: now, deletionDueAt: dueAt, deletionRequestedBy: req.user!.id, deletionRequestedByName: byName,
    deletionByPlatform: byPlatform, deletionReminderAt: null,
  }).where(eq(schema.organizations.id, o.id));
  const impact = await removalImpact(o.id);
  // no espaço (quem administra vê enquanto ele existe) e na plataforma (fica depois que o espaço some)
  await audit(req, { orgId: o.id, action: 'org.deletion_requested', entityType: 'organization', entityId: o.id,
    description: `Pediu a remoção do espaço ${o.name}${byPlatform ? ' (pela plataforma)' : ''}: apagado em ${ORG_REMOVAL_DAYS} dias`, details: { dueAt: dueAt.toISOString(), impact } });
  await audit(req, { orgId: null, action: 'platform.org_deletion_requested', entityType: 'organization', entityId: o.id,
    description: `Pediu a remoção de ${platformLabel(o)}${byPlatform ? ' (espaço sem dono)' : ''}`, details: { dueAt: dueAt.toISOString() } });
  await notifyRequested(o, byName, dueAt, byPlatform).catch(() => undefined);
  return { dueAt: dueAt.toISOString() };
}

async function cancel(req: FastifyRequest, o: Org) {
  if (!o.deletionDueAt) throw badRequest('Este espaço não tem remoção pedida.');
  await db.update(schema.organizations).set({
    deletionRequestedAt: null, deletionDueAt: null, deletionRequestedBy: null, deletionRequestedByName: null, deletionByPlatform: false, deletionReminderAt: null,
  }).where(eq(schema.organizations.id, o.id));
  await audit(req, { orgId: o.id, action: 'org.deletion_cancelled', entityType: 'organization', entityId: o.id, description: `Cancelou a remoção do espaço ${o.name}` });
  await audit(req, { orgId: null, action: 'platform.org_deletion_cancelled', entityType: 'organization', entityId: o.id, description: `Cancelou a remoção de ${platformLabel(o)}` });
  await notifyCancelled(o, req.user!.name).catch(() => undefined);
}

export default async function orgRemovalRoutes(app: FastifyInstance) {
  // ---------------------------------------------------------------- no próprio espaço
  /** Estado (arquivado / remoção pedida) e, para quem decide, o que seria apagado. */
  app.get('/api/org/removal', { preHandler: requireOrg }, async (req) => {
    const o = await loadOrg(req.org!.id);
    return {
      days: ORG_REMOVAL_DAYS, isOwner: req.org!.isOwner, isAdmin: req.org!.isAdmin,
      archivedAt: o.archivedAt?.toISOString() ?? null, deletion: deletionView(o),
      impact: req.org!.isOwner ? await removalImpact(o.id) : null,
    };
  });

  /** Arquivar / desarquivar: administradores do espaço. */
  app.put('/api/org/archive', { preHandler: requireOrg }, async (req) => {
    const body = parse(orgArchiveSchema, req.body);
    if (!req.org!.isAdmin) throw forbidden('Só os administradores do espaço podem arquivar ou desarquivar');
    const o = await loadOrg(req.org!.id);
    if (o.deletionDueAt) throw badRequest('A remoção deste espaço foi pedida. Cancele a remoção antes de mudar o arquivamento.', 'deletion_pending');
    if (!!o.archivedAt === body.archived) return { archivedAt: o.archivedAt?.toISOString() ?? null };
    const [u] = await db.update(schema.organizations).set({ archivedAt: body.archived ? new Date() : null, archivedBy: body.archived ? req.user!.id : null })
      .where(eq(schema.organizations.id, o.id)).returning({ archivedAt: schema.organizations.archivedAt });
    await audit(req, { action: body.archived ? 'org.archive' : 'org.unarchive', entityType: 'organization', entityId: o.id,
      description: body.archived ? `Arquivou o espaço ${o.name}` : `Desarquivou o espaço ${o.name}`, details: { changes: { archived: { from: !body.archived, to: body.archived } } } });
    return { archivedAt: u!.archivedAt?.toISOString() ?? null };
  });

  /** Pedir a remoção: só o dono, com nome + senha + caixa marcada. */
  app.post('/api/org/deletion', { preHandler: requireOrg }, async (req) => {
    if (!req.org!.isOwner) throw forbidden('Só o dono do espaço pode pedir a remoção');
    const o = await loadOrg(req.org!.id);
    const { now } = await assertConfirmed(req, o);
    return now ? removeNow(req, o, false) : schedule(req, o, false);
  });

  app.delete('/api/org/deletion', { preHandler: requireOrg }, async (req) => {
    if (!req.org!.isOwner) throw forbidden('Só o dono do espaço pode cancelar a remoção');
    await cancel(req, await loadOrg(req.org!.id));
    return { ok: true };
  });

  // ---------------------------------------------------------------- plataforma: espaços sem dono
  const guard = { preHandler: requireSuperadmin };
  /** A plataforma só remove espaço sem dono ativo, e nunca um espaço privado. */
  async function platformOrg(req: FastifyRequest<{ Params: { orgId: string } }>) {
    const o = await loadOrg(req.params.orgId);
    if (o.isPrivate) throw new HttpError(403, 'Espaço privado: só o dono dele pode removê-lo.', 'private_space');
    return o;
  }

  /** Espaços sem dono ativo (candidatos) e os que a plataforma já mandou remover. */
  app.get('/api/system/orgs/ownerless', guard, async (req) => {
    const view = await privacyFor(req.user!.id);
    const orgs = await db.select().from(schema.organizations).orderBy(schema.organizations.name);
    const items = [];
    for (const o of orgs) {
      if (o.isPrivate || view.hidden.has(o.id)) continue;
      const pendingByPlatform = !!o.deletionDueAt && o.deletionByPlatform;
      if (!pendingByPlatform && (await hasActiveOwner(o.id))) continue;
      items.push({ id: o.id, name: o.name, kind: o.kind, archivedAt: o.archivedAt?.toISOString() ?? null, deletion: deletionView(o), usedBytes: await storageUsage(o.id) });
    }
    return { days: ORG_REMOVAL_DAYS, items };
  });

  app.get<{ Params: { orgId: string } }>('/api/system/orgs/:orgId/removal', guard, async (req) => {
    const o = await platformOrg(req);
    return { name: o.name, ownerless: !(await hasActiveOwner(o.id)), deletion: deletionView(o), impact: await removalImpact(o.id), days: ORG_REMOVAL_DAYS };
  });

  app.post<{ Params: { orgId: string } }>('/api/system/orgs/:orgId/deletion', guard, async (req) => {
    const o = await platformOrg(req);
    if (await hasActiveOwner(o.id)) throw badRequest('Este espaço tem dono ativo: só ele pode pedir a remoção.', 'has_owner');
    if (o.deletionDueAt && !o.deletionByPlatform) throw forbidden('Esta remoção foi pedida pelo dono do espaço.');
    const { now } = await assertConfirmed(req, o);
    return now ? removeNow(req, o, true) : schedule(req, o, true);
  });

  app.delete<{ Params: { orgId: string } }>('/api/system/orgs/:orgId/deletion', guard, async (req) => {
    const o = await platformOrg(req);
    if (o.deletionDueAt && !o.deletionByPlatform) throw forbidden('Esta remoção foi pedida pelo dono do espaço: só ele pode cancelar.');
    await cancel(req, o);
    return { ok: true };
  });
}
