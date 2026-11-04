/**
 * Classificador de documentos (porta do sistema anterior + extras):
 * boleto / nota fiscal / comprovante, com extração de linha digitável, valor, vencimento e PIX copia-e-cola.
 */
import { findBoletoInText, parseBoleto, parsePix, parseMoneyInput, type AttachmentSlot } from '@nopaper/shared';
import { pdfToText } from './pdf.js';

export type Kind = AttachmentSlot | 'unknown';
export interface Classification {
  kind: Kind;
  confidence: 'high' | 'medium' | 'low';
  reasons: string[];
  barcode: string | null;
  amount: string | null;
  dueDate: string | null;
  pixCode: string | null;
  pixKey: string | null;
  beneficiary: string | null;
  invoiceKey: string | null;
  textLength: number;
}

const STRONG_PROOF = [
  'autenticação eletrônica', 'autenticacao eletronica', 'autenticação do comprovante', 'autenticacao do comprovante',
  'comprovante de pagamento', 'comprovante pix', 'pix recebido', 'pix enviado', 'pagamento pix', 'id da transação',
  'id da transacao', 'id transação', 'id transacao', 'internet banking sicredi', 'comprovante de pagamento - simples nacional',
  'comprovante de pagamento de darf', 'ted outra titularidade', 'ted mesma titularidade', 'valor pago (r$)', 'data do pagamento:',
  'data da transação:', 'data da transacao:', 'contas de consumo', 'via sispag', 'via internet banking', 'tipo de transferência',
  'tipo de transferencia', 'comprovante de transferência', 'comprovante de transferencia',
];
const STRONG_INVOICE = [
  'danfe', 'nota fiscal eletrônica', 'nota fiscal eletronica', 'nota fiscal de serviços eletrônica', 'nota fiscal de servicos eletronica',
  'nfcom', 'nfs-e', 'nfse', 'nf-e nº', 'nfe nº', 'nf-e n', 'chave de acesso',
  'documento auxiliar da nota fiscal fatura de serviços de comunicação eletrônica',
  'documento auxiliar da nota fiscal fatura de servicos de comunicacao eletronica',
];
const STRONG_BOLETO = [
  'autenticação mecânica', 'autenticacao mecanica', 'documento de arrecadação', 'documento de arrecadacao', 'guia de recolhimento',
  'documento de arrecadação do simples nacional', 'documento de arrecadacao do simples nacional',
  'documento de arrecadação de receitas federais', 'documento de arrecadacao de receitas federais',
  'guia da previdência social', 'guia da previdencia social', 'guia do fgts digital',
];
const WEAK_BOLETO = ['linha digitável', 'linha digitavel', 'pagável em qualquer banco', 'pagavel em qualquer banco', 'ficha de compensação', 'ficha de compensacao', 'nosso número', 'nosso numero', 'boleto'];
const WEAK_INVOICE = ['danfe', 'nota fiscal eletrônica', 'nota fiscal eletronica', 'nfcom', 'danfse', 'nfs-e', 'nfse', 'nota fiscal de serviços', 'nota fiscal de servicos', 'chave de acesso', 'modelo 55', 'modelo 62', 'modelo 65'];
const WEAK_PROOF = ['comprovante', 'transferência', 'transferencia', 'pix recebido', 'pix enviado', 'comprovante pix', 'ted ', 'doc ', 'recibo de pagamento', 'pagamento efetuado', 'pagamento realizado', 'id da transação', 'id da transacao'];

const hits = (text: string, list: string[]) => list.filter((k) => text.includes(k)).slice(0, 3);

function byFilename(name: string): { kind: Kind; reasons: string[] } {
  const n = ` ${name.toLowerCase()} `;
  if (/comprovante|recibo|pgto|pago|\bpix\b|\bted\b/.test(n)) return { kind: 'payment_proof', reasons: ['nome do arquivo'] };
  if (/nfcom|nfse|nfe|danfe| nf |nota/.test(n)) return { kind: 'invoice', reasons: ['nome do arquivo'] };
  if (/boleto|fatura|darf|das |ipva|fgts|guia/.test(n)) return { kind: 'boleto', reasons: ['nome do arquivo'] };
  return { kind: 'unknown', reasons: ['nenhum padrão reconhecido'] };
}

