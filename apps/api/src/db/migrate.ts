import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { db } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// src/db -> ../../drizzle  |  dist/db -> ../../drizzle
const migrationsFolder = path.resolve(here, '../../drizzle');

export async function runMigrations() {
  await migrate(db, { migrationsFolder });
}

/** Aplica as migrations em outro banco (usado pela restauração, antes de trocar os bancos). */
export async function migrateDatabase(connectionString: string) {
  const pool = new pg.Pool({ connectionString, max: 1 });
  pool.on('error', () => { /* conexão encerrada: o erro aparece na própria consulta */ });
  try {
    await migrate(drizzle(pool), { migrationsFolder });
  } finally {
    await pool.end();
  }
}

/** Última migration conhecida por este código (o drizzle grava `when` em __drizzle_migrations.created_at). */
export function latestMigration(): { tag: string; when: number } {
  const journal = JSON.parse(readFileSync(path.join(migrationsFolder, 'meta/_journal.json'), 'utf8')) as { entries: Array<{ tag: string; when: number }> };
  const last = journal.entries[journal.entries.length - 1]!;
  return { tag: last.tag, when: last.when };
}
