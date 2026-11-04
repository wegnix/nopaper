import { z } from 'zod';
import { fromCents, parseMoneyInput, toCents } from './money.js';
import { isoDate, money, positiveMoney, BILL_TYPES } from './schemas.js';

/**
 * Importação de planilhas. O servidor lê o arquivo (xlsx/csv) e devolve células
 * normalizadas: datas viram 'YYYY-MM-DD', números ficam number, o resto string.
 * Toda a interpretação (cabeçalho, mapeamento, correções) roda aqui, no shared,
 * para a prévia no navegador ser idêntica ao que será gravado.
 */
export type ImportCell = string | number | null;
export interface ImportSheet { name: string; rows: ImportCell[][] }

export const IMPORT_FIELDS = ['description', 'dueDate', 'amount', 'paid', 'paidAt', 'paymentMethod', 'notes', 'category', 'relatedPerson'] as const;
export type ImportField = (typeof IMPORT_FIELDS)[number];
export const IMPORT_FIELD_LABEL: Record<ImportField, string> = {
  description: 'Descrição', dueDate: 'Vencimento', amount: 'Valor', paid: 'Pago (valor ou sim/não)', paidAt: 'Data do pagamento',
  paymentMethod: 'Forma de pagamento', notes: 'Observações', category: 'Categoria', relatedPerson: 'Pessoa / empresa',
};
export const IMPORT_REQUIRED: ImportField[] = ['description', 'dueDate', 'amount'];

const KEYWORDS: Record<ImportField, string[]> = {
  description: ['descricao', 'descrição', 'historico', 'conta', 'despesa', 'item', 'nome'],
  dueDate: ['vencimento', 'vcto', 'venc', 'data venc', 'data vcto', 'data'],
  amount: ['valor', 'vlr', 'total', 'quantia'],
  paid: ['pago', 'paga', 'valor pago', 'quitado', 'recebido', 'status', 'situacao'],
  paidAt: ['data pgto', 'data pagamento', 'pagamento em', 'pago em', 'dt pgto', 'data pag', 'data recebimento', 'recebido em'],
  paymentMethod: ['metodo', 'forma', 'meio', 'pagamento'],
  notes: ['obs', 'observacao', 'observacoes', 'obervacoes', 'nota', 'comentario'],
  category: ['categoria', 'grupo', 'tipo', 'classificacao'],
  relatedPerson: ['fornecedor', 'cliente', 'favorecido', 'pessoa', 'empresa', 'beneficiario'],
};

export function normText(s: unknown): string {
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

const MONTH_NAMES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
/** "Jan", "Fevereiro", "03-2026", "03/2026" → mês 1..12. */
export function sheetMonthFromName(name: string): number | null {
  const n = normText(name);
  const num = n.match(/^(\d{1,2})\s*[-/.]\s*\d{2,4}$/) ?? n.match(/^\d{4}\s*[-/.]\s*(\d{1,2})$/);
  if (num) { const m = Number(num[1]); return m >= 1 && m <= 12 ? m : null; }
  const word = n.match(/^[a-z]+/)?.[0] ?? '';
  if (word.length < 3) return null;
  const i = MONTH_NAMES.indexOf(word.slice(0, 3));
  return i >= 0 ? i + 1 : null;
}
export function sheetYearFromName(name: string): number | null {
  const m = name.match(/(20\d{2})/);
  return m ? Number(m[1]) : null;
}

const isBlank = (v: ImportCell) => v === null || (typeof v === 'string' && !v.trim());

/** Linha do cabeçalho: a que mais casa com as palavras conhecidas entre as 20 primeiras. */
export function detectHeaderRow(rows: ImportCell[][]): number {
  let best = -1, bestScore = 1;
  rows.slice(0, 20).forEach((r, i) => {
    const texts = r.filter((c) => typeof c === 'string' && c.trim()).map(normText);
    if (texts.length < 2) return;
    let score = 0;
    for (const t of texts) if (Object.values(KEYWORDS).some((ks) => ks.some((k) => t === k || t.startsWith(k + ' ') || t.includes(k)))) score++;
    if (score > bestScore) { best = i; bestScore = score; }
  });
  return best;
}

export function headersOf(sheet: ImportSheet): { headerRow: number; headers: string[] } {
  const headerRow = detectHeaderRow(sheet.rows);
  const headers = headerRow >= 0 ? sheet.rows[headerRow].map((c) => (c === null ? '' : String(c).trim())) : [];
  return { headerRow, headers };
}

/** Mapeamento campo → texto do cabeçalho (normalizado). Por nome, para valer em todas as abas. */
export type ImportMapping = Partial<Record<ImportField, string>>;

export function guessMapping(headers: string[]): ImportMapping {
  const norm = headers.map(normText);
  const used = new Set<number>();
  const out: ImportMapping = {};
  // ordem importa: campos mais específicos primeiro ("data pgto" antes de "data", "valor pago" antes de "valor")
  const order: ImportField[] = ['paidAt', 'paid', 'dueDate', 'description', 'amount', 'paymentMethod', 'notes', 'category', 'relatedPerson'];
  for (const f of order) {
    let hit = -1;
    for (const k of KEYWORDS[f]) { // match exato primeiro
      hit = norm.findIndex((h, i) => !used.has(i) && h === k);
      if (hit >= 0) break;
    }
    if (hit < 0) for (const k of KEYWORDS[f]) {
      hit = norm.findIndex((h, i) => !used.has(i) && h && (h.startsWith(k) || (k.length > 4 && h.includes(k))));
      if (hit >= 0) break;
    }
    if (hit >= 0) { used.add(hit); out[f] = norm[hit]; }
  }
  return out;
}

// ------------------------------------------------------------------ células
function pad(n: number) { return String(n).padStart(2, '0'); }
function validYMD(y: number, m: number, d: number) {
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function lastDay(y: number, m: number) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

/** Aceita ISO, dd/mm/aaaa, dd/mm/aa, dd/mm (usa defaultYear) e serial do Excel. */
export function parseCellDate(v: ImportCell, defaultYear?: number): string | null {
  if (v === null) return null;
  if (typeof v === 'number') {
    if (v > 20000 && v < 80000) { // serial do Excel (dias desde 1899-12-30)
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 86400000);
      return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
    }
    return null;
  }
  const s = v.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return validYMD(+m[1], +m[2], +m[3]) ? `${m[1]}-${m[2]}-${m[3]}` : null;
  m = s.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2,4}))?$/);
  if (m) {
    let y = m[3] ? Number(m[3]) : defaultYear;
    if (!y) return null;
    if (y < 100) y += 2000;
    const mo = Number(m[2]), d = Number(m[1]);
    return validYMD(y, mo, d) ? `${y}-${pad(mo)}-${pad(d)}` : null;
  }
  return null;
}

