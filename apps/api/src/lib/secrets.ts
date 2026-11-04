import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { env } from '../env.js';

/**
 * Segredos guardados no banco (senha SMTP, token do bot, credenciais de backup) são
 * cifrados com AES-256-GCM. A chave vem de SECRETS_KEY; sem ela, é derivada do JWT_SECRET
 * (trocar o JWT_SECRET nesse caso exige recadastrar os segredos).
 */
const key = Buffer.from(hkdfSync('sha256', env.SECRETS_KEY ?? env.JWT_SECRET, 'nopaper', 'secrets-v1', 32));

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${enc.toString('base64url')}`;
}

export function decryptSecret(blob: string | null | undefined): string | null {
  if (!blob) return null;
  const [v, iv, tag, data] = blob.split('.');
  if (v !== 'v1' || !iv || !tag || !data) return null;
  try {
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** Aplica a regra de gravação: undefined/'' mantém, null apaga, texto novo cifra. */
export function nextSecret(incoming: string | null | undefined, current: string | null | undefined): string | null {
  if (incoming === null) return null;
  if (incoming === undefined || incoming === '') return current ?? null;
  return encryptSecret(incoming);
}
