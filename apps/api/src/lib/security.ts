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
 * Senhas erradas, em três contadores (janela de 15 min, em memória — reiniciar a API zera):
 *  - conta + IP: 5 erros → aquele IP fica 15 min sem tentar naquela conta;
 *  - IP: 20 erros em quaisquer contas → o IP fica 15 min sem tentar em nenhuma;
 *  - conta (todos os IPs): 100 erros → a conta trava 15 min (ataque distribuído).
 * O bloqueio "da conta inteira" só no 3º caso evita que alguém de fora, com 5 senhas erradas,
 * impeça o dono de entrar: com o limite por IP, travar uma conta exige vários endereços.
 * `account` = id do usuário quando o login existe; senão o texto digitado.
 */
const WINDOW_MS = 15 * 60_000;
const LOCK_MS = 15 * 60_000;
const LIMITS = { pair: 5, ip: 20, account: 100 };
const attempts = new Map<string, { fails: number; first: number; lockedUntil: number }>();
const keysOf = (account: string, ip: string) => [[`p:${account}|${ip}`, LIMITS.pair], [`i:${ip}`, LIMITS.ip], [`a:${account}`, LIMITS.account]] as const;

/** Segundos que ainda faltam de bloqueio para esta conta vinda deste IP (0 = liberado). */
export function loginLockedFor(account: string, ip: string) {
  let left = 0;
  for (const [k] of keysOf(account, ip)) {
    const a = attempts.get(k);
    if (!a) continue;
    if (a.lockedUntil > Date.now()) left = Math.max(left, Math.ceil((a.lockedUntil - Date.now()) / 1000));
    else if (Date.now() - a.first > WINDOW_MS) attempts.delete(k);
  }
  return left;
}

/** Conta uma senha errada. Devolve true se isso acabou de bloquear. */
export function registerLoginFailure(account: string, ip: string) {
  const now = Date.now();
  let locked = false;
  for (const [k, max] of keysOf(account, ip)) {
    let a = attempts.get(k);
    if (!a || now - a.first > WINDOW_MS) a = { fails: 0, first: now, lockedUntil: 0 };
    a.fails++;
    if (a.fails >= max) { a.lockedUntil = now + LOCK_MS; locked = true; }
    attempts.set(k, a);
  }
  if (attempts.size > 20_000) for (const [k, v] of attempts) if (now - v.first > WINDOW_MS && v.lockedUntil < now) attempts.delete(k);
  return locked;
}

/** Senha certa: zera o par conta+IP (os contadores gerais expiram sozinhos). */
export const clearLoginFailures = (account: string, ip: string) => { attempts.delete(`p:${account}|${ip}`); };
