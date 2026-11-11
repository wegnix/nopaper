import { PDFDocument, StandardFonts, degrees, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';
import { ESIGN_TERM_DECLARATION, ESIGN_TERM_TITLE, esignDeclaration, esignTermText, formatBRL, parsePayslips, refLabelPT, type EsignKind, type EsignTermParties, type Payslip } from '@nopaper/shared';
import { pdfToPageCells } from './pdf.js';

/**
 * Separa o PDF do contador em um PDF por funcionário (as páginas em que a matrícula aparece).
 * Lê página por página com o mesmo leitor da importação de holerites.
 */
export async function splitPayslips(buf: Buffer): Promise<{ ref: string | null; company: string | null; slips: Array<{ slip: Payslip; pdf: Buffer }> }> {
  const pages = await pdfToPageCells(buf, 200);
  const found = new Map<string, { slip: Payslip; pages: number[] }>();
  let ref: string | null = null, company: string | null = null;
  pages.forEach((rows, i) => {
    const r = parsePayslips(rows);
    ref ??= r.ref;
    company ??= r.company;
    for (const s of r.slips) {
      if (!s.code) continue;
      const hit = found.get(s.code);
      if (hit) { if (!hit.pages.includes(i)) hit.pages.push(i); } else found.set(s.code, { slip: s, pages: [i] });
    }
  });
  if (!found.size) return { ref, company, slips: [] };
  const src = await PDFDocument.load(buf, { ignoreEncryption: true });
  const slips: Array<{ slip: Payslip; pdf: Buffer }> = [];
  for (const f of found.values()) {
    const doc = await PDFDocument.create();
    for (const p of await doc.copyPages(src, f.pages)) doc.addPage(p);
    slips.push({ slip: f.slip, pdf: Buffer.from(await doc.save()) });
  }
  return { ref, company, slips };
}

/** As fontes padrão do PDF só têm Latin-1: troca o que não existe para não quebrar a geração. */
const latin = (s: string) => s.replace(/[–—]/g, '-').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/…/g, '...').replace(/[^\x20-\x7E -ÿ]/g, '?');

function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const out: string[] = [];
  let line = '';
  // palavra maior que a linha (hash, endereço): quebra em pedaços
  const words = latin(text).split(/\s+/).flatMap((w) => {
    const parts: string[] = [];
    let cur = '';
    for (const ch of w) { if (cur && font.widthOfTextAtSize(cur + ch, size) > width) { parts.push(cur); cur = ch; } else cur += ch; }
    parts.push(cur);
    return parts;
  });
  for (const word of words) {
    const tryLine = line ? `${line} ${word}` : word;
    if (font.widthOfTextAtSize(tryLine, size) <= width || !line) line = tryLine;
    else { out.push(line); line = word; }
  }
  if (line) out.push(line);
  return out;
}

const INK = rgb(0.08, 0.1, 0.16), MUTED = rgb(0.36, 0.39, 0.47), LINE = rgb(0.82, 0.84, 0.9), ACCENT = rgb(0.36, 0.29, 0.91);
const A4: [number, number] = [595.28, 841.89];
const M = 56, W = A4[0] - 2 * M;

// ------------------------------------------------------------------ campos "Assinatura" e "Data" do holerite
/** Onde desenhar a assinatura e a data dentro do próprio holerite (coordenadas do PDF, origem embaixo). */
interface SignField {
  page: number;
  /** Texto na vertical (canhoto lateral do "Recibo de Pagamento"): lê-se de baixo para cima. */
  vertical: boolean;
  /** Assinatura: a linha de base (x da linha no vertical, y no horizontal), o centro e o tamanho máximo. */
  sign: { base: number; center: number; length: number; height: number };
  /** Data: onde começa a linha de base e o centro; `cover` = retângulo branco por baixo (tampa o "__/__/__"). */
  date: { base: number; center: number; cover?: { x: number; y: number; w: number; h: number } } | null;
}

type Mx = [number, number, number, number, number, number];
const mul = (m: Mx, n: Mx): Mx => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];

