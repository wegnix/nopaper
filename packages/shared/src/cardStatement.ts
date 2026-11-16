import { fromCents, parseMoneyInput, toCents } from './money.js';
import { normText, parseCellDate, type ImportCell, type ImportSheet } from './import.js';
import type { PdfCell } from './payslips.js';
import type { CardOfxKind, CardOfxLine } from './cardOfx.js';

/**
 * Fatura do cartão em PDF ou planilha (xlsx/csv) → os mesmos lançamentos que o OFX entrega.
 *
 * Não há um leitor por banco. O que é comum a toda fatura é a forma do lançamento — uma data, um
 * texto e um valor — e os totais impressos. O leitor acha os lançamentos pela forma (na planilha,
 * pelas colunas Data/Descrição/Valor de cada bloco; no PDF, por data no começo e valor no fim de cada
 * trecho da linha, o que cobre faturas em duas colunas) e depois **confere a soma com o total da
 * fatura**: se bate, a leitura está certa; se não bate, a diferença é mostrada e a pessoa revisa.
 *
 * Uma fatura pode trazer vários cartões (titular, virtual, adicionais): cada lançamento guarda o
 * final do cartão e o portador, lidos do título do bloco (PDF) ou da coluna "Final Cartão" (planilha).
 */

export interface CardStatementLine extends CardOfxLine {
  /** Últimos 4 dígitos do cartão que fez a compra (a fatura pode juntar titular, virtual e adicionais). */
  cardFinal: string | null;
  holder: string | null;
}
export interface CardStatementCard {
  final: string;
  holder: string | null;
  /** "físico", "virtual", "adicional"… quando a fatura diz. */
  label: string | null;
  count: number;
  /** Soma dos lançamentos lidos deste cartão. */
  sum: string;
  /** Total impresso para este cartão, quando a fatura traz. */
  printedTotal: string | null;
}
export interface CardStatementRead {
  format: 'sheet' | 'pdf';
  lines: CardStatementLine[];
  cards: CardStatementCard[];
  dueDate: string | null;
  /** Total da fatura impresso no arquivo. */
  total: string | null;
  /** Soma do que foi lido (sem o pagamento da fatura anterior). */
  sum: string;
  /** total − sum; "0.00" = a leitura fecha com a fatura. */
  diff: string | null;
  warnings: string[];
}

export const CARD_STATEMENT_MAX_LINES = 2000;

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const PAYMENT = /\b(pagamento|pagto|pgto)\b/i;
const pad = (n: number) => String(n).padStart(2, '0');
const validDay = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const fullYear = (y: number) => (y < 100 ? 2000 + y : y);

// ------------------------------------------------------------------ parcela
const INSTALLMENT_PATTERNS = [
  /\s*\(\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*\)/,                         // "Loja (2/10)"
  /\s*[-–]?\s*\bparc(?:ela)?\.?\s*(\d{1,2})\s*(?:\/|de)\s*(\d{1,2})\b/i, // "Parcela 2 de 10", "PARC 02/10"
  /\s+(\d{2})\/(\d{2})$/,                                              // "LOJA 02/10" (no fim)
];

/** "Metronorte (2/10)" → descrição limpa + parcela 2 de 10. */
export function splitInstallment(text: string): { description: string; installment: number | null; installments: number | null } {
  const raw = text.replace(/\s+/g, ' ').trim();
  for (const re of INSTALLMENT_PATTERNS) {
    const m = re.exec(raw);
    if (!m) continue;
    const n = Number(m[1]), total = Number(m[2]);
    if (total < 2 || n < 1 || n > total) continue;
    const description = raw.replace(m[0], ' ').replace(/\s+/g, ' ').trim();
    if (description.length >= 2) return { description, installment: n, installments: total };
  }
  return { description: raw, installment: null, installments: null };
}

function installmentCell(v: ImportCell): { n: number; total: number } | null {
  const m = /^\s*(\d{1,2})\s*(?:\/|de)\s*(\d{1,2})\s*$/i.exec(String(v ?? ''));
  if (!m) return null;
  const n = Number(m[1]), total = Number(m[2]);
  return total >= 2 && n >= 1 && n <= total ? { n, total } : null;
}

