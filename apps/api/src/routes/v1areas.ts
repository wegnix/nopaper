import type { FastifyInstance } from 'fastify';
import { createForward } from '../lib/forward.js';
import { V1_AREA_ROUTES } from '../lib/v1catalog.js';
import type { V1Helpers } from './v1write.js';

/**
 * Cartões, bancos, folha, assinatura, contador, relatórios e auditoria na API pública: cada linha
 * de `V1_AREA_ROUTES` vira uma rota que repassa a chamada à rota interna de mesmo endereço.
 * Permissão, categoria restrita, travas e auditoria são conferidas lá, com as permissões do token.
 */
export function registerV1Areas(app: FastifyInstance, api: FastifyInstance, h: V1Helpers) {
  const { proxy } = createForward(app);
  for (const route of V1_AREA_ROUTES) {
    api.route({
      method: route.method, url: `/api/v1${route.path}`, ...h.limited,
      handler: (req, reply) => proxy(req, reply, route.method, req.url.replace('/api/v1/', '/api/')),
    });
  }
}