/**
 * Acha os campos de assinatura e data nos dois formatos conhecidos:
 *  - "Demonstrativo" (texto na horizontal): "Assinatura:____" e "Recebi em: __/__/__";
 *  - "Recibo de Pagamento" (canhoto à direita com os rótulos como imagens estreitas na vertical):
 *    por via, a imagem mais alta é a declaração; das outras, as duas mais à direita são os rótulos
 *    (ASSINATURA = a maior, DATA = a menor) e a que sobra são as barras da data.
 * Formato desconhecido → lista vazia (o holerite fica só com o comprovante no fim).
 */
export async function findSignFields(buf: Buffer): Promise<SignField[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, disableFontFace: true, verbosity: 0 });
  const doc = await task.promise;
  const out: SignField[] = [];
  try {
    for (let p = 1; p <= Math.min(doc.numPages, 20); p++) {
      const page = await doc.getPage(p);
      if (page.rotate) continue;
      // 1) rótulos em texto, na horizontal
      const content = await page.getTextContent();
      const texts = (content.items as Array<{ str?: string; transform?: number[]; width?: number }>)
        .filter((i) => i.str && i.transform && Math.abs(i.transform[1]!) < 0.01)
        .map((i) => ({ s: i.str!.trim(), x: i.transform![4]!, y: i.transform![5]!, w: i.width ?? 0 }));
      const signs = texts.filter((t) => /^assinatura\s*:?\s*_{6,}/i.test(t.s));
      for (const t of signs) {
        const d = texts.find((x) => Math.abs(x.y - t.y) < 3 && /_{2,}\s*\/\s*_{2,}\s*\/\s*_{2,}/.test(x.s));
        const x0 = t.x + t.w * 0.3;
        out.push({
          page: p - 1, vertical: false,
          sign: { base: t.y + 0.5, center: (x0 + t.x + t.w) / 2, length: t.x + t.w - x0, height: 22 },
          date: d ? { base: t.y + 0.8, center: d.x + d.w * 0.7, cover: { x: d.x + d.w * 0.4, y: d.y - 2, w: d.w * 0.62, h: 10 } } : null,
        });
      }
      if (signs.length) continue;
      // 2) canhoto lateral: imagens estreitas e altas
      const ops = await page.getOperatorList();
      const stack: Mx[] = [];
      let ctm: Mx = [1, 0, 0, 1, 0, 0];
      const imgs: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
      ops.fnArray.forEach((fn, i) => {
        if (fn === pdfjs.OPS.save) stack.push(ctm);
        else if (fn === pdfjs.OPS.restore) ctm = stack.pop() ?? ctm;
        else if (fn === pdfjs.OPS.transform) ctm = mul(ctm, ops.argsArray[i] as Mx);
        else if (fn === pdfjs.OPS.paintImageXObject) {
          const xs = [ctm[4], ctm[0] + ctm[4], ctm[2] + ctm[4], ctm[0] + ctm[2] + ctm[4]], ys = [ctm[5], ctm[1] + ctm[5], ctm[3] + ctm[5], ctm[1] + ctm[3] + ctm[5]];
          imgs.push({ x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) });
        }
      });
      const narrow = imgs.filter((m) => m.x1 - m.x0 < 16 && m.y1 - m.y0 > 14);
      const tall = narrow.filter((m) => m.y1 - m.y0 > 180);
      for (const decl of tall) {
        const rest = narrow.filter((m) => m !== decl && (m.y0 + m.y1) / 2 > decl.y0 && (m.y0 + m.y1) / 2 < decl.y1 && m.x0 > decl.x1);
        if (rest.length < 2) continue;
        const right = Math.max(...rest.map((m) => m.x0));
        const labels = rest.filter((m) => right - m.x0 < 5).sort((a, b) => (b.y1 - b.y0) - (a.y1 - a.y0));
        if (labels.length < 2) continue;
        const [signLabel, dateLabel] = [labels[0]!, labels[1]!];
        const slashes = rest.find((m) => !labels.includes(m));
        const lineX = Math.min(signLabel.x0, dateLabel.x0) - 1.5;
        const room = lineX - decl.x1 - 3;
        if (room < 10) continue;
        // a assinatura não pode invadir a área da data
        const dateEdge = slashes ? (slashes.y0 + slashes.y1) / 2 : (dateLabel.y0 + dateLabel.y1) / 2;
        const center = (signLabel.y0 + signLabel.y1) / 2;
        const half = Math.min(100, Math.abs(center - dateEdge) - 45, center - decl.y0 - 4, decl.y1 - center - 4);
        if (half < 30) continue;
        out.push({
          page: p - 1, vertical: true,
          sign: { base: lineX - 1, center, length: half * 2, height: Math.min(26, room) },
          date: slashes ? { base: slashes.x0 - 1.5, center: (slashes.y0 + slashes.y1) / 2 } : null,
        });
      }
    }
  } finally {
    await task.destroy();
  }
  return out;
}

