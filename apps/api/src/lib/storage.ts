import { createHash, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, unlink, readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { env } from '../env.js';

const root = path.resolve(env.STORAGE_DIR);

export async function saveFile(orgId: string, buf: Buffer, ext: string) {
  const key = `${orgId}/${randomUUID().replace(/-/g, '')}.${ext}`;
  const full = path.join(root, key);
  await mkdir(path.dirname(full), { recursive: true });
  await writeFile(full, buf, { mode: 0o640 });
  return { key, sha256: createHash('sha256').update(buf).digest('hex') };
}

function resolveKey(key: string) {
  if (!/^[0-9a-f-]{36}\/[0-9a-f]{32}\.[a-z0-9]{2,5}$/.test(key)) throw new Error('storage key inválida');
  return path.join(root, key);
}

export async function deleteFile(key: string) {
  try { await unlink(resolveKey(key)); } catch { /* já removido */ }
}
export const readStoredFile = (key: string) => readFile(resolveKey(key));
export const streamStoredFile = (key: string) => createReadStream(resolveKey(key));
export async function fileExists(key: string) {
  try { await stat(resolveKey(key)); return true; } catch { return false; }
}

/** URL assinada de curta duração para servir anexos em <iframe>/<img>/download. */
export function signFileToken(attachmentId: string, ttlSeconds = 600) {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = createHmac('sha256', env.JWT_SECRET).update(`${attachmentId}.${exp}`).digest('base64url');
  return `${exp}.${sig}`;
}
export function verifyFileToken(attachmentId: string, token: string) {
  const [expS, sig] = token.split('.');
  const exp = Number(expS);
  if (!exp || exp < Date.now() / 1000 || !sig) return false;
  const expected = createHmac('sha256', env.JWT_SECRET).update(`${attachmentId}.${exp}`).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export const ALLOWED_UPLOADS: Record<string, string> = {
  'application/pdf': 'pdf',
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
};

/** Confere assinatura binária (magic bytes) — não confia no mime enviado. */
export function sniffMime(buf: Buffer): string | null {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
