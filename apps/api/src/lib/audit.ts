import type { FastifyRequest } from 'fastify';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import type { DBOrTx } from '../db/client.js';

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string | number | null;
  description?: string;
  details?: unknown;
  orgId?: string | null;
}

export async function audit(req: FastifyRequest | null, e: AuditEntry, conn: DBOrTx = db) {
  try {
    await conn.insert(schema.auditLogs).values({
      orgId: e.orgId ?? req?.org?.id ?? null,
      userId: req?.user?.id ?? null,
      userName: req?.user?.name ?? null,
      action: e.action,
      entityType: e.entityType ?? null,
      entityId: e.entityId != null ? String(e.entityId) : null,
      description: e.description ?? null,
      details: (e.details ?? null) as never,
      ip: req?.ip ?? null,
      userAgent: req?.headers['user-agent']?.slice(0, 255) ?? null,
    });
  } catch (err) {
    req?.log.error({ err }, 'falha ao gravar auditoria');
  }
}

// ------------------------------------------------------------------ consulta (tela de Auditoria)
export interface AuditQuery { before?: string; area?: string; user?: string; q?: string; from?: string; to?: string; tz?: string }

/** Prefixos aceitos em `area` (lista separada por vírgula), ex.: "payable,card". */
const AREA_RE = /^[a-z_]+$/;

/**
 * Filtros comuns da auditoria. `scope` = id do espaço, ou 'platform' (eventos sem espaço: login, plataforma)
 * ou 'all' (tudo, só superadmin). `hideRestricted` esconde registros de categorias restritas.
 */
export async function queryAudit(scope: string | 'platform' | 'all', f: AuditQuery, hideRestricted: boolean, limit = 100) {
  const t = schema.auditLogs;
  const conds = [];
  if (scope === 'platform') conds.push(isNull(t.orgId));
  else if (scope !== 'all') conds.push(eq(t.orgId, scope));
  if (f.before && /^\d+$/.test(f.before)) conds.push(lt(t.id, Number(f.before)));
  const areas = (f.area ?? '').split(',').map((a) => a.trim()).filter((a) => AREA_RE.test(a));
  if (areas.length) conds.push(or(...areas.map((a) => sql`${t.action} like ${a + '.%'}`))!);
  if (f.user === 'system') conds.push(isNull(t.userId));
  else if (f.user && /^[0-9a-f-]{36}$/i.test(f.user)) conds.push(eq(t.userId, f.user));
  if (f.q?.trim()) {
    const term = `%${f.q.trim().toLowerCase().slice(0, 100)}%`;
    conds.push(sql`(lower(coalesce(${t.description}, '')) like ${term} or lower(${t.action}) like ${term} or lower(coalesce(${t.userName}, '')) like ${term} or lower(coalesce(${t.details}::text, '')) like ${term})`);
  }
  const tz = f.tz && /^[A-Za-z_]+\/[A-Za-z_\/]+$/.test(f.tz) ? f.tz : 'America/Sao_Paulo';
  if (f.from && /^\d{4}-\d{2}-\d{2}$/.test(f.from)) conds.push(sql`${t.createdAt} >= (${f.from}::date)::timestamp at time zone ${tz}`);
  if (f.to && /^\d{4}-\d{2}-\d{2}$/.test(f.to)) conds.push(sql`${t.createdAt} < (${f.to}::date + 1)::timestamp at time zone ${tz}`);
  if (hideRestricted) conds.push(sql`coalesce((${t.details}->>'restricted')::boolean, false) = false`);
  const rows = await db.select({
    id: t.id, orgId: t.orgId, userId: t.userId, userName: t.userName, action: t.action, entityType: t.entityType, entityId: t.entityId,
    description: t.description, details: t.details, ip: t.ip, userAgent: t.userAgent, createdAt: t.createdAt,
    orgName: schema.organizations.name,
  }).from(t).leftJoin(schema.organizations, eq(schema.organizations.id, t.orgId))
    .where(conds.length ? and(...conds) : undefined).orderBy(desc(t.id)).limit(limit);
  return { items: rows, nextBefore: rows.length === limit ? String(rows.at(-1)!.id) : null };
}

/** Quem aparece na auditoria do escopo (para o filtro por pessoa). */
export async function auditUsers(scope: string | 'platform' | 'all') {
  const t = schema.auditLogs;
  const where = scope === 'platform' ? isNull(t.orgId) : scope === 'all' ? undefined : eq(t.orgId, scope);
  const rows = await db.selectDistinctOn([t.userId], { id: t.userId, name: t.userName }).from(t).where(where).orderBy(t.userId, sql`${t.id} desc`);
  return rows.filter((r) => r.id).map((r) => ({ id: r.id!, name: r.name ?? '—' })).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}