function stampFields(doc: PDFDocument, fields: SignField[], img: PDFImage, font: PDFFont, dateText: string) {
  const pages = doc.getPages();
  for (const f of fields) {
    const page = pages[f.page];
    if (!page) continue;
    const k = Math.min(f.sign.length / img.width, f.sign.height / img.height);
    const w = img.width * k, h = img.height * k;
    const size = 7.5, tw = font.widthOfTextAtSize(dateText, size);
    if (f.vertical) {
      // girado 90°: a largura da imagem sobe a página e o "alto" dela aponta para a esquerda
      page.drawImage(img, { x: f.sign.base, y: f.sign.center - w / 2, width: w, height: h, rotate: degrees(90) });
      if (f.date) page.drawText(dateText, { x: f.date.base, y: f.date.center - tw / 2, size, font, color: INK, rotate: degrees(90) });
    } else {
      page.drawImage(img, { x: f.sign.center - w / 2, y: f.sign.base, width: w, height: h });
      if (f.date) {
        if (f.date.cover) page.drawRectangle({ x: f.date.cover.x, y: f.date.cover.y, width: f.date.cover.w, height: f.date.cover.h, color: rgb(1, 1, 1) });
        page.drawText(dateText, { x: f.date.center - tw / 2, y: f.date.base, size, font, color: INK });
      }
    }
  }
}

// ------------------------------------------------------------------ termo de aceite (PDF a assinar)
/** Posição da assinatura e da data na página do termo (o layout é nosso). */
const TERM_SIGN = { x: M, y: 250, w: 260, h: 60 };

/** PDF do termo de aceite, com as partes identificadas e o lugar da assinatura. */
export async function buildTermPdf(p: EsignTermParties): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage(A4);
  let y = A4[1] - 64;
  page.drawRectangle({ x: M, y: y - 4, width: 28, height: 4, color: ACCENT });
  y -= 30;
  for (const l of wrap(ESIGN_TERM_TITLE, bold, 17, W)) { page.drawText(l, { x: M, y, size: 17, font: bold, color: INK }); y -= 23; }
  y -= 10;
  const row = (label: string, value: string) => {
    page.drawText(latin(label), { x: M, y, size: 9, font, color: MUTED });
    for (const l of wrap(value, font, 10.5, W - 110)) { page.drawText(l, { x: M + 110, y, size: 10.5, font, color: INK }); y -= 14; }
    y -= 3;
  };
  row('Empresa', p.companyDocument ? `${p.company} - CNPJ ${p.companyDocument}` : p.company);
  row('Funcionário', `${p.employeeName} - CPF ${p.employeeDocument}`);
  y -= 8;
  page.drawLine({ start: { x: M, y }, end: { x: M + W, y }, thickness: 0.7, color: LINE });
  y -= 26;
  for (const par of esignTermText(p)) {
    for (const l of wrap(par, font, 11.5, W)) { page.drawText(l, { x: M, y, size: 11.5, font, color: INK }); y -= 17; }
    y -= 9;
  }
  // assinatura e data
  page.drawLine({ start: { x: TERM_SIGN.x, y: TERM_SIGN.y }, end: { x: TERM_SIGN.x + TERM_SIGN.w, y: TERM_SIGN.y }, thickness: 0.8, color: INK });
  page.drawText(latin(p.employeeName), { x: TERM_SIGN.x, y: TERM_SIGN.y - 13, size: 9.5, font: bold, color: INK });
  page.drawText('Assinatura do funcionário', { x: TERM_SIGN.x, y: TERM_SIGN.y - 25, size: 8.5, font, color: MUTED });
  page.drawLine({ start: { x: M + W - 130, y: TERM_SIGN.y }, end: { x: M + W, y: TERM_SIGN.y }, thickness: 0.8, color: INK });
  page.drawText('Data', { x: M + W - 130, y: TERM_SIGN.y - 13, size: 8.5, font, color: MUTED });
  doc.setTitle(latin(`${ESIGN_TERM_TITLE} - ${p.employeeName}`));
  doc.setProducer('NoPaper');
  return Buffer.from(await doc.save());
}

