import { z } from 'zod';
import { money, isoDate } from './schemas.js';
import { fromCents, toCents } from './money.js';

/**
 * Extrato bancário (OFX) e conciliação com as contas a pagar/receber.
 *
 * O servidor só decodifica o arquivo (`decodeOfx`: CHARSET 1252 ou UTF-8) e lê com `parseOfx`; a
 * sugestão de pares lançamento ↔ conta (`suggestMatches`) é a mesma na tela e na API.
 *
 * OFX 1.x (SGML, tags sem fechamento) e 2.x (XML) são lidos do mesmo jeito: `<TAG>valor`.
 * Datas: `AAAAMMDD[HHMMSS[.XXX]][fuso]` (padrão) ou ISO 8601 (`2026-10-30T00:00:00Z`, opção de alguns
 * bancos): vale sempre a data escrita, sem converter fuso — meia-noite UTC não pode virar o dia anterior.
 */

// ------------------------------------------------------------------ leitura do OFX
export interface OfxTransaction {
  /** Identificador do lançamento no banco (evita importar duas vezes). */
  fitId: string;
  date: string;
  /** Valor com sinal: negativo = saída (débito). */
  amount: string;
  type: string;
  memo: string | null;
  name: string | null;
  refNum: string | null;
  checkNum: string | null;
}
export interface OfxStatement {
  bankId: string | null;
  branchId: string | null;
  accountId: string | null;
  accountType: string | null;
  /** creditcard = extrato de cartão (CCSTMTRS). */
  kind: 'bank' | 'creditcard';
  currency: string | null;
  from: string | null;
  to: string | null;
  balance: string | null;
  balanceDate: string | null;
  transactions: OfxTransaction[];
}
export interface OfxFile { org: string | null; fid: string | null; statements: OfxStatement[]; warnings: string[] }

/** Bytes do arquivo → texto, pelo cabeçalho (CHARSET:1252 / ENCODING:UTF-8 / <?xml encoding>). */
export function decodeOfx(bytes: Uint8Array): string {
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 600));
  const utf8 = /ENCODING:\s*UTF-?8/i.test(head) || /encoding="utf-?8"/i.test(head) || /CHARSET:\s*(UTF-?8|65001)/i.test(head);
  return new TextDecoder(utf8 ? 'utf-8' : 'windows-1252').decode(bytes);
}

