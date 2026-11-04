import { DEFAULT_IDLE_TIMEOUT_MINUTES, securitySettingsSchema, type SecuritySettings } from '@nopaper/shared';
import { getSystemSetting } from './settings.js';

// ------------------------------------------------------------------ logoff por inatividade
let cache: { value: SecuritySettings; at: number } | null = null;

/** Configuração de segurança da plataforma (cache de 30 s: é lida a cada requisição autenticada). */
export async function securitySettings(): Promise<SecuritySettings> {
  if (cache && Date.now() - cache.at < 30_000) return cache.value;
  const stored = await getSystemSetting<Partial<SecuritySettings>>('security');
  const parsed = securitySettingsSchema.safeParse({ idleTimeoutMinutes: DEFAULT_IDLE_TIMEOUT_MINUTES, ...stored });
  const value = parsed.success ? parsed.data : { idleTimeoutMinutes: DEFAULT_IDLE_TIMEOUT_MINUTES };
  cache = { value, at: Date.now() };
  return value;
}
export const invalidateSecuritySettings = () => { cache = null; };

/**
 * Folga do servidor sobre o tempo configurado: o front manda o heartbeat de atividade a cada ~2 min
 * e desconecta sozinho no tempo exato; o servidor só corta depois, para nunca derrubar quem está usando.
 */
const IDLE_GRACE_MS = 3 * 60_000;

/** A sessão passou do tempo máximo sem interação da pessoa? */
export async function isSessionIdle(lastActivityAt: Date) {
  const { idleTimeoutMinutes } = await securitySettings();
  return Date.now() - lastActivityAt.getTime() > idleTimeoutMinutes * 60_000 + IDLE_GRACE_MS;
}

// ------------------------------------------------------------------ tentativas de login
/**
 * Bloqueio por conta (além do limite por IP): depois de MAX_FAILS senhas erradas para o mesmo
 * login em WINDOW, novas tentativas para ele são recusadas por LOCK — mesmo vindas de IPs
 * diferentes. Em memória (processo único); reiniciar a API zera os contadores.
 */
const MAX_FAILS = 5;
const WINDOW_MS = 15 * 60_000;
const LOCK_MS = 15 * 60_000;
const attempts = new Map<string, { fails: number; first: number; lockedUntil: number }>();

/** Segundos que ainda faltam de bloqueio para este login (0 = liberado). */
export function loginLockedFor(login: string) {
  const a = attempts.get(login);
  if (!a) return 0;
  const left = a.lockedUntil - Date.now();
  if (left > 0) return Math.ceil(left / 1000);
  if (Date.now() - a.first > WINDOW_MS) attempts.delete(login);
  return 0;
}

export function registerLoginFailure(login: string) {
  const now = Date.now();
  let a = attempts.get(login);
  if (!a || now - a.first > WINDOW_MS) a = { fails: 0, first: now, lockedUntil: 0 };
  a.fails++;
  if (a.fails >= MAX_FAILS) a.lockedUntil = now + LOCK_MS;
  attempts.set(login, a);
  if (attempts.size > 10_000) for (const [k, v] of attempts) if (now - v.first > WINDOW_MS && v.lockedUntil < now) attempts.delete(k);
  return a.lockedUntil > now;
}

export const clearLoginFailures = (login: string) => { attempts.delete(login); };
