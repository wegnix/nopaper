import { sql } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import { usernameSchema, type OrgKind } from '@nopaper/shared';
import type { DBOrTx } from '../db/client.js';
import { db, schema } from '../db/client.js';
import { env } from '../env.js';
import { hashPassword } from '../lib/auth.js';
import { createOrganization } from './orgs.js';

/**
 * Primeiro boot: se não houver nenhum usuário, cria o administrador da plataforma com os dados
 * do .env (ADMIN_*). A senha é provisória e precisa ser trocada no primeiro login. Com usuários
 * já cadastrados, nada aqui é lido — mudar o .env depois não altera nem recria ninguém.
 * O espaço inicial só é criado no 1º acesso, quando o admin escolhe nome (sugestão: ADMIN_ORG_NAME)
 * e perfil (Pessoal/Empresa) na tela de troca de senha — ver `createInitialOrg`.
 */
export async function ensureInitialAdmin(log: FastifyBaseLogger) {
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(schema.users);
  if (count > 0) return;
  if (!env.ADMIN_EMAIL || !env.ADMIN_PASSWORD) {
    log.warn('Nenhum usuário cadastrado e ADMIN_EMAIL/ADMIN_PASSWORD não definidos no .env: ninguém consegue entrar. Defina-os e reinicie a API.');
    return;
  }
  const username = usernameSchema.parse(env.ADMIN_USERNAME);
  await db.insert(schema.users).values({
    email: env.ADMIN_EMAIL!.toLowerCase(), username, name: env.ADMIN_NAME,
    passwordHash: await hashPassword(env.ADMIN_PASSWORD!), isSuperadmin: true, mustChangePassword: true,
  });
  log.info({ username }, 'administrador inicial criado a partir do .env (senha provisória: troque no primeiro login)');
}

/** Admin da instalação ainda sem espaço: escolhe o perfil do espaço inicial no 1º acesso. */
export async function needsInitialOrg(tx: DBOrTx, u: { id: string; isSuperadmin: boolean; mustChangePassword: boolean }) {
  if (!u.isSuperadmin || !u.mustChangePassword) return false;
  const [{ count }] = await tx.select({ count: sql<number>`count(*)::int` }).from(schema.organizations);
  return count === 0;
}

export async function createInitialOrg(tx: DBOrTx, ownerId: string, kind: OrgKind, name?: string) {
  return createOrganization(tx, { name: name || env.ADMIN_ORG_NAME, kind, ownerId });
}