/** Nenhum campo de OFX passa disso; o limite impede que um arquivo montado de propósito prenda o servidor. */
const MAX_FIELD = 600;
/** Lançamentos por arquivo (um extrato de um ano de uma empresa fica bem abaixo). */
export const OFX_MAX_TRANSACTIONS = 20_000;
const tagValue = (block: string, tag: string): string | null => {
  const m = new RegExp(`<${tag}>([^<\\r\\n]{0,${MAX_FIELD}})`, 'i').exec(block);
  const v = m?.[1]?.trim();
  return v ? decodeEntities(v) : null;
};
const decodeEntities = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'");
const blocks = (text: string, tag: string): string[] => {
  const out: string[] = [];
  const re = new RegExp(`<${tag}>([\\s\\S]*?)(?=<\\/${tag}>|<${tag}>|$)`, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push(m[1]);
  return out;
};

/** "20261030120000[-3:BRT]" | "2026-10-30T00:00:00Z" | "20261030" → "2026-10-30". */
export function ofxDate(v: string | null): string | null {
  if (!v) return null;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(v);
  const d = iso ? iso.slice(1) : /^(\d{4})(\d{2})(\d{2})/.exec(v)?.slice(1);
  if (!d) return null;
  const [y, mo, da] = d.map(Number);
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  return `${d[0]}-${d[1]}-${d[2]}`;
}
/** "-90.00" | "1.234,56" | "-1234,5" → "-1234.50". */
export function ofxAmount(v: string | null): string | null {
  if (!v) return null;
  let s = v.replace(/\s/g, '');
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? fromCents(Math.round(n * 100)) : null;
}

export function parseOfx(text: string): OfxFile {
  const out: OfxFile = { org: tagValue(text, 'ORG'), fid: tagValue(text, 'FID'), statements: [], warnings: [] };
  if (!/<OFX>/i.test(text)) { out.warnings.push('O arquivo não parece um OFX (falta a marca <OFX>).'); return out; }
  const stmts = [
    ...blocks(text, 'STMTRS').map((b) => ({ b, kind: 'bank' as const })),
    ...blocks(text, 'CCSTMTRS').map((b) => ({ b, kind: 'creditcard' as const })),
  ];
  for (const { b, kind } of stmts) {
    const acct = blocks(b, kind === 'bank' ? 'BANKACCTFROM' : 'CCACCTFROM')[0] ?? '';
    const list = blocks(b, 'BANKTRANLIST')[0] ?? b;
    const ledger = blocks(b, 'LEDGERBAL')[0] ?? '';
    const txs: OfxTransaction[] = [];
    const seen = new Map<string, number>();
    for (const t of blocks(list, 'STMTTRN')) {
      const date = ofxDate(tagValue(t, 'DTPOSTED'));
      const amount = ofxAmount(tagValue(t, 'TRNAMT'));
      if (!date || amount === null) { out.warnings.push('Um lançamento sem data ou valor foi ignorado.'); continue; }
      const memo = tagValue(t, 'MEMO'), name = tagValue(t, 'NAME');
      // sem FITID: identificador estável pelos dados do lançamento (o n-ésimo igual no mesmo dia)
      let fitId = tagValue(t, 'FITID') ?? `${date}|${amount}|${memo ?? ''}|${name ?? ''}`;
      const n = seen.get(fitId) ?? 0;
      seen.set(fitId, n + 1);
      if (n) fitId = `${fitId}#${n + 1}`;
      txs.push({ fitId: fitId.slice(0, 120), date, amount, type: (tagValue(t, 'TRNTYPE') ?? (amount.startsWith('-') ? 'DEBIT' : 'CREDIT')).toUpperCase().slice(0, 16), memo, name, refNum: tagValue(t, 'REFNUM'), checkNum: tagValue(t, 'CHECKNUM') });
    }
    const dates = txs.map((t) => t.date).sort();
    out.statements.push({
      bankId: normBank(tagValue(acct, 'BANKID') ?? out.fid), branchId: tagValue(acct, 'BRANCHID'), accountId: tagValue(acct, 'ACCTID'),
      accountType: tagValue(acct, 'ACCTTYPE'), kind, currency: tagValue(b, 'CURDEF'),
      from: ofxDate(tagValue(list, 'DTSTART')) ?? dates[0] ?? null, to: ofxDate(tagValue(list, 'DTEND')) ?? dates.at(-1) ?? null,
      balance: ofxAmount(tagValue(ledger, 'BALAMT')), balanceDate: ofxDate(tagValue(ledger, 'DTASOF')),
      transactions: txs,
    });
  }
  if (!out.statements.length) out.warnings.push('Não achei nenhum extrato (STMTRS) no arquivo.');
  return out;
}

/** Código do banco com 3 dígitos ("0756" → "756", "1" → "001"). */
export function normBank(v: string | null | undefined): string | null {
  const d = (v ?? '').replace(/\D/g, '');
  if (!d) return v?.trim() || null;
  return d.replace(/^0+(?=\d{3})/, '').padStart(3, '0');
}
export const BANK_NAMES: Record<string, string> = {
  '001': 'Banco do Brasil', '033': 'Santander', '041': 'Banrisul', '070': 'BRB', '077': 'Inter', '085': 'Ailos', '104': 'Caixa',
  '197': 'Stone', '208': 'BTG Pactual', '212': 'Banco Original', '237': 'Bradesco', '260': 'Nubank', '290': 'PagBank', '323': 'Mercado Pago',
  '336': 'C6 Bank', '341': 'Itaú', '380': 'PicPay', '403': 'Cora', '422': 'Safra', '655': 'Votorantim', '748': 'Sicredi', '756': 'Sicoob',
};
export const bankName = (code: string | null | undefined) => (code ? BANK_NAMES[normBank(code) ?? ''] ?? `Banco ${code}` : 'Banco');
/** "Sicoob · ag. 4355-9 · cc 48287-0". */
export function accountLabel(a: { bankCode?: string | null; branch?: string | null; accountNumber?: string | null }) {
  return [bankName(a.bankCode), a.branch && `ag. ${a.branch}`, a.accountNumber && `cc ${a.accountNumber}`].filter(Boolean).join(' · ');
}
/**
 * Lê o que der de um texto livre de banco ("Bradesco Poupança: AG: 123 - C/P: 45678-9"): usado para
 * passar a anotação antiga do funcionário para os campos separados. Só sugere — a pessoa confere.
 */
export function parseBankText(text: string): { bankCode: string | null; branch: string | null; account: string | null; kind: 'checking' | 'savings' | null } {
  const plain = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const byName = Object.entries(BANK_NAMES)
    .map(([code, name]) => [code, name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()] as const)
    .sort((a, b) => b[1].length - a[1].length)
    .find(([, name]) => new RegExp(`(^|[^a-z])${name}([^a-z]|$)`).test(plain));
  const byCode = /\((\d{3})\)/.exec(plain) ?? /\bbanco\s*:?\s*(\d{3})\b/.exec(plain);
  const branch = /\bag(?:encia)?\b\.?\s*:?\s*(\d[\d.x-]*)/.exec(plain);
  const account = /(?:\bc\s*\/\s*[cp]|\bconta(?:\s+(?:corrente|poupanca))?|\bcc|\bcp)\b\.?\s*:?\s*(\d[\d.x-]*)/.exec(plain);
  const kind = /poupanca|\bc\s*\/\s*p\b|\bcp\b/.test(plain) ? 'savings' : /corrente|\bc\s*\/\s*c\b|\bcc\b/.test(plain) ? 'checking' : null;
  const clean = (v: string | undefined) => (v ? v.replace(/[.-]+$/, '').toUpperCase() : null);
  return { bankCode: byName?.[0] ?? (byCode ? normBank(byCode[1]) : null), branch: clean(branch?.[1]), account: clean(account?.[1]), kind };
}
/** Chave para reconhecer a conta do arquivo (só dígitos e letras, sem zeros à esquerda). */
export const accountKey = (bank: string | null | undefined, branch: string | null | undefined, account: string | null | undefined) =>
  [normBank(bank) ?? '', ...[branch, account].map((v) => (v ?? '').toUpperCase().replace(/[^0-9A-Z]/g, '').replace(/^0+/, ''))].join('|');

// ------------------------------------------------------------------ cadastro
/**
 * A conta do arquivo é a cadastrada? Mesmo banco e mesma conta; a agência pode estar com ou sem o
 * dígito (o OFX costuma trazer "1234-5" e o cadastro, editado à mão, só "1234") ou faltar de um lado.
 */
export function sameAccountKey(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const [ba, ga = '', ca = ''] = a.split('|'), [bb, gb = '', cb = ''] = b.split('|');
  if (ba !== bb || !ca || ca !== cb) return false;
  const [short, long] = ga.length <= gb.length ? [ga, gb] : [gb, ga];
  return !short || (long.length - short.length === 1 && long.startsWith(short));
}

export const BANK_ACCOUNT_KINDS = ['checking', 'savings', 'other'] as const;
export const BANK_ACCOUNT_KIND_LABEL: Record<(typeof BANK_ACCOUNT_KINDS)[number], string> = { checking: 'Conta corrente', savings: 'Poupança', other: 'Outra' };
const optText = (max: number) => z.string().max(max).nullish().transform((v) => (v && v.trim() ? v.trim() : null));
export const bankAccountSchema = z.object({
  name: z.string().trim().min(1, 'Dê um nome à conta').max(80),
  bankCode: optText(8).transform((v) => (v ? normBank(v) : null)),
  branch: optText(20),
  accountNumber: optText(30),
  kind: z.enum(BANK_ACCOUNT_KINDS).default('checking'),
  color: z.string().max(16).default('sky'),
  active: z.boolean().default(true),
  notes: optText(1000),
});
export type BankAccountInput = z.infer<typeof bankAccountSchema>;

const ofxTxSchema = z.object({
  fitId: z.string().min(1).max(120), date: isoDate, amount: money, type: z.string().max(16),
  memo: z.string().max(255).nullable(), name: z.string().max(255).nullable(), refNum: z.string().max(64).nullable(), checkNum: z.string().max(64).nullable(),
});
export const bankImportSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  /** Conta já cadastrada, ou os dados para cadastrar uma nova. */
  accountId: z.string().uuid().nullable().default(null),
  newAccount: bankAccountSchema.nullable().default(null),
  statement: z.object({
    bankId: z.string().max(8).nullable(), branchId: z.string().max(20).nullable(), accountId: z.string().max(30).nullable(),
    from: isoDate.nullable(), to: isoDate.nullable(), balance: money.nullable(), balanceDate: isoDate.nullable(),
    transactions: z.array(ofxTxSchema).min(1, 'O extrato não tem lançamentos').max(5000),
  }),
});
export type BankImportInput = z.infer<typeof bankImportSchema>;

