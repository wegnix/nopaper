import { useSession, type SessionPayload } from './session';
import { useMaintenance } from './maintenance';

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string, public data?: Record<string, unknown>) {
    super(message);
  }
}

/**
 * Resultado da renovação da sessão:
 * - `ok`: novo token de acesso;
 * - `denied`: o servidor recusou (sessão expirada, revogada, por inatividade) → volta ao login;
 * - `offline`: servidor fora do ar/reiniciando ou sem rede → a sessão continua válida, só tentar de novo.
 *   (Antes isso também derrubava para o login, e um F5 depois "voltava" sem pedir senha.)
 */
export type RefreshResult = 'ok' | 'denied' | 'offline';
let refreshing: Promise<RefreshResult> | null = null;

export async function refreshSession(): Promise<RefreshResult> {
  if (!refreshing) {
    refreshing = (async (): Promise<RefreshResult> => {
      try {
        const r = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'same-origin' });
        if (r.ok) { useSession.getState().setSession((await r.json()) as SessionPayload); return 'ok'; }
        if (r.status === 401 || r.status === 403) {
          const data = await r.json().catch(() => ({})) as { code?: string };
          useSession.getState().clear(data.code === 'idle_timeout' ? 'idle' : useSession.getState().status === 'authed' ? 'expired' : null);
          return 'denied';
        }
        if (r.status === 503) useMaintenance.getState().start();
        return 'offline';
      } catch {
        return 'offline';
      } finally {
        setTimeout(() => { refreshing = null; }, 0);
      }
    })();
  }
  return refreshing;
}

/** Abertura do app: renova a sessão e, se o servidor não responder, tenta de novo (1 s, 2 s, 4 s… até 15 s). */
export async function bootSession() {
  for (let wait = 1000; ; wait = Math.min(wait * 2, 15_000)) {
    if ((await refreshSession()) !== 'offline') { useSession.getState().setConnecting(false); return; }
    useSession.getState().setConnecting(true);
    await new Promise((r) => setTimeout(r, wait));
  }
}

/** Rotas de autenticação que nunca disparam a renovação automática (evita laço). */
const NO_REFRESH = /^\/api\/auth\/(login|refresh|logout|password)\b/;

type Body = Record<string, unknown> | unknown[] | FormData | undefined;

export async function api<T = unknown>(method: string, path: string, body?: Body, opts: { raw?: boolean; retry?: boolean } = {}): Promise<T> {
  const { accessToken, orgId } = useSession.getState();
  const headers: Record<string, string> = {};
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  if (orgId) headers['x-org-id'] = orgId;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const r = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
  if (r.status === 401 && opts.retry !== false && !NO_REFRESH.test(path)) {
    const res = await refreshSession();
    if (res === 'ok') return api<T>(method, path, body, { ...opts, retry: false });
    if (res === 'offline') throw new ApiError(503, 'Sem conexão com o servidor. Tente de novo em instantes.', 'offline');
  }
  if (!r.ok) {
    let data: Record<string, unknown> = {};
    try { data = await r.json(); } catch { /* sem corpo */ }
    if (r.status === 503 && data.code === 'maintenance') useMaintenance.getState().start();
    throw new ApiError(r.status, (data.error as string) || `Erro ${r.status}`, data.code as string | undefined, data);
  }
  if (opts.raw) return r as unknown as T;
  if (r.status === 204) return undefined as T;
  return (await r.json()) as T;
}

/** Envio de arquivo com progresso (fetch não informa o progresso do upload). */
export function uploadWithProgress<T>(path: string, file: File, onProgress: (pct: number) => void, retry = true): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    const { accessToken } = useSession.getState();
    if (accessToken) xhr.setRequestHeader('authorization', `Bearer ${accessToken}`);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onerror = () => reject(new ApiError(0, 'Falha de conexão durante o envio'));
    xhr.onload = async () => {
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch { /* sem corpo */ }
      if (xhr.status === 401 && retry && (await refreshSession()) === 'ok') {
        uploadWithProgress<T>(path, file, onProgress, false).then(resolve, reject);
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new ApiError(xhr.status, (data.error as string) || `Erro ${xhr.status}`, data.code as string | undefined, data));
    };
    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  });
}

/** Envio de um formulário (vários arquivos + campos) com progresso, no espaço atual. */
export function uploadFormWithProgress<T>(path: string, build: () => FormData, onProgress: (pct: number) => void, retry = true): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    const { accessToken, orgId } = useSession.getState();
    if (accessToken) xhr.setRequestHeader('authorization', `Bearer ${accessToken}`);
    if (orgId) xhr.setRequestHeader('x-org-id', orgId);
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    xhr.onerror = () => reject(new ApiError(0, 'Falha de conexão durante o envio'));
    xhr.onload = async () => {
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(xhr.responseText || '{}'); } catch { /* sem corpo */ }
      if (xhr.status === 401 && retry && (await refreshSession()) === 'ok') {
        uploadFormWithProgress<T>(path, build, onProgress, false).then(resolve, reject);
        return;
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data as T);
      else reject(new ApiError(xhr.status, xhr.status === 413 ? 'O envio é grande demais para o servidor.' : (data.error as string) || `Erro ${xhr.status}`, data.code as string | undefined, data));
    };
    xhr.send(build());
  });
}

export const get = <T>(p: string) => api<T>('GET', p);
export const post = <T>(p: string, b?: Body) => api<T>('POST', p, b ?? {});
export const put = <T>(p: string, b?: Body) => api<T>('PUT', p, b ?? {});
export const del = <T>(p: string) => api<T>('DELETE', p);

export function qs(params: Record<string, string | number | null | undefined | boolean>) {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') s.set(k, String(v));
  return s.toString();
}

export const errMsg = (e: unknown) => (e instanceof Error ? e.message : 'Erro inesperado');
