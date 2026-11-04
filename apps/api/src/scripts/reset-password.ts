/**
 * Gera uma senha provisória para um usuário (ex.: administrador que esqueceu a senha).
 *   docker compose exec api node dist/scripts/reset-password.js <usuario-ou-email>
 * A pessoa entra com a senha mostrada e é obrigada a trocar. Todas as sessões dela são encerradas.
 */
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { db, pool, schema } from '../db/client.js';
import { hashPassword } from '../lib/auth.js';

const who = (process.argv[2] ?? '').trim().toLowerCase();
if (!who) { console.error('Uso: node dist/scripts/reset-password.js <usuario-ou-email>'); process.exit(1); }
const [u] = await db.select().from(schema.users)
  .where(who.includes('@') ? sql`lower(${schema.users.email}) = ${who}` : sql`lower(${schema.users.username}) = ${who}`);
if (!u) { console.error(`Usuário "${who}" não encontrado.`); await pool.end(); process.exit(1); }
const temp = randomBytes(9).toString('base64url');
await db.update(schema.users).set({ passwordHash: await hashPassword(temp), mustChangePassword: true, active: true }).where(eq(schema.users.id, u.id));
await db.update(schema.sessions).set({ revokedAt: new Date() }).where(eq(schema.sessions.userId, u.id));
await db.insert(schema.auditLogs).values({ action: 'auth.password_reset_cli', entityType: 'user', entityId: u.id, description: `Senha provisória gerada pela linha de comando para ${u.username}` });
console.log(`Senha provisória de ${u.username} (${u.email}): ${temp}\nEla será exigida a troca no próximo login.`);
await pool.end();