/** O que fazer com cada lançamento na conciliação. */
export const reconcileActionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('link'), txId: z.string().uuid(), billId: z.string().uuid() }),
  z.object({
    kind: z.literal('create'), txId: z.string().uuid(), categoryId: z.string().uuid('Escolha a categoria'), folderId: z.string().uuid().nullable().default(null),
    description: z.string().trim().min(1, 'Informe a descrição').max(255), relatedPerson: optText(128),
  }),
  z.object({ kind: z.literal('ignore'), txId: z.string().uuid() }),
]);
export type ReconcileAction = z.infer<typeof reconcileActionSchema>;
export const reconcileSchema = z.object({ actions: z.array(reconcileActionSchema).min(1, 'Nada para aplicar').max(2000) });

// ------------------------------------------------------------------ sugestão de pares
export interface MatchTx { id: string; date: string; amount: string; memo: string | null; name: string | null }
export interface MatchBill {
  id: string; type: 'payable' | 'receivable'; description: string; relatedPerson: string | null;
  amount: string; dueDate: string; status: 'pending' | 'paid' | string; paidAt: string | null; paidAmount: string | null;
}
export interface MatchSuggestion { txId: string; billId: string; score: number; reason: string }

const dayNum = (d: string) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 86400000;
const words = (s: string | null | undefined) => (s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w));
const STOP = new Set(['pagamento', 'recebimento', 'transferencia', 'conta', 'pix', 'emitido', 'recebido', 'outra', 'para', 'boleto', 'debito', 'credito', 'efetivado', 'sicoob', 'mesma']);

