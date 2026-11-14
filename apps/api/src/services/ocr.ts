/**
 * Leitura de documentos que não têm texto: PDF escaneado, foto, print, e PDFs em que as letras não
 * viram texto (guias de DARF/FGTS). Usa ferramentas do sistema instaladas na imagem da API:
 * `pdftoppm` (poppler) transforma as páginas em imagem, `tesseract` lê o texto (OCR em português)
 * e `zbarimg` lê o código de barras do boleto e o QR Code do PIX (precisa do `imagemagick` para abrir as imagens). Tudo é opcional: sem as ferramentas, ou se algo
 * falhar ou demorar, devolve null e o documento segue como "não reconhecido" (escolha manual).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const PAGES = 2;          // boleto, nota e comprovante se resolvem na 1ª página; a 2ª é folga
const DPI = 200;
const STEP_MS = 25_000;   // teto de cada ferramenta
const MAX_BYTES = 20 * 1024 * 1024;
const MAX_SIDE = 2400;    // lado maior da página em pixels (A4 a 200 dpi tem 2339): página gigante não vira imagem gigante
const MAX_PIXELS = 40_000_000; // foto/print: acima disso não vai para o OCR (uma imagem de poucos KB pode declarar 20.000×20.000)
const MAX_QUEUE = 8;      // leituras esperando; acima disso o documento segue sem OCR (escolha manual)

/** Largura × altura declaradas no cabeçalho da imagem (PNG, JPEG ou WebP); null se não deu para ler. */
export function imagePixels(buf: Buffer): number | null {
  try {
    if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return buf.readUInt32BE(16) * buf.readUInt32BE(20);
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      for (let i = 2; i + 9 < buf.length;) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1]!;
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return buf.readUInt16BE(i + 5) * buf.readUInt16BE(i + 7);
        if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7) || m === 0x01) { i += 2; continue; }
        i += 2 + buf.readUInt16BE(i + 2);
      }
      return null;
    }
    if (buf.length > 30 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') {
      const kind = buf.toString('latin1', 12, 16);
      if (kind === 'VP8X') return (1 + buf.readUIntLE(24, 3)) * (1 + buf.readUIntLE(27, 3));
      if (kind === 'VP8 ') return (buf.readUInt16LE(26) & 0x3fff) * (buf.readUInt16LE(28) & 0x3fff);
      if (kind === 'VP8L') { const b = buf.readUInt32LE(21); return (1 + (b & 0x3fff)) * (1 + ((b >> 14) & 0x3fff)); }
    }
  } catch { /* cabeçalho truncado */ }
  return null;
}

const run = (cmd: string, args: string[], timeout = STEP_MS) => new Promise<string | null>((resolve) => {
  execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024, killSignal: 'SIGKILL' }, (err, stdout) => resolve(err && !stdout ? null : String(stdout)));
});

let tools: Promise<{ ocr: boolean; pdf: boolean; zbar: boolean }> | null = null;
/** Quais ferramentas existem neste servidor (conferido uma vez). */
export function ocrTools() {
  tools ??= (async () => {
    const has = async (cmd: string, arg: string) => (await run(cmd, [arg], 5000)) !== null;
    const [ocr, pdf, zbar] = await Promise.all([has('tesseract', '--version'), has('pdftoppm', '-v'), has('zbarimg', '--version')]);
    return { ocr, pdf, zbar };
  })();
  return tools;
}

// uma leitura por vez: OCR usa bastante processador e os envios podem vir em lote
let queue: Promise<unknown> = Promise.resolve();

export interface Seen {
  text: string;
  /** Código de barras do boleto (44 dígitos), se lido da imagem. */
  barcode: string | null;
  /** Conteúdo de um QR Code do PIX ("000201…"), se houver. */
  pix: string | null;
}

let waiting = 0;
export function ocrDocument(buf: Buffer, mime: string): Promise<Seen | null> {
  // fila cheia (envio em massa): não acumula arquivos na memória nem atrasa os demais por minutos
  if (waiting >= MAX_QUEUE) return Promise.resolve(null);
  waiting++;
  const job = queue.then(() => read(buf, mime)).catch(() => null).finally(() => { waiting--; });
  queue = job;
  return job;
}

async function read(buf: Buffer, mime: string): Promise<Seen | null> {
  const t = await ocrTools();
  const isPdf = mime === 'application/pdf';
  if (!t.ocr || (isPdf && !t.pdf) || buf.length > MAX_BYTES) return null;
  if (!isPdf && !/^image\/(png|jpeg|webp)$/.test(mime)) return null;
  if (!isPdf && (imagePixels(buf) ?? 0) > MAX_PIXELS) return null;
  const dir = await mkdtemp(path.join(tmpdir(), 'np-ocr-'));
  try {
    const src = path.join(dir, isPdf ? 'doc.pdf' : `img.${mime.split('/')[1]}`);
    await writeFile(src, buf, { mode: 0o600 });
    let images = [src];
    if (isPdf) {
      await run('pdftoppm', ['-r', String(DPI), '-scale-to', String(MAX_SIDE), '-f', '1', '-l', String(PAGES), '-gray', '-png', src, path.join(dir, 'p')]);
      images = (await readdir(dir)).filter((n) => /^p.*\.png$/.test(n)).sort().map((n) => path.join(dir, n));
      if (!images.length) return null; // protegido por senha, corrompido…
    }
    let text = '', barcode: string | null = null, pix: string | null = null;
    for (const img of images) {
      if (t.zbar && !(barcode && pix)) {
        // só os dois tipos que interessam: o código do boleto (Intercalado 2 de 5) e o QR Code
        const codes = (await run('zbarimg', ['-q', '-Sdisable', '-Si25.enable', '-Sqrcode.enable', img]))?.split('\n') ?? [];
        barcode ??= codes.map((c) => /^I2\/5:(\d{44})$/.exec(c.trim())?.[1]).find(Boolean) ?? null;
        pix ??= codes.map((c) => /^QR-Code:(000201.{20,600})$/.exec(c.trim())?.[1]).find(Boolean) ?? null;
      }
      text += `${(await run('tesseract', [img, 'stdout', '-l', 'por', '--psm', '6'])) ?? ''}\n`;
    }
    return text.trim() || barcode || pix ? { text, barcode, pix } : null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
