import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { env } from '../env.js';
import * as schema from './schema.js';

// numeric -> string (padrão do pg), date -> string 'YYYY-MM-DD'
pg.types.setTypeParser(1082, (v) => v);

export const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 15 });
// conexão ociosa derrubada pelo banco (ex.: troca de banco na restauração): o pool descarta
// e abre outra na próxima consulta. Sem este handler, o processo cairia.
pool.on('error', (err) => { console.warn('[db] conexão ociosa encerrada:', err.message); });
export const db = drizzle(pool, { schema, casing: 'snake_case' });
export type DB = typeof db;
export type Tx = Parameters<Parameters<DB['transaction']>[0]>[0];
export type DBOrTx = DB | Tx;
export { schema };
