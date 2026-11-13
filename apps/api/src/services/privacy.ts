import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { HttpError } from '../lib/errors.js';

/**
 * Espaço privado (`organizations.is_private`, ligado só pelo dono): a Plataforma deixa de alcançar o
 * espaço. Um administrador da plataforma que não é administrador DAQUELE espaço não consegue:
 * pôr/tirar membros dele, definir senha provisória para quem é membro dele (seria entrar como a
 * pessoa), nem ver o nome dele ou a auditoria dele nas telas da Plataforma.
 *
 * Limite conhecido (não é resolvido aqui): o arquivo de backup e o acesso ao servidor continuam
 * contendo os dados de todos os espaços.
 */
export const PRIVATE_SPACE_LABEL = 'Espaço privado';

export interface PrivacyView {
  /** Privados em que a pessoa não é membro ativo: nome e auditoria escondidos. */
  hidden: Set<string>;
  /** Privados em que a pessoa não é administradora (dono ou grupo de acesso total): não mexe pela plataforma. */
  locked: Set<string>;
}

export async function privacyFor(actorId: string): Promise<PrivacyView> {
  const r = await db.execute<{ id: string; member: boolean; admin: boolean }>(sql`
    select o.id, (m.id is not null) as member,
      coalesce(m.is_owner or exists (select 1 from membership_groups mg join groups g on g.id = mg.group_id where mg.membership_id = m.id and g.is_admin), false) as admin
    from organizations o
    left join memberships m on m.org_id = o.id and m.user_id = ${actorId} and m.active
    where o.is_private`);
  const hidden = new Set<string>(), locked = new Set<string>();
  for (const x of r.rows) { if (!x.member) hidden.add(x.id); if (!x.admin) locked.add(x.id); }
  return { hidden, locked };
}

/** A plataforma não mexe nos membros de um espaço privado (quem é administrador dele usa a tela Membros). */
export function assertOrgOpenToPlatform(view: PrivacyView, orgId: string) {
  if (view.locked.has(orgId)) throw new HttpError(403, 'Este espaço é privado: só os administradores dele definem quem participa.', 'private_space');
}

/** A conta participa de algum espaço privado que quem pede não administra? */
export async function inLockedSpace(view: PrivacyView, userId: string) {
  if (!view.locked.size) return false;
  const r = await db.execute<{ org_id: string }>(sql`select org_id from memberships where user_id = ${userId}`);
  return r.rows.some((x) => view.locked.has(x.org_id));
}