// ------------------------------------------------------------------ comum
interface Draft {
  date: string; cents: number; text: string; cardFinal: string | null; holder: string | null;
  payment: boolean; inst: { n: number; total: number } | null;
}

function finish(format: 'sheet' | 'pdf', drafts: Draft[], meta: { dueDate: string | null; totalCents: number | null; printed: Map<string, { holder: string | null; label: string | null; total: number | null }> }, warnings: string[]): CardStatementRead {
  if (drafts.length > CARD_STATEMENT_MAX_LINES) {
    warnings.push(`O arquivo tem mais de ${CARD_STATEMENT_MAX_LINES} lançamentos; só os primeiros foram lidos.`);
    drafts = drafts.slice(0, CARD_STATEMENT_MAX_LINES);
  }
  // sinal: no NoPaper compra é positiva. Se o arquivo traz as compras negativas (a maioria), inverte tudo.
  const normal = drafts.filter((d) => !d.payment);
  if (normal.filter((d) => d.cents < 0).length > normal.filter((d) => d.cents > 0).length) for (const d of drafts) d.cents = -d.cents;

  // em ordem de data (o PDF em duas colunas vem intercalado); empate mantém a ordem do arquivo
  drafts = drafts.map((d, i) => ({ d, i })).sort((a, b) => (a.d.date < b.d.date ? -1 : a.d.date > b.d.date ? 1 : a.i - b.i)).map((x) => x.d);
  const seen = new Map<string, number>();
  const lines: CardStatementLine[] = drafts.filter((d) => d.cents !== 0).map((d) => {
    const memo = d.text.replace(/\s+/g, ' ').trim().slice(0, 600);
    const parsed = splitInstallment(memo);
    const installment = d.inst?.n ?? parsed.installment, installments = d.inst?.total ?? parsed.installments;
    const kind: CardOfxKind = d.cents > 0 ? 'purchase' : d.payment || PAYMENT.test(memo) ? 'payment' : 'refund';
    const base = `${d.date}|${d.cents}|${normText(memo)}|${d.cardFinal ?? ''}`;
    const k = seen.get(base) ?? 0;
    seen.set(base, k + 1);
    return {
      fitId: `${base}|${k}`.slice(0, 120), date: d.date, amount: fromCents(d.cents), memo,
      description: (parsed.description || 'Compra no cartão').slice(0, 255), installment, installments, kind,
      cardFinal: d.cardFinal, holder: d.holder,
    };
  });

  const cards = new Map<string, CardStatementCard>();
  for (const l of lines) {
    if (!l.cardFinal || l.kind === 'payment') continue;
    const p = meta.printed.get(l.cardFinal);
    const c = cards.get(l.cardFinal) ?? { final: l.cardFinal, holder: l.holder ?? p?.holder ?? null, label: p?.label ?? null, count: 0, sum: '0.00', printedTotal: p?.total != null ? fromCents(p.total) : null };
    c.count++; c.sum = fromCents(toCents(c.sum) + toCents(l.amount));
    cards.set(l.cardFinal, c);
  }
  for (const c of cards.values()) {
    if (c.printedTotal !== null && c.printedTotal !== c.sum) warnings.push(`Cartão final ${c.final}: li ${brl(toCents(c.sum))}, mas a fatura diz ${brl(toCents(c.printedTotal))}. Confira os lançamentos dele.`);
  }

  const sum = lines.filter((l) => l.kind !== 'payment').reduce((a, l) => a + toCents(l.amount), 0);
  const diff = meta.totalCents === null ? null : meta.totalCents - sum;
  if (!lines.length) warnings.push('Não achei lançamentos neste arquivo.');
  else if (diff === null) warnings.push('Não achei o total da fatura no arquivo: confira a soma dos lançamentos com a fatura.');
  else if (diff !== 0) warnings.push(`A fatura é de ${brl(meta.totalCents!)} e os lançamentos lidos somam ${brl(sum)}: ${diff > 0 ? 'faltam' : 'sobram'} ${brl(Math.abs(diff))}. ${format === 'sheet' ? 'A planilha de alguns bancos não traz tarifas (anuidade, mensalidade) e encargos.' : 'Confira os lançamentos com a fatura.'}`);

  return { format, lines, cards: [...cards.values()], dueDate: meta.dueDate, total: meta.totalCents === null ? null : fromCents(meta.totalCents), sum: fromCents(sum), diff: diff === null ? null : fromCents(diff), warnings };
}
const brl = (cents: number) => `R$ ${fromCents(cents).replace('.', ',').replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;

/** Ano de um dia/mês sem ano: o mais recente que não passa da data-limite (parcela n → n−1 meses antes dela). */
function yearFor(day: number, month: number, limit: string, installment: number | null): string | null {
  let y = Number(limit.slice(0, 4)), m = Number(limit.slice(5, 7)) - ((installment ?? 1) - 1);
  while (m < 1) { m += 12; y--; }
  const lim = iso(y, m, Math.min(Number(limit.slice(8, 10)), new Date(Date.UTC(y, m, 0)).getUTCDate()));
  for (const yy of [y, y - 1]) {
    // 29/02 em ano que não é bissexto: tenta o anterior
    if (validDay(yy, month, day) && iso(yy, month, day) <= lim) return iso(yy, month, day);
  }
  return validDay(y - 2, month, day) ? iso(y - 2, month, day) : null;
}

// ------------------------------------------------------------------ planilha
const H_DATE = ['data', 'date', 'dt'];
const H_DESC = ['descricao', 'estabelecimento', 'lancamento', 'historico', 'movimentacao', 'title', 'titulo', 'description', 'detalhe', 'loja', 'compra'];
const H_AMOUNT = ['valor', 'amount', 'r$', 'total'];

interface Cols { date: number; desc: number; amount: number; inst: number; final: number; holder: number }
function headerCols(row: ImportCell[]): Cols | null {
  const n = row.map((c) => (typeof c === 'string' ? normText(c) : ''));
  const find = (keys: string[], skip: number[] = [], bad?: RegExp) => {
    for (const k of keys) {
      const i = n.findIndex((h, idx) => h && !skip.includes(idx) && (h === k || h.startsWith(k + ' ') || h.startsWith(k)) && !(bad && bad.test(h)));
      if (i >= 0) return i;
    }
    return -1;
  };
  const date = find(H_DATE);
  if (date < 0) return null;
  const amount = find(H_AMOUNT, [date], /us\$|dolar|usd|parcela/);
  const desc = find(H_DESC, [date, amount]);
  if (amount < 0 || desc < 0) return null;
  const at = (re: RegExp) => n.findIndex((h, idx) => h && ![date, amount, desc].includes(idx) && re.test(h));
  return { date, desc, amount, inst: at(/parcela/), final: at(/final|^cartao|numero do cartao/), holder: at(/portador|titular|^nome/) };
}

function cellMoney(v: ImportCell): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : null;
  const m = parseMoneyInput(v);
  return m === null ? null : toCents(m);
}

export function parseCardSheet(sheets: ImportSheet[], today: string): CardStatementRead {
  const warnings: string[] = [];
  const raw: Array<{ dateCell: ImportCell; cents: number; text: string; final: string | null; holder: string | null; payment: boolean; inst: { n: number; total: number } | null }> = [];
  let dueCell: ImportCell = null, totalCents: number | null = null, yearHint: number | null = null;

  for (const sheet of sheets) {
    let cols: Cols | null = null, payment = false, lastLabel = '';
    for (const row of sheet.rows) {
      const filled = row.filter((c) => c !== null && String(c).trim() !== '');
      if (!filled.length) continue;
      const head = headerCols(row);
      if (head) { cols = head; payment = PAYMENT.test(lastLabel); continue; }

      // rótulo → valor ("Vencimento | 19/11", "Total da Fatura | 8400,56") e o mês da fatura ("Novembro/2026")
      for (let i = 0; i < row.length; i++) {
        const label = typeof row[i] === 'string' ? normText(row[i]) : '';
        if (!label) continue;
        const y = /\b(20\d{2})\b/.exec(label);
        if (y && MONTHS.some((m) => label.includes(m)) && yearHint === null) yearHint = Number(y[1]);
        const next = row.slice(i + 1).find((c) => c !== null && String(c).trim() !== '') ?? null;
        if (next === null) continue;
        if (dueCell === null && /^(data de )?vencimento/.test(label)) dueCell = next;
        if (/^(valor )?total (da|desta) fatura|^total a pagar|^valor (total )?a pagar/.test(label)) { const c = cellMoney(next); if (c !== null) totalCents = c; }
      }

      const first = filled[0];
      if (cols) {
        const cents = cellMoney(row[cols.amount] ?? null);
        const text = String(row[cols.desc] ?? '').trim();
        const dateCell = row[cols.date] ?? null;
        if (cents !== null && text && dateCell !== null && parseCellDate(dateCell, 2000) !== null) {
          const fin = cols.final >= 0 ? /(\d{4})\s*$/.exec(String(row[cols.final] ?? '')) : null;
          const holder = cols.holder >= 0 ? String(row[cols.holder] ?? '').trim() || null : null;
          raw.push({ dateCell, cents, text, final: fin ? fin[1] : null, holder, payment, inst: cols.inst >= 0 ? installmentCell(row[cols.inst] ?? null) : null });
          continue;
        }
      }
      if (typeof first === 'string') lastLabel = first;
    }
  }

  // datas com ano valem como estão; "dd/mm" usa o vencimento como limite
  const withYear = raw.map((r) => (typeof r.dateCell === 'string' && /^\s*\d{1,2}[/.-]\d{1,2}\s*$/.test(r.dateCell) ? null : parseCellDate(r.dateCell)));
  const maxDate = withYear.filter((d): d is string => !!d).sort().pop() ?? null;
  const dueDate = resolveDue(dueCell, maxDate, yearHint, today);
  const limit = dueDate ?? maxDate ?? today;
  const drafts: Draft[] = [];
  raw.forEach((r, i) => {
    let date = withYear[i];
    if (!date) {
      const m = /^\s*(\d{1,2})[/.-](\d{1,2})\s*$/.exec(String(r.dateCell));
      const inst = r.inst?.n ?? splitInstallment(r.text).installment;
      date = m ? yearFor(Number(m[1]), Number(m[2]), limit, inst) : null;
    }
    if (date) drafts.push({ date, cents: r.cents, text: r.text, cardFinal: r.final, holder: r.holder, payment: r.payment, inst: r.inst });
  });
  return finish('sheet', drafts, { dueDate, totalCents, printed: new Map() }, warnings);
}

/** Vencimento "19/11" sem ano: o primeiro que não fica antes da última compra (ou o ano do mês da fatura). */
function resolveDue(cell: ImportCell, maxDate: string | null, yearHint: number | null, today: string): string | null {
  if (cell === null) return null;
  const m = typeof cell === 'string' ? /^\s*(\d{1,2})[/.-](\d{1,2})\s*$/.exec(cell) : null;
  if (!m) return parseCellDate(cell);
  const d = Number(m[1]), mo = Number(m[2]);
  if (maxDate) {
    const y = Number(maxDate.slice(0, 4));
    for (const yy of [y, y + 1]) if (validDay(yy, mo, d) && iso(yy, mo, d) >= maxDate) return iso(yy, mo, d);
  }
  const y = yearHint ?? Number(today.slice(0, 4));
  return validDay(y, mo, d) ? iso(y, mo, d) : null;
}

// ------------------------------------------------------------------ PDF
const MONTH_WORD = '(jan(?:eiro)?|fev(?:ereiro)?|mar(?:[cç]o)?|abr(?:il)?|mai(?:o)?|jun(?:ho)?|jul(?:ho)?|ago(?:sto)?|set(?:embro)?|out(?:ubro)?|nov(?:embro)?|dez(?:embro)?)';
/** Data no começo de um trecho: "18 Set", "18/09", "18/09/2026", "18 de setembro", "18-set". */
const DATE_START = new RegExp(`^(\\d{1,2})(?:\\s*[/.-]\\s*(\\d{1,2})(?:\\s*[/.-]\\s*(\\d{2}|\\d{4}))?|\\s*(?:de\\s+|[-/ ])?\\s*${MONTH_WORD}\\.?(?:\\s*(?:de\\s+|[/ ])?(20\\d{2}))?)(?=\\s|$)`, 'i');
/** Valor no fim de um trecho: "R$ 339,80", "- R$ 157,85", "-157,85", "157,85-", "157,85 C". */
const MONEY_END = /(?:^|\s)(-\s*)?(?:R\$\s*)?(-\s*)?(\d{1,3}(?:\.\d{3})*,\d{2})(\s*-|\s*[CD])?$/i;
const MONEY_ANY = /(-\s*)?R?\$?\s*(-\s*)?(\d{1,3}(?:\.\d{3})*,\d{2})/;
const NOT_A_PURCHASE = /^(valor|total|vencimento|limite|saldo|m[ií]nimo|at[eé]\b)/i;

function moneyEnd(s: string): { cents: number; rest: string } | null {
  const m = MONEY_END.exec(s);
  if (!m) return null;
  const cents = toCents(m[3].replace(/\./g, '').replace(',', '.'));
  const neg = !!(m[1] || m[2] || (m[4] && /-|C/i.test(m[4])));
  return { cents: neg ? -cents : cents, rest: s.slice(0, m.index).trim() };
}

function dateStart(s: string): { day: number; month: number; year: number | null; rest: string } | null {
  const m = DATE_START.exec(s);
  if (!m) return null;
  const day = Number(m[1]);
  const month = m[2] ? Number(m[2]) : MONTHS.indexOf(normText(m[4]).slice(0, 3)) + 1;
  const year = m[3] ? fullYear(Number(m[3])) : m[5] ? Number(m[5]) : null;
  if (!validDay(year ?? 2024, month, day)) return null;
  return { day, month, year, rest: s.slice(m[0].length).trim() };
}

interface PdfEntry { day: number; month: number; year: number | null; text: string; cents: number }

/** Lançamentos de uma linha do PDF: cada um começa num trecho com data e acaba no trecho com valor (duas colunas = dois lançamentos). */
function rowEntries(segs: string[]): { entries: PdfEntry[]; used: boolean[] } {
  const entries: PdfEntry[] = [];
  const used = segs.map(() => false);
  for (let i = 0; i < segs.length; i++) {
    const d = dateStart(segs[i]);
    if (!d) continue;
    let text = d.rest;
    for (let j = i; j < Math.min(segs.length, i + 6); j++) {
      if (j > i) {
        if (dateStart(segs[j])) break;
        text = `${text} ${segs[j]}`.trim();
      }
      const m = moneyEnd(text);
      if (!m) continue;
      if (m.rest.length >= 2 && /[a-zà-ú]/i.test(m.rest) && !NOT_A_PURCHASE.test(m.rest) && !m.rest.includes(':')) {
        entries.push({ day: d.day, month: d.month, year: d.year, text: m.rest, cents: m.cents });
        for (let k = i; k <= j; k++) used[k] = true;
        i = j;
      }
      break;
    }
  }
  return { entries, used };
}

export function parseCardPdf(rows: PdfCell[][], today: string): CardStatementRead {
  const warnings: string[] = [];
  const texts = rows.map((r) => r.map((c) => c.s).join(' ').replace(/\s+/g, ' ').trim());
  const repeated = new Map<string, number>();
  for (const t of texts) repeated.set(t, (repeated.get(t) ?? 0) + 1);
  const all = texts.join('\n');

  // ---- vencimento e total impressos
  const yearHint = Number(new RegExp(`${MONTH_WORD}\\s*(?:de\\s+|/)\\s*(20\\d{2})`, 'i').exec(all)?.[2] ?? /\b\d{1,2}\/\d{1,2}\/(20\d{2})\b/.exec(all)?.[1] ?? today.slice(0, 4));
  let dueDate: string | null = null;
  const due = /vencimento\D{0,12}?(\d{1,2})\s*[/.]\s*(\d{1,2})(?:\s*[/.]\s*(\d{2,4}))?/i.exec(all);
  if (due) {
    const y = due[3] ? fullYear(Number(due[3])) : yearHint;
    if (validDay(y, Number(due[2]), Number(due[1]))) dueDate = iso(y, Number(due[2]), Number(due[1]));
  }
  let totalCents: number | null = null;
  for (const re of [/total a pagar/i, /(?:valor\s+)?total\s+d(?:a|esta)\s+fatura/i, /valor\s+(?:total\s+)?a\s+pagar/i, /total\s+d(?:a|esta)\s+fatura\s+atual/i]) {
    for (const t of texts) {
      const at = re.exec(t);
      const m = at ? MONEY_ANY.exec(t.slice(at.index + at[0].length, at.index + at[0].length + 40)) : null;
      if (m) { totalCents = toCents(m[3].replace(/\./g, '').replace(',', '.')) * (m[1] || m[2] ? -1 : 1); break; }
    }
    if (totalCents !== null) break;
  }

  // ---- lançamentos, com o cartão do bloco em que estão
  const limit = dueDate ?? today;
  const drafts: Draft[] = [];
  const printed = new Map<string, { holder: string | null; label: string | null; total: number | null }>();
  let final: string | null = null, holder: string | null = null, payment = false;
  rows.forEach((row, idx) => {
    // um texto do PDF pode trazer vários campos separados por espaços largos
    const segs = row.flatMap((c) => c.s.split(/\s{2,}/)).map((s) => s.trim()).filter(Boolean);
    const { entries } = rowEntries(segs);
    if (!entries.length) {
      const t = texts[idx];
      const f = /\bfinal\s*:?\s*(\d{4})\b/i.exec(t) ?? /(?:\*{2,}|x{4,}|•{2,})[\s.]*(\d{4})\b/i.exec(t);
      // cabeçalho que se repete em toda página ("… | cartão final 1234") não é título de bloco
      if (f && (repeated.get(t) ?? 0) < 2) {
        final = f[1];
        const parts = t.split('|').map((p) => p.trim());
        const at = parts.findIndex((p) => p.includes(f[1]));
        const name = at > 0 ? parts[at - 1] : '';
        holder = /^[A-Za-zÀ-ú' .]{3,60}$/.test(name) ? name : null;
        const label = /adicional/i.test(t) ? 'adicional' : /virtual/i.test(t) ? 'virtual' : /f[ií]sico/i.test(t) ? 'físico' : /titular/i.test(t) ? 'titular' : null;
        const tot = /total\s+do\s+cart[aã]o\s*:?\s*/i.exec(t);
        const tm = tot ? MONEY_ANY.exec(t.slice(tot.index + tot[0].length, tot.index + tot[0].length + 30)) : null;
        printed.set(final, { holder, label, total: tm ? toCents(tm[3].replace(/\./g, '').replace(',', '.')) * (tm[1] || tm[2] ? -1 : 1) : null });
        payment = false;
      } else if (/outros\s+lan[cç]amentos|encargos|tarifas|ajustes/i.test(t) && !f && !MONEY_ANY.test(t.replace(/total[^|]*$/i, ''))) {
        final = null; holder = null; payment = false;
      } else if (/^pagamentos?\b/i.test(t)) {
        payment = true;
      } else if (/^total de (compras|cr[eé]ditos)/i.test(t)) {
        payment = false;
      }
      return;
    }
    for (const e of entries) {
      const inst = splitInstallment(e.text).installment;
      const date = e.year !== null ? iso(e.year, e.month, e.day) : yearFor(e.day, e.month, limit, inst);
      if (date) drafts.push({ date, cents: e.cents, text: e.text, cardFinal: final, holder, payment: payment && e.cents < 0, inst: null });
    }
  });
  return finish('pdf', drafts, { dueDate, totalCents, printed }, warnings);
}