// ------------------------------------------------------------------ documento assinado
export interface SignedPdfInput {
  kind: EsignKind;
  original: Buffer;
  originalSha256: string;
  id: string;
  company: string;
  companyDocument: string | null;
  employeeName: string;
  employeeDocument: string;
  competence: string;
  net: string;
  signaturePng: Buffer;
  signedAt: Date;
  timezone: string;
  ip: string | null;
  userAgent: string | null;
  /** Holerite: quando o termo de aceite foi assinado. */
  termAcceptedAt: Date | null;
  termVersion: string;
}

/**
 * O documento original com a assinatura e a data nos próprios campos (quando o formato é
 * conhecido) + uma página de comprovante (quem assinou, quando, de onde, e a assinatura desenhada).
 */
export async function buildSignedPdf(i: SignedPdfInput): Promise<Buffer> {
  const doc = await PDFDocument.load(i.original);
  const font = await doc.embedFont(StandardFonts.Helvetica), bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const img = await doc.embedPng(i.signaturePng);
  const when = (d: Date) => new Intl.DateTimeFormat('pt-BR', { timeZone: i.timezone, dateStyle: 'short', timeStyle: 'medium' }).format(d);
  const day = new Intl.DateTimeFormat('pt-BR', { timeZone: i.timezone, dateStyle: 'short' }).format(i.signedAt);
  const code = i.id.replace(/-/g, '').slice(0, 12).toUpperCase();
  const term = i.kind === 'term';

  // assinatura e data dentro do próprio documento
  let stamped = false;
  if (term) {
    stampFields(doc, [{ page: 0, vertical: false, sign: { base: TERM_SIGN.y + 2, center: TERM_SIGN.x + TERM_SIGN.w / 2, length: TERM_SIGN.w - 20, height: TERM_SIGN.h }, date: null }], img, font, day);
    doc.getPages()[0]!.drawText(day, { x: M + W - 130, y: TERM_SIGN.y + 5, size: 11, font, color: INK });
  } else {
    let fields: SignField[] = [];
    try { fields = await findSignFields(i.original); } catch { /* formato desconhecido: só o comprovante */ }
    stampFields(doc, fields, img, font, day);
    stamped = fields.length > 0;
  }
  // selo discreto no rodapé — só se a assinatura não entrou no próprio documento (em holerite de
  // duas vias o rodapé da página é a última linha da 2ª via)
  for (const page of doc.getPages()) {
    if (stamped || page.getRotation().angle !== 0) continue;
    page.drawText(latin(`Assinado eletronicamente por ${i.employeeName} em ${when(i.signedAt)} - comprovante na última página - código ${code}`), { x: 24, y: 9, size: 6.5, font, color: MUTED });
  }

  const page: PDFPage = doc.addPage(A4);
  let y = A4[1] - 64;
  const text = (s: string, o: { size?: number; f?: PDFFont; color?: ReturnType<typeof rgb>; gap?: number } = {}) => {
    const size = o.size ?? 10.5;
    for (const l of wrap(s, o.f ?? font, size, W)) { page.drawText(l, { x: M, y, size, font: o.f ?? font, color: o.color ?? INK }); y -= size * 1.45; }
    y -= o.gap ?? 0;
  };
  const row = (label: string, value: string) => {
    page.drawText(latin(label), { x: M, y, size: 9, font, color: MUTED });
    const lines = wrap(value, font, 10.5, W - 150);
    lines.forEach((l, k) => page.drawText(l, { x: M + 150, y: y - k * 14, size: 10.5, font, color: INK }));
    y -= Math.max(1, lines.length) * 14 + 4;
  };
  const rule = () => { page.drawLine({ start: { x: M, y }, end: { x: M + W, y }, thickness: 0.7, color: LINE }); y -= 18; };

  page.drawRectangle({ x: M, y: y - 4, width: 28, height: 4, color: ACCENT });
  y -= 26;
  text('Comprovante de assinatura eletrônica', { size: 19, f: bold, gap: 2 });
  text(term ? ESIGN_TERM_TITLE : `Recibo de pagamento de salário - ${refLabelPT(i.competence)}`, { size: 11, color: MUTED, gap: 14 });
  rule();
  row('Empresa', i.companyDocument ? `${i.company} - CNPJ ${i.companyDocument}` : i.company);
  row('Funcionário', i.employeeName);
  row('CPF', i.employeeDocument);
  if (!term) { row('Competência', refLabelPT(i.competence)); row('Valor líquido', formatBRL(i.net)); }
  y -= 6; rule();
  text(term ? ESIGN_TERM_DECLARATION : esignDeclaration(refLabelPT(i.competence), formatBRL(i.net)), { size: 11, gap: 14 });

  // assinatura desenhada
  const boxW = 280, boxH = 110;
  const k = Math.min((boxW - 24) / img.width, (boxH - 24) / img.height);
  page.drawRectangle({ x: M, y: y - boxH, width: boxW, height: boxH, borderColor: LINE, borderWidth: 0.8, color: rgb(1, 1, 1) });
  page.drawImage(img, { x: M + (boxW - img.width * k) / 2, y: y - boxH + (boxH - img.height * k) / 2, width: img.width * k, height: img.height * k });
  y -= boxH + 14;
  text(i.employeeName, { size: 10.5, f: bold });
  text(`Assinado em ${when(i.signedAt)} (${i.timezone})`, { size: 9.5, color: MUTED, gap: 14 });
  rule();
  text('Evidências da assinatura', { size: 11, f: bold, gap: 4 });
  row('Identificação', 'Link pessoal + CPF conferido com o cadastro');
  row('Data e hora', `${when(i.signedAt)} (${i.timezone})`);
  row('Endereço IP', i.ip ?? 'não registrado');
  row('Aparelho', (i.userAgent ?? 'não registrado').slice(0, 200));
  if (!term && i.termAcceptedAt) row('Termo de aceite', `versão ${i.termVersion}, assinado em ${when(i.termAcceptedAt)}`);
  if (term) row('Versão do termo', i.termVersion);
  row('Documento (SHA-256)', i.originalSha256);
  row('Código', code);
  y -= 8; rule();
  text(`Assinatura eletrônica feita no NoPaper, aceita pelas partes como válida nos termos do art. 10, § 2º, da Medida Provisória nº 2.200-2/2001.${term ? '' : ' O recibo de salário atende ao art. 464 da CLT.'} O SHA-256 acima identifica o arquivo que foi apresentado ao funcionário antes da assinatura.`, { size: 8.5, color: MUTED });

  doc.setTitle(latin(term ? `${ESIGN_TERM_TITLE} (assinado) - ${i.employeeName}` : `Holerite assinado - ${i.employeeName} - ${refLabelPT(i.competence)}`));
  doc.setProducer('NoPaper');
  return Buffer.from(await doc.save());
}