export function parseCellMoney(v: ImportCell): string | null {
  if (v === null) return null;
  const r = parseMoneyInput(v);
  return r && /^-?\d+(\.\d{1,2})?$/.test(r) ? r : null;
}

const TRUTHY = new Set(['sim', 's', 'x', 'ok', 'pago', 'paga', 'recebido', 'recebida', 'quitado', 'quitada', 'true', 'yes', 'y', '1', '✓', '✔']);

// ------------------------------------------------------------------ montagem das linhas
export interface ImportOptions {
  /** Ano de referência das abas mensais (corrige anos digitados errado). */
  year: number;
  /** Corrigir o ano de vencimentos que caem no mês da aba mas com outro ano. */
  fixYear: boolean;
  /** Dia usado quando o vencimento não é uma data (ex.: "Semanal") e a aba tem mês. */
  fallbackDay: number;
  today: string;
}

export type ImportSkip = 'empty' | 'total' | 'no_amount' | 'no_date';
export const IMPORT_SKIP_LABEL: Record<ImportSkip, string> = {
  empty: 'linha vazia', total: 'linha de total', no_amount: 'sem valor', no_date: 'sem data de vencimento',
};

export interface ImportRow {
  key: string;
  sheet: string;
  line: number; // 1-based, como no Excel
  description: string;
  dueDate: string | null;
  amount: string | null;
  paidAt: string | null;
  paidAmount: string | null;
  paymentMethod: string | null;
  notes: string | null;
  categoryName: string | null;
  relatedPerson: string | null;
  warnings: string[];
  skip: ImportSkip | null;
}

function cellText(v: ImportCell): string | null {
  if (v === null) return null;
  const s = (typeof v === 'number' ? String(v) : v).trim();
  return s || null;
}

