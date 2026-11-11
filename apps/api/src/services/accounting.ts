import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db/client.js';
import { loadOrgContext } from '../lib/auth.js';
import { badRequest } from '../lib/errors.js';

/**
 * Os contadores do espaço: membros ativos que recebem documentos (têm "enviar documentos" como
 * contador e não são da equipe que envia). Um espaço pode ter mais de um escritório.
 */
export async function accountantsOf(orgId: string): Promise<Array<{ id: string; name: string }>> {
  const members = await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.memberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.memberships.userId))
    .where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.active, true), eq(schema.users.active, true), isNull(schema.users.deletedAt)));
  const out: Array<{ id: string; name: string }> = [];
  for (const m of members) {
    const ctx = await loadOrgContext(m.id, orgId);
    if (ctx && ctx.can('accounting.upload') && !ctx.can('accounting.send')) out.push(m);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

/**
 * Para quem vai um envio do espaço: um contador só → ele; mais de um → quem envia escolhe (um deles
 * ou "all" = todos). Devolve o id do destinatário ou null (todos os contadores do espaço).
 */
export async function resolveRecipient(orgId: string, raw: string | null | undefined): Promise<string | null> {
  const list = await accountantsOf(orgId);
  if (list.length <= 1) return list[0]?.id ?? null;
  if (raw === 'all') return null;
  if (!raw) throw badRequest('Este espaço tem mais de um contador. Escolha para qual deles vai o envio.', 'recipient_required');
  if (!list.some((a) => a.id === raw)) throw badRequest('Contador inválido');
  return raw;
}
