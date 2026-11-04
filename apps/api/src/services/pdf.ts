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
