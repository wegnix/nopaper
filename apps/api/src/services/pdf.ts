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
 * a direita (respeita página girada). Serve para relatórios em tabela, em que a ordem interna do
 * PDF não segue as colunas (ex.: relatório de vendas do sistema da loja, gerado pelo Jasper).
 */
export async function pdfToRows(buf: Buffer, maxPages = 30): Promise<string[][]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const out: string[][] = [];
  try {
    for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
      const page = await doc.getPage(p);
      const m = page.getViewport({ scale: 1 }).transform;
      const content = await page.getTextContent();
      const rows: Array<{ y: number; items: Array<{ x: number; s: string }> }> = [];
      for (const it of content.items as Array<{ str?: string; transform?: number[] }>) {
        const s = it.str?.trim();
        if (!s || !it.transform) continue;
        const [x0, y0] = [it.transform[4], it.transform[5]];
        const x = m[0] * x0 + m[2] * y0 + m[4], y = m[1] * x0 + m[3] * y0 + m[5];
        let row = rows.find((r) => Math.abs(r.y - y) <= 2);
        if (!row) rows.push((row = { y, items: [] }));
        row.items.push({ x, s });
      }
      rows.sort((a, b) => a.y - b.y);
      for (const r of rows) out.push(r.items.sort((a, b) => a.x - b.x).map((i) => i.s));
    }
  } finally {
    await task.destroy();
  }
  return out;
}
