import { mkdir } from 'node:fs/promises';
import { env } from './env.js';
import { buildApp } from './app.js';
import { runMigrations } from './db/migrate.js';
import { startJobs, stopJobs } from './jobs/index.js';
import { ensureInitialAdmin } from './services/bootstrap.js';
import { pool } from './db/client.js';
import { cleanupInterruptedBackups } from './services/backup.js';
import { recoverInterruptedRestore } from './services/restore.js';

const app = await buildApp();
await mkdir(env.STORAGE_DIR, { recursive: true });
await mkdir(env.BACKUP_DIR, { recursive: true });
// antes das migrations: se o servidor caiu no meio de uma restauração, volta ao estado anterior
await recoverInterruptedRestore(app.log);
await runMigrations();
app.log.info('migrations aplicadas');
await cleanupInterruptedBackups();
await ensureInitialAdmin(app.log);
await startJobs(app.log);
await app.listen({ host: env.HOST, port: env.PORT });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    app.log.info(`${sig} recebido, encerrando`);
    await app.close();
    await stopJobs();
    await pool.end();
    process.exit(0);
  });
}
