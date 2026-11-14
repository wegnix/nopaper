import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { HttpError } from './errors.js';
import { INTERNAL_KEY } from '../services/integrations.js';

/**
 * A API pública não repete regra de negócio: repassa a chamada à rota interna equivalente (a mesma
 * que a tela usa), com o mesmo token. Só com `INTERNAL_KEY` — que nunca sai do servidor — um token
 * de integração é aceito fora de `/api/v1`; lá ele age como uma "pessoa" cujo id é o do token.
 */
export type ForwardMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

/**
 * O endereço interno é montado com pedaços que vêm de quem chama (ids). Um id com "/", "..", "?"
 * ou "#" (ou a forma codificada deles) levaria o repasse a OUTRA rota interna, fora da lista da
 * API pública. Só passa caminho feito de letras, números, "-", "_", "." e "/", sem "..".
 */
export function assertInternalUrl(url: string) {
  const q = url.indexOf('?');
  const path = q < 0 ? url : url.slice(0, q);
  const ok = path.startsWith('/api/') && /^[A-Za-z0-9/_.-]+$/.test(path) && !path.includes('..') && !path.includes('//') && !url.includes('#') && !url.includes('\\');
  if (!ok) throw new HttpError(404, 'Não encontrado', 'not_found');
}

export function createForward(app: FastifyInstance) {
  async function send(req: FastifyRequest, method: ForwardMethod, url: string, payload?: object, raw = false) {
    assertInternalUrl(url);
    const headers: Record<string, string> = { authorization: req.headers.authorization!, 'x-np-internal': INTERNAL_KEY };
    if (raw) {
      // envio de arquivo: o corpo segue como veio
      headers['content-type'] = String(req.headers['content-type'] ?? '');
      if (req.headers['content-length']) headers['content-length'] = String(req.headers['content-length']);
    }
    const res = await app.inject({ method, url, headers, remoteAddress: req.ip, ...(raw ? { payload: req.raw } : payload ? { payload } : {}) });
    if (res.statusCode >= 400) {
      let body: Record<string, unknown> | null = null;
      try { body = res.json(); } catch { /* sem corpo */ }
      const { error, code, ...extra } = body ?? {};
      throw new HttpError(res.statusCode, typeof error === 'string' ? error : 'Não foi possível concluir', typeof code === 'string' ? code : undefined, extra);
    }
    return res;
  }

  /** Chama a rota interna e devolve o corpo JSON (erro vira HttpError). */
  async function forward<T = Record<string, unknown>>(req: FastifyRequest, method: ForwardMethod, url: string, payload?: object, raw = false): Promise<T> {
    const res = await send(req, method, url, payload, raw);
    try { return res.json() as T; } catch { return null as T; }
  }

  /** Repassa a chamada inteira (endereço, consulta e corpo) e devolve a resposta como veio, inclusive arquivo. */
  async function proxy(req: FastifyRequest, reply: FastifyReply, method: ForwardMethod, internalUrl: string) {
    const raw = req.isMultipart();
    const body = !raw && req.body && typeof req.body === 'object' ? (req.body as object) : undefined;
    const res = await send(req, method, internalUrl, method === 'GET' ? undefined : body ?? (raw ? undefined : {}), raw);
    const type = String(res.headers['content-type'] ?? '');
    reply.code(res.statusCode);
    if (type.includes('application/json')) return reply.header('content-type', type).send(res.payload);
    for (const h of ['content-type', 'content-disposition']) if (res.headers[h]) reply.header(h, String(res.headers[h]));
    return reply.send(res.rawPayload);
  }

  return { forward, proxy };
}
