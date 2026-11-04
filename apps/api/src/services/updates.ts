import { createHmac } from 'node:crypto';
import { compareVersions, isMajorUpgrade } from '@nopaper/shared';
import { env } from '../env.js';
import { APP_VERSION } from '../lib/version.js';

/**
 * Atualização pela interface.
 * - As versões disponíveis vêm das Releases publicadas no GitHub (`UPDATE_REPO`).
 * - Quem aplica é o serviço `updater` (outro container, com acesso ao Docker), chamado pela rede
 *   interna com um token derivado do JWT_SECRET — o mesmo cálculo de updater/server.mjs.
 */
const updaterToken = () => createHmac('sha256', env.JWT_SECRET).update('nopaper-updater').digest('hex');

export interface Release { version: string; name: string; notes: string; publishedAt: string; url: string; major: boolean }
export interface UpdaterStatus {
  state: 'idle' | 'running' | 'done' | 'failed'; from: string | null; to: string | null; step: string | null;
  startedAt: string | null; finishedAt: string | null; error: string | null; log: string[];
}
export interface UpdaterInfo { git: boolean; ref?: string; origin?: string; dirty?: boolean; changes?: Array<{ code: string; file: string }>; error?: string }

async function updater<T>(path: string, init: RequestInit = {}): Promise<T> {
  const r = await fetch(`${env.UPDATER_URL}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${updaterToken()}`, 'content-type': 'application/json', ...init.headers },
    signal: AbortSignal.timeout(5000),
  });
  const data = await r.json().catch(() => ({})) as T & { error?: string };
  if (!r.ok) throw new Error(data.error ?? `updater respondeu ${r.status}`);
  return data;
}

/** null = serviço updater não instalado ou fora do ar. */
export async function updaterInfo(): Promise<UpdaterInfo | null> {
  try { return await updater<UpdaterInfo>('/info'); } catch { return null; }
}
export async function updaterStatus(): Promise<UpdaterStatus | null> {
  try { return await updater<UpdaterStatus>('/status'); } catch { return null; }
}
export const startUpdate = (version: string) => updater<{ started: boolean }>('/update', { method: 'POST', body: JSON.stringify({ version }) });

// ------------------------------------------------------------------ releases do GitHub
let cache: { at: number; releases: Release[]; error: string | null } | null = null;
const CACHE_MS = 15 * 60_000; // a API pública do GitHub permite 60 consultas/hora por IP

/** Releases publicadas mais novas que a versão instalada (mais nova primeiro). */
export async function availableReleases(force = false) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache;
  try {
    const r = await fetch(`https://api.github.com/repos/${env.UPDATE_REPO}/releases?per_page=30`, {
      headers: { accept: 'application/vnd.github+json', 'user-agent': `nopaper/${APP_VERSION}`, 'x-github-api-version': '2022-11-28' },
      signal: AbortSignal.timeout(10_000),
    });
    if (r.status === 404) throw new Error(`repositório ${env.UPDATE_REPO} não encontrado`);
    if (r.status === 403 || r.status === 429) throw new Error('limite de consultas ao GitHub atingido; tente de novo em alguns minutos');
    if (!r.ok) throw new Error(`GitHub respondeu ${r.status}`);
    const rows = await r.json() as Array<{ tag_name: string; name: string | null; body: string | null; published_at: string; html_url: string; draft: boolean; prerelease: boolean }>;
    const releases = rows
      .filter((x) => !x.draft && !x.prerelease && /^v\d+\.\d+\.\d+$/.test(x.tag_name) && compareVersions(x.tag_name, APP_VERSION) > 0)
      .sort((a, b) => compareVersions(b.tag_name, a.tag_name))
      .map((x): Release => ({
        version: x.tag_name, name: x.name || x.tag_name, notes: (x.body ?? '').slice(0, 20_000),
        publishedAt: x.published_at, url: x.html_url, major: isMajorUpgrade(APP_VERSION, x.tag_name),
      }));
    cache = { at: Date.now(), releases, error: null };
  } catch (e) {
    cache = { at: Date.now(), releases: cache?.releases ?? [], error: `Não foi possível consultar as versões: ${(e as Error).message}` };
  }
  return cache;
}
