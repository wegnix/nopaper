import { createHash, randomUUID, createHmac, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile, unlink, readFile, stat, rename } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Transform, type Readable } from 'node:stream';
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

/**
 * Grava um envio grande direto no disco, sem segurar o arquivo na memória. O tipo é conferido pelos
 * primeiros bytes (`sniff` devolve a extensão ou null = formato recusado). O arquivo fica num
 * temporário oculto (`.up-*`, fora do backup) e só ganha o nome definitivo quando termina inteiro.
 */
export async function saveUploadStream(orgId: string, stream: Readable, sniff: (head: Buffer) => { mime: string; ext: string } | null) {
  const dir = path.join(root, orgId);
  await mkdir(dir, { recursive: true });
  const id = randomUUID().replace(/-/g, '');
  const tmp = path.join(dir, `.up-${id}`);
  const hash = createHash('sha256');
  let size = 0;
  let head = Buffer.alloc(0);
  const tap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      if (head.length < 4096) head = Buffer.concat([head, chunk]).subarray(0, 4096);
      hash.update(chunk); size += chunk.length;
      cb(null, chunk);
    },
  });
  try {
    await pipeline(stream, tap, createWriteStream(tmp, { mode: 0o640 }));
    const kind = size ? sniff(head) : null;
    if (!kind) { await unlink(tmp).catch(() => undefined); return { ok: false as const, size }; }
    const key = `${orgId}/${id}.${kind.ext}`;
    await rename(tmp, path.join(root, key));
    return { ok: true as const, key, sha256: hash.digest('hex'), size, mime: kind.mime };
  } catch (e) {
    await unlink(tmp).catch(() => undefined);
    throw e;
  }
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

/**
 * Formatos a mais aceitos só no envio do espaço para o contador (notas fiscais costumam ir
 * compactadas ou em XML). Nunca são abertos no navegador: são sempre servidos como download.
 */
export const ARCHIVE_UPLOADS: Record<string, string> = {
  'application/zip': 'zip',
  'application/vnd.rar': 'rar',
  'application/x-7z-compressed': '7z',
  'application/xml': 'xml',
};
/** Assinatura dos formatos de ARCHIVE_UPLOADS. */
export function sniffArchive(buf: Buffer): string | null {
  if (buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)) return 'application/zip';
  if (buf.subarray(0, 6).toString('latin1') === 'Rar!\x1a\x07') return 'application/vnd.rar';
  if (buf.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return 'application/x-7z-compressed';
  // XML (NF-e): texto que começa com "<?xml" ou uma tag, com ou sem BOM
  const head = buf.subarray(0, 200).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if (/^<\?xml\s/i.test(head) || /^<[A-Za-z][\w:.-]*[\s>]/.test(head)) return buf.includes(0) ? null : 'application/xml';
  return null;
}

/** Confere assinatura binária (magic bytes) — não confia no mime enviado. */
export function sniffMime(buf: Buffer): string | null {
  if (buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf[0] === 0x89 && buf.subarray(1, 4).toString('latin1') === 'PNG') return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
