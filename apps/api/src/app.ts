import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { env, isProd } from './env.js';
import { HttpError } from './lib/errors.js';
import { authenticate } from './lib/auth.js';
import { isMaintenance, registerMaintenance } from './lib/maintenance.js';
import { pool } from './db/client.js';
import authRoutes from './routes/auth.js';
import orgRoutes from './routes/org.js';
import catalogRoutes from './routes/catalog.js';
import billRoutes from './routes/bills.js';
import attachmentRoutes from './routes/attachments.js';
import exportRoutes from './routes/export.js';
import cardRoutes from './routes/cards.js';
import importRoutes from './routes/import.js';
import reportRoutes from './routes/reports.js';
import alertRoutes from './routes/alerts.js';
import systemRoutes from './routes/system.js';
import platformRoutes from './routes/platform.js';
import updateRoutes from './routes/updates.js';
import payrollRoutes from './routes/payroll.js';
import bankRoutes from './routes/bank.js';

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: env.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie'],
      ...(isProd ? {} : { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }),
    },
    // Só confia em X-Forwarded-For vindo de proxies da rede interna (nginx do container web e o
    // Traefik). Com `true`, qualquer cliente forjaria o próprio IP e escaparia do limite de login.
    trustProxy: ['loopback', 'linklocal', 'uniquelocal'],
    bodyLimit: 2 * 1024 * 1024,
  });

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'same-origin' } });
  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute' });
  await app.register(multipart);

  // manutenção antes da autenticação: durante a troca de banco nada pode consultar o banco
  registerMaintenance(app);
  app.addHook('onRequest', async (req) => { if (!isMaintenance()) await authenticate(req); });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.message, code: err.code, ...err.extra });
    }
    const e = err as { statusCode?: number; message: string; code?: string };
    if (e.statusCode && e.statusCode < 500) {
      return reply.status(e.statusCode).send({ error: e.statusCode === 429 ? 'Muitas requisições. Aguarde um pouco.' : e.message, code: e.code });
    }
    req.log.error({ err }, 'erro não tratado');
    return reply.status(500).send({ error: 'Erro interno. Tente novamente.' });
  });

  app.get('/api/health', async () => {
    if (isMaintenance()) return { ok: true, maintenance: true, time: new Date().toISOString() };
    await pool.query('select 1');
    return { ok: true, time: new Date().toISOString() };
  });

  await app.register(authRoutes);
  await app.register(orgRoutes);
  await app.register(catalogRoutes);
  await app.register(billRoutes);
  await app.register(attachmentRoutes);
  await app.register(exportRoutes);
  await app.register(cardRoutes);
  await app.register(importRoutes);
  await app.register(reportRoutes);
  await app.register(alertRoutes);
  await app.register(systemRoutes);
  await app.register(platformRoutes);
  await app.register(updateRoutes);
  await app.register(payrollRoutes);
  await app.register(bankRoutes);
  return app;
}