export function buildImportRows(sheet: ImportSheet, mapping: ImportMapping, opts: ImportOptions): ImportRow[] {
  const { headerRow, headers } = headersOf(sheet);
  if (headerRow < 0) return [];
  const norm = headers.map(normText);
  const col = (f: ImportField) => (mapping[f] ? norm.indexOf(mapping[f]!) : -1);
  const cols = Object.fromEntries(IMPORT_FIELDS.map((f) => [f, col(f)])) as Record<ImportField, number>;
  const sheetMonth = sheetMonthFromName(sheet.name);
  const year = sheetYearFromName(sheet.name) ?? opts.year;
  const out: ImportRow[] = [];

  sheet.rows.slice(headerRow + 1).forEach((r, i) => {
    const get = (f: ImportField): ImportCell => (cols[f] >= 0 ? r[cols[f]] ?? null : null);
    const line = headerRow + 2 + i;
    const description = (cellText(get('description')) ?? '').slice(0, 255);
    const row: ImportRow = {
      key: `${sheet.name}:${line}`, sheet: sheet.name, line, description,
      dueDate: null, amount: null, paidAt: null, paidAmount: null,
      paymentMethod: cellText(get('paymentMethod'))?.slice(0, 64) ?? null,
      notes: cellText(get('notes')), categoryName: cellText(get('category')), relatedPerson: cellText(get('relatedPerson'))?.slice(0, 128) ?? null,
      warnings: [], skip: null,
    };
    if (!description) {
      const otherText = r.some((c, ci) => ci !== cols.description && typeof c === 'string' && /^(total|a pagar|a receber|subtotal|saldo)/.test(normText(c)));
      row.skip = otherText ? 'total' : 'empty';
      out.push(row); return;
    }
    if (/^(total|subtotal|saldo|a pagar|a receber)\b/.test(normText(description))) { row.skip = 'total'; out.push(row); return; }
    const notes: string[] = row.notes ? [row.notes] : [];

    // valor
    const amount = parseCellMoney(get('amount'));
    if (!amount || toCents(amount) <= 0) { row.skip = 'no_amount'; out.push(row); return; }
    row.amount = amount;

    // vencimento
    const rawDue = get('dueDate');
    let due = parseCellDate(rawDue, year);
    if (due && sheetMonth) {
      const [dy, dm] = due.split('-').map(Number);
      if (dm === sheetMonth && dy !== year && opts.fixYear) {
        const d = Math.min(Number(due.slice(8)), lastDay(year, dm));
        row.warnings.push(`Ano corrigido de ${dy} para ${year} (aba ${sheet.name})`);
        due = `${year}-${pad(dm)}-${pad(d)}`;
      } else if (dm !== sheetMonth) {
        row.warnings.push(`Vencimento fora do mês da aba ${sheet.name}`);
      }
    }
    if (!due) {
      if (sheetMonth) {
        due = `${year}-${pad(sheetMonth)}-${pad(Math.min(opts.fallbackDay, lastDay(year, sheetMonth)))}`;
        const raw = cellText(rawDue);
        row.warnings.push(raw ? `"${raw}" não é data: vencimento dia ${opts.fallbackDay}` : `Sem vencimento: usado dia ${opts.fallbackDay}`);
        if (raw) notes.push(`Vencimento na planilha: ${raw}`);
      } else { row.skip = 'no_date'; out.push(row); return; }
    }
    row.dueDate = due;

    // pagamento
    const rawPaid = get('paid');
    const paidDate = parseCellDate(get('paidAt'), year);
    let paidCents = 0;
    let paidFlag = false;
    if (typeof rawPaid === 'number') paidCents = Math.round(rawPaid * 100);
    else if (typeof rawPaid === 'string' && rawPaid.trim()) {
      const asMoney = parseCellMoney(rawPaid);
      if (asMoney && /\d/.test(rawPaid)) paidCents = toCents(asMoney);
      else paidFlag = TRUTHY.has(normText(rawPaid));
    }
    const total = toCents(amount);
    const isPaid = paidFlag || paidCents >= total || (paidCents > 0 && !!paidDate) || (cols.paid < 0 && !!paidDate);
    if (isPaid) {
      let at = paidDate;
      if (!at) { at = due <= opts.today ? due : opts.today; row.warnings.push('Pago sem data: usado o vencimento'); }
      else if (at > opts.today) { row.warnings.push(`Data de pagamento no futuro (${at.split('-').reverse().join('/')}): usado o vencimento`); at = due <= opts.today ? due : opts.today; }
      row.paidAt = at;
      row.paidAmount = paidCents > 0 ? fromCents(paidCents) : amount;
    } else if (paidCents > 0) {
      notes.push(`Pago parcialmente: R$ ${fromCents(paidCents).replace('.', ',')}`);
      row.warnings.push('Pagamento parcial: fica pendente');
    }
    row.notes = notes.length ? notes.join('\n').slice(0, 2000) : null;
    out.push(row);
  });
  return out;
}

/** Chave para detectar duplicatas e agrupar descrições. */
export function dupKey(description: string, dueDate: string, amount: string) {
  return `${normText(description)}|${dueDate}|${toCents(amount)}`;
}

// ------------------------------------------------------------------ API
export const importRowSchema = z.object({
  description: z.string().trim().min(1).max(255),
  categoryId: z.string().uuid(),
  dueDate: isoDate,
  amount: positiveMoney,
  paidAt: isoDate.nullish(),
  paidAmount: money.nullish(),
  paymentMethod: z.string().trim().max(64).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  relatedPerson: z.string().trim().max(128).nullish(),
});
export const importCommitSchema = z.object({
  type: z.enum(BILL_TYPES),
  fileName: z.string().trim().max(200).default('planilha'),
  folderId: z.string().uuid().nullish(),
  rows: z.array(importRowSchema).min(1, 'Nenhuma linha para importar').max(5000, 'Máximo de 5.000 linhas por importação'),
});
export type ImportCommitInput = z.infer<typeof importCommitSchema>;
export const importCheckSchema = z.object({
  type: z.enum(BILL_TYPES),
  rows: z.array(z.object({ description: z.string().max(255), dueDate: isoDate, amount: positiveMoney })).max(5000),
});