function extractExtras(text: string) {
  const pixMatch = text.replace(/\s+/g, '').match(/000201[0-9A-Za-z.@:/\-_*+ ]{20,}?6304[0-9A-F]{4}/);
  let pixCode: string | null = null, pixKey: string | null = null, pixAmount: string | null = null;
  if (pixMatch) {
    const p = parsePix(pixMatch[0]);
    if (p.crcValid) { pixCode = pixMatch[0]; pixKey = p.key; pixAmount = p.amount; }
  }
  const nfKey = text.replace(/[ .]/g, '').match(/(?<!\d)(\d{2}\d{4}\d{14}(?:55|57|62|65|66)\d{3}\d{9}\d{10})(?!\d)/);
  let amount: string | null = null;
  const valueRe = /(valor\s+(?:total\s+)?(?:do\s+documento|da\s+nota|a\s+pagar|cobrado|total|pago)[^\d\n]{0,40})(\d{1,3}(?:\.\d{3})*,\d{2})/i;
  const vm = text.match(valueRe);
  if (vm) amount = parseMoneyInput(vm[2]);
  let dueDate: string | null = null;
  const dm = text.match(/vencimento[^\d\n]{0,30}(\d{2})\/(\d{2})\/(\d{4})/i);
  if (dm) dueDate = `${dm[3]}-${dm[2]}-${dm[1]}`;
  const bm = text.match(/(?:benefici[aá]rio|cedente|raz[aã]o social)\s*[:\-]?\s*\n?\s*([A-ZÀ-Ü0-9][^\n]{3,80})/i);
  return { pixCode, pixKey, pixAmount, invoiceKey: nfKey?.[1] ?? null, amount, dueDate, beneficiary: bm?.[1]?.trim() ?? null };
}

export async function classifyDocument(buf: Buffer, mime: string, filename: string): Promise<Classification> {
  const base: Classification = {
    kind: 'unknown', confidence: 'low', reasons: [], barcode: null, amount: null, dueDate: null,
    pixCode: null, pixKey: null, beneficiary: null, invoiceKey: null, textLength: 0,
  };
  if (mime !== 'application/pdf') {
    const f = byFilename(filename);
    return { ...base, ...f };
  }
  let raw = '';
  try { raw = await pdfToText(buf); } catch (e) { console.warn('[classifier] falha ao ler PDF:', (e as Error).message); raw = ''; }
  const text = raw.toLowerCase();
  base.textLength = raw.length;
  if (raw.trim().length < 20) return { ...base, ...byFilename(filename), reasons: ['PDF sem texto (escaneado?)', 'nome do arquivo'] };

  const extras = extractExtras(raw);
  const withBoleto = (kind: Kind, confidence: Classification['confidence'], reasons: string[]) => {
    const line = findBoletoInText(raw);
    const info = line ? parseBoleto(line) : null;
    return {
      ...base, kind, confidence, reasons, barcode: line,
      amount: info?.amount ?? extras.pixAmount ?? extras.amount,
      dueDate: info?.dueDate ?? extras.dueDate,
      pixCode: extras.pixCode, pixKey: extras.pixKey, beneficiary: extras.beneficiary, invoiceKey: extras.invoiceKey,
    };
  };

  let h = hits(text, STRONG_PROOF);
  if (h.length) return { ...base, kind: 'payment_proof', confidence: 'high', reasons: h, amount: extras.amount };
  h = hits(text, STRONG_INVOICE);
  if (h.length) {
    return { ...base, kind: 'invoice', confidence: h.some((x) => x === 'danfe' || x === 'nfcom') ? 'high' : 'medium', reasons: h, amount: extras.amount, invoiceKey: extras.invoiceKey, beneficiary: extras.beneficiary, dueDate: extras.dueDate, barcode: findBoletoInText(raw) };
  }
  h = hits(text, STRONG_BOLETO);
  if (h.length) return withBoleto('boleto', 'high', h);
  if (findBoletoInText(raw)) return withBoleto('boleto', 'high', ['linha digitável válida']);
  if (extras.pixCode) return { ...withBoleto('boleto', 'high', ['PIX copia e cola válido']) };
  h = hits(text, WEAK_BOLETO);
  if (h.length) return withBoleto('boleto', 'low', h);
  h = hits(text, WEAK_INVOICE);
  if (h.length) return { ...base, kind: 'invoice', confidence: 'low', reasons: h, amount: extras.amount, invoiceKey: extras.invoiceKey };
  h = hits(text, WEAK_PROOF);
  if (h.length) return { ...base, kind: 'payment_proof', confidence: 'medium', reasons: h, amount: extras.amount };
  return { ...base, ...byFilename(filename) };
}
