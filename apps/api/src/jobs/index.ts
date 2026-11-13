import PgBoss from 'pg-boss';
import type { FastifyBaseLogger } from 'fastify';
import { env } from '../env.js';
import { extendAllIndefinite } from '../services/bills.js';
import { runAlertsTick } from '../services/alerts.js';
import { runBackupTick } from '../services/backup.js';
import { deliverWebhooks } from '../services/webhooks.js';
import { cleanIdempotencyKeys } from '../services/integrations.js';

let boss: PgBoss | null = null;

type Handler = () => Promise<unknown>;
const handlers: Record<string, { cron: string; run: Handler }> = {
  'bills.extend-indefinite': { cron: '30 3 * * *', run: extendAllIndefinite },
  // verificam se já chegou a hora configurada (e se já rodaram hoje): alertas de 5 em 5 min
  // (o horário aceita minutos), backup a cada 15
  'alerts.tick': { cron: '*/5 * * * *', run: runAlertsTick },
  // rede de segurança: a entrega normal dispara logo depois de cada mudança (lib/webhookKick.ts)
  'webhooks.tick': { cron: '* * * * *', run: deliverWebhooks },
  'api.cleanup': { cron: '50 3 * * *', run: cleanIdempotencyKeys },
  'backup.tick': { cron: '7,22,37,52 * * * *', run: runBackupTick },
};

/** Registra handlers extras (alertas, backups) — chamado pelos módulos antes do start. */
export function registerJob(name: string, cron: string, run: Handler) {
  handlers[name] = { cron, run };
}

export async function startJobs(log: FastifyBaseLogger) {
  boss = new PgBoss({ connectionString: env.DATABASE_URL, schema: 'pgboss' });
  boss.on('error', (err) => log.error({ err }, 'pg-boss'));
  await boss.start();
  for (const [name, h] of Object.entries(handlers)) {
    await boss.createQueue(name);
    await boss.schedule(name, h.cron, {}, { tz: env.TZ_DEFAULT });
    await boss.work(name, async () => {
      const r = await h.run();
      log.info({ job: name, result: r }, 'job concluído');
    });
  }
  // roda a extensão uma vez no boot (idempotente)
  extendAllIndefinite().then((r) => log.info({ r }, 'extensão de recorrências no boot')).catch((err) => log.error({ err }));
  return boss;
}

export async function triggerJob(name: string, data: object = {}) {
  if (!boss) throw new Error('jobs não iniciados');
  return boss.send(name, data);
}

/** Para a fila e espera os jobs em execução (a restauração chama antes de trocar o banco). */
export async function stopJobs(timeout = 5000) {
  const b = boss;
  boss = null;
  await b?.stop({ graceful: true, wait: true, timeout });
}