/** Janela de datas para buscar contas candidatas de um período de extrato. */
export const MATCH_WINDOW = { pendingDays: 10, paidDays: 5 };

/**
 * Nota de 0 a ~140 para o par (ou null se não combina). Precisa do mesmo valor e do tipo certo
 * (saída = a pagar, entrada = a receber). Conta pendente: até 10 dias do vencimento. Já paga: até
 * 5 dias da data do pagamento. Palavras da descrição/pessoa no texto do banco somam pontos.
 */
export function matchScore(t: MatchTx, b: MatchBill): { score: number; reason: string } | null {
  const c = toCents(t.amount);
  if (!c) return null;
  if ((c < 0) !== (b.type === 'payable')) return null;
  const paid = b.status === 'paid';
  if (Math.abs(c) !== toCents(paid ? b.paidAmount ?? b.amount : b.amount)) return null;
  const ref = paid ? b.paidAt ?? b.dueDate : b.dueDate;
  const diff = Math.abs(dayNum(t.date) - dayNum(ref));
  const max = paid ? MATCH_WINDOW.paidDays : MATCH_WINDOW.pendingDays;
  if (diff > max) return null;
  let score = (paid ? 110 : 100) - diff * (paid ? 8 : 5);
  const text = new Set(words(`${t.memo ?? ''} ${t.name ?? ''}`));
  const hits = [...new Set(words(`${b.description} ${b.relatedPerson ?? ''}`))].filter((w) => text.has(w)).length;
  score += Math.min(30, hits * 15);
  const when = diff === 0 ? (paid ? 'mesmo dia do pagamento' : 'no vencimento') : `${diff} dia${diff > 1 ? 's' : ''} ${paid ? 'do pagamento' : 'do vencimento'}`;
  return { score, reason: `mesmo valor, ${when}${hits ? ', descrição parecida' : ''}` };
}

