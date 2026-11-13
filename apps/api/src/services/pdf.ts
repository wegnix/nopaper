import type { PdfCell } from '@nopaper/shared';

// pdfjs 6 usa Promise.withResolvers (Node 22+). O Docker já usa Node 22; isto cobre o dev em Node 20.
const P = Promise as unknown as { withResolvers?: () => unknown };
if (typeof P.withResolvers !== 'function') {
  P.withResolvers = () => {
    let resolve!: (v: unknown) => void, reject!: (e: unknown) => void;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  };
}

/** Extração de texto de PDF com pdfjs-dist (build legacy, roda em Node sem canvas). */
export async function pdfToText(buf: Buffer, maxPages = 10): Promise<string> {
  try { return await readText(buf, maxPages); } catch (e) {
    // Alguns emissores entregam o boleto como dois PDFs colados: o 1º aberto e, depois dele, uma
    // cópia protegida por senha. Os leitores olham o fim do arquivo e pedem a senha; a 1ª cópia abre.
    const end = buf.indexOf('%%EOF');
    if (end > 0 && end + 5 < buf.length - 16 && buf.indexOf('%PDF-', end) > 0) return await readText(buf.subarray(0, end + 5), maxPages);
    throw e;
  }
}
async function readText(buf: Buffer, maxPages: number): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({
    data: new Uint8Array(buf), useSystemFonts: false, disableFontFace: true, verbosity: 0,
  });
  const doc = await task.promise;
  const parts: string[] = [];
  try {
    for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      let line = '';
      for (const item of content.items as Array<{ str?: string; hasEOL?: boolean }>) {
        if (typeof item.str !== 'string') continue;
        line += item.str;
        if (item.hasEOL) { parts.push(line); line = ''; } else line += ' ';
      }
      if (line) parts.push(line);
    }
  } finally {
    await task.destroy();
  }
  return parts.join('\n').replace(/[ \t]+/g, ' ');
}

/**
 * Linhas do PDF como aparecem na página: textos agrupados pela altura e ordenados da esquerda para
 * a direita (respeita página girada), com a posição horizontal de cada texto. Serve para documentos
 * em colunas, em que a ordem interna do PDF não segue a leitura (relatório de vendas do Jasper,
 * holerites do contador — lá a coluna do valor diz se é vencimento ou desconto).
 */
/** Um PDF de holerites ou de vendas tem algumas centenas de textos por página; isto barra o arquivo montado para prender o servidor. */
const MAX_ITEMS_PER_PAGE = 8000;
const MAX_READ_MS = 15_000;

export async function pdfToPageCells(buf: Buffer, maxPages = 30): Promise<PdfCell[][][]> {
  const started = Date.now();
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const out: PdfCell[][][] = [];
  try {
    for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
      const page = await doc.getPage(p);
      const m = page.getViewport({ scale: 1 }).transform;
      const content = await page.getTextContent();
      if (content.items.length > MAX_ITEMS_PER_PAGE || Date.now() - started > MAX_READ_MS) throw new Error('PDF grande ou complexo demais para ler');
      const rows: Array<{ y: number; items: PdfCell[] }> = [];
      for (const it of content.items as Array<{ str?: string; transform?: number[]; width?: number }>) {
        const s = it.str?.trim();
        if (!s || !it.transform) continue;
        const [x0, y0] = [it.transform[4], it.transform[5]];
        const x = m[0] * x0 + m[2] * y0 + m[4], y = m[1] * x0 + m[3] * y0 + m[5];
        let row = rows.find((r) => Math.abs(r.y - y) <= 2);
        if (!row) rows.push((row = { y, items: [] }));
        row.items.push({ x, w: it.width ?? 0, s });
      }
      rows.sort((a, b) => a.y - b.y);
      out.push(rows.map((r) => r.items.sort((a, b) => a.x - b.x)));
    }
  } finally {
    await task.destroy();
  }
  return out;
}

/** As linhas de todas as páginas, em sequência. */
export async function pdfToCells(buf: Buffer, maxPages = 30): Promise<PdfCell[][]> {
  return (await pdfToPageCells(buf, maxPages)).flat();
}

/** O mesmo, só com os textos. */
export async function pdfToRows(buf: Buffer, maxPages = 30): Promise<string[][]> {
  return (await pdfToCells(buf, maxPages)).map((r) => r.map((c) => c.s));
}
