import type { FastifyInstance, FastifyRequest } from 'fastify';

/**
 * Modo manutenção (restauração de backup): toda requisição recebe 503 `maintenance`,
 * exceto o status da restauração e o health check. Antes de mexer no banco, `drain()`
 * espera as requisições que já estavam em andamento terminarem.
 */
let active = false;
let inflight = 0;
const ALLOWED = ['/api/system/restore/status', '/api/health'];
const tracked = new WeakSet<FastifyRequest>();

export const isMaintenance = () => active;
export function enterMaintenance() { active = true; }
export function exitMaintenance() { active = false; }

export async function drainRequests(timeoutMs = 30_000) {
  const until = Date.now() + timeoutMs;
  while (inflight > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 100));
  return inflight === 0;
}

export function registerMaintenance(app: FastifyInstance) {
  app.addHook('onRequest', async (req, reply) => {
    const url = req.url.split('?')[0]!;
    if (active && !ALLOWED.includes(url)) {
      return reply.code(503).header('retry-after', '5').send({ error: 'Sistema em manutenção: um backup está sendo restaurado. Aguarde alguns instantes.', code: 'maintenance' });
    }
    inflight++;
    tracked.add(req);
  });
  const done = async (req: FastifyRequest) => { if (tracked.delete(req)) inflight--; };
  app.addHook('onResponse', done);
  app.addHook('onRequestAbort', done);
}