/** Valor (em centavos, sem sinal) que um lançamento precisa ter para combinar com a conta. */
const billCents = (b: MatchBill) => Math.abs(toCents(b.status === 'paid' ? b.paidAmount ?? b.amount : b.amount));

/**
 * Contas agrupadas pelo valor: só as de mesmo valor podem combinar com um lançamento, então quem
 * compara muitos lançamentos com muitas contas olha um grupo pequeno em vez da lista inteira
 * (um mês movimentado tem centenas dos dois lados).
 */
export function billsByAmount(bills: MatchBill[]): Map<number, MatchBill[]> {
  const m = new Map<number, MatchBill[]>();
  for (const b of bills) { const k = billCents(b); const g = m.get(k); if (g) g.push(b); else m.set(k, [b]); }
  return m;
}
/** As contas de mesmo valor do lançamento (as únicas que podem combinar com ele). */
export const sameAmountBills = (t: Pick<MatchTx, 'amount'>, byAmount: Map<number, MatchBill[]>): MatchBill[] => byAmount.get(Math.abs(toCents(t.amount))) ?? [];

/** Pares sugeridos: o melhor de cada vez, sem repetir lançamento nem conta. */
export function suggestMatches(txs: MatchTx[], bills: MatchBill[], taken: Set<string> = new Set()): MatchSuggestion[] {
  const pairs: MatchSuggestion[] = [];
  const byAmount = billsByAmount(bills);
  for (const t of txs) for (const b of sameAmountBills(t, byAmount)) {
    if (taken.has(b.id)) continue;
    const s = matchScore(t, b);
    if (s) pairs.push({ txId: t.id, billId: b.id, ...s });
  }
  pairs.sort((a, b) => b.score - a.score);
  const usedTx = new Set<string>(), usedBill = new Set<string>(taken);
  const out: MatchSuggestion[] = [];
  for (const p of pairs) {
    if (usedTx.has(p.txId) || usedBill.has(p.billId)) continue;
    usedTx.add(p.txId); usedBill.add(p.billId); out.push(p);
  }
  return out;
}

/** Contas candidatas para um lançamento (para escolher à mão), da melhor para a pior. */
export function candidatesFor(t: MatchTx, bills: MatchBill[], taken: Set<string> = new Set()): Array<MatchBill & { score: number; reason: string }> {
  return bills.filter((b) => !taken.has(b.id)).map((b) => ({ b, s: matchScore(t, b) })).filter((x) => x.s).sort((a, b) => b.s!.score - a.s!.score).map((x) => ({ ...x.b, ...x.s! }));
}

/** Descrição sugerida para criar conta a partir do lançamento ("Pagamento Pix ***.658…" → nome/memo). */
export function txDescription(t: Pick<MatchTx, 'memo' | 'name'>): string {
  const name = (t.name ?? '').replace(/\s+/g, ' ').trim();
  const memo = (t.memo ?? '').replace(/\s+/g, ' ').trim();
  const masked = /\*{3}/.test(name) || /^(pagamento|recebimento) pix\b/i.test(name) && !/[a-z]{4,}\s+[a-z]{3,}/i.test(name.replace(/^(pagamento|recebimento) pix/i, ''));
  return ((name && !masked ? name : memo || name) || 'Lançamento do extrato').slice(0, 255);
}
