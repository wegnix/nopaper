import { z } from 'zod';
import { money, isoDate, documentSchema } from './schemas.js';
import { fromCents, parseMoneyInput, toCents } from './money.js';
import { daysInMonth, toISODate, MONTHS_PT_SHORT } from './dates.js';

/**
 * Folha de pagamento (só em espaços do tipo Empresa).
 *
 * Cada mês (competência) tem um lançamento por funcionário. Valores:
 * - holerite: o líquido que vem do holerite do contador. Pode ser digitado direto ou detalhado em
 *   rubricas (salário base, INSS, IRRF, VT…) — nesse caso o líquido é a soma delas;
 * - extras (fora do holerite): metas, comissões, vitaminas, hora extra… (+) e descontos de
 *   produtos/vales (−);
 * - encargos do empregador (FGTS etc.): só custo, não entram no valor pago ao funcionário.
 *
 * A pagar = líquido do holerite + extras − descontos. "Por fora" = o que passa do holerite.
 */

export const PAYROLL_SECTIONS = ['payslip', 'extra', 'employer'] as const;
export type PayrollSection = (typeof PAYROLL_SECTIONS)[number];
export const PAYROLL_KINDS = ['earning', 'deduction'] as const;
export type PayrollKind = (typeof PAYROLL_KINDS)[number];

export const PAYROLL_SECTION_LABEL: Record<PayrollSection, string> = {
  payslip: 'Holerite', extra: 'Fora do holerite', employer: 'Encargos da empresa',
};

export interface PayrollRubricLike { id: string; section: PayrollSection | string; kind: PayrollKind | string }
export interface PayrollLineLike { rubricId: string; amount: string }

export interface PayrollTotals {
  /** Proventos do holerite (bruto) — só quando o holerite está detalhado. */
  payslipEarnings: string;
  payslipDeductions: string;
  /** Líquido do holerite. */
  payslipNet: string;
  extraEarnings: string;
  extraDeductions: string;
  /** Valor pago ao funcionário. */
  total: string;
  /** Parte paga fora do holerite (nunca negativa). */
  offPayroll: string;
  /** Parte paga pelo holerite (total − por fora). */
  onPayroll: string;
  employerCost: string;
  /** Bruto do holerite (ou líquido, se não detalhado) + extras + encargos. */
  companyCost: string;
  detailed: boolean;
}

/** Calcula os totais de um lançamento. `typedNet` vale quando não há rubricas do holerite. */
export function payrollTotals(typedNet: string | null | undefined, lines: PayrollLineLike[], rubrics: PayrollRubricLike[] | Map<string, PayrollRubricLike>): PayrollTotals {
  const map = rubrics instanceof Map ? rubrics : new Map(rubrics.map((r) => [r.id, r]));
  let pe = 0, pd = 0, ee = 0, ed = 0, emp = 0, detailed = false;
  for (const l of lines) {
    const r = map.get(l.rubricId);
    if (!r) continue;
    const c = toCents(l.amount);
    if (r.section === 'payslip') { detailed = true; if (r.kind === 'deduction') pd += c; else pe += c; }
    else if (r.section === 'extra') { if (r.kind === 'deduction') ed += c; else ee += c; }
    else emp += c;
  }
  const net = detailed ? pe - pd : toCents(typedNet);
  const total = net + ee - ed;
  const off = Math.max(0, total - net);
  return {
    payslipEarnings: fromCents(pe), payslipDeductions: fromCents(pd), payslipNet: fromCents(net),
    extraEarnings: fromCents(ee), extraDeductions: fromCents(ed),
    total: fromCents(total), offPayroll: fromCents(off), onPayroll: fromCents(total - off),
    employerCost: fromCents(emp), companyCost: fromCents((detailed ? pe : net) + ee + emp), detailed,
  };
}

export const refLabelPT = (ref: string) => `${MONTHS_PT_SHORT[Number(ref.slice(5, 7)) - 1]}/${ref.slice(0, 4)}`;

/**
 * Data de pagamento padrão de uma competência. `payDay` 0 = 5º dia útil (segunda a sábado, sem
 * considerar feriados — a data pode ser ajustada no mês); 1–31 = dia fixo. `payMonth` = mês da
 * competência ('same') ou o seguinte ('next').
 */
export function defaultPayDate(ref: string, payDay: number, payMonth: 'same' | 'next'): string {
  let [y, m] = ref.split('-').map(Number);
  if (payMonth === 'next') { m += 1; if (m > 12) { m = 1; y += 1; } }
  if (payDay >= 1) return toISODate(y, m, Math.min(payDay, daysInMonth(y, m)));
  let n = 0;
  for (let d = 1; d <= daysInMonth(y, m); d++) {
    if (new Date(Date.UTC(y, m - 1, d)).getUTCDay() !== 0 && ++n === 5) return toISODate(y, m, d);
  }
  return toISODate(y, m, 5);
}

// ------------------------------------------------------------------ schemas
const ref = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Mês inválido (AAAA-MM)');
const optText = (max: number) => z.string().max(max).nullish().transform((v) => (v && v.trim() ? v.trim() : null));
const nonNeg = money.refine((v) => !v.startsWith('-'), 'Use valores positivos (a rubrica já diz se soma ou desconta)');

export const employeeSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome').max(120),
  document: documentSchema.optional(),
  role: optText(64),
  admissionDate: isoDate.nullish().or(z.literal('').transform(() => null)),
  terminationDate: isoDate.nullish().or(z.literal('').transform(() => null)),
  active: z.boolean().default(true),
  pixKey: optText(140),
  bankInfo: optText(255),
  notes: optText(1000),
});
export type EmployeeInput = z.infer<typeof employeeSchema>;

export const payrollRubricSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome').max(64),
  section: z.enum(PAYROLL_SECTIONS),
  kind: z.enum(PAYROLL_KINDS).default('earning'),
  /** Valor copiado para o mês seguinte ao abrir a folha (ex.: salário base, INSS). */
  fixed: z.boolean().default(false),
  active: z.boolean().default(true),
});

export const payrollSettingsSchema = z.object({
  categoryId: z.string().uuid('Escolha a categoria das contas de salário').nullish(),
  folderId: z.string().uuid().nullish(),
  payDay: z.number().int().min(0).max(31).default(0),
  payMonth: z.enum(['same', 'next']).default('next'),
  paymentMethod: optText(64),
});
export type PayrollSettings = z.infer<typeof payrollSettingsSchema>;

export const payrollLineSchema = z.object({
  rubricId: z.string().uuid(),
  amount: nonNeg,
  note: optText(120),
});

export const payrollEntrySchema = z.object({
  employeeId: z.string().uuid('Escolha o funcionário'),
  payslipNet: money.default('0'),
  lines: z.array(payrollLineSchema).max(60).default([]),
  notes: optText(1000),
});
export const payrollEntryCreateSchema = payrollEntrySchema.extend({ periodId: z.string().uuid() });

export const payrollPeriodCreateSchema = z.object({
  ref,
  payDate: isoDate,
  /** Cria os lançamentos dos funcionários ativos copiando o líquido e as rubricas fixas do último mês de cada um. */
  copyPrevious: z.boolean().default(true),
  notes: optText(1000),
});
export const payrollPeriodUpdateSchema = z.object({ payDate: isoDate, notes: optText(1000) });

// ------------------------------------------------------------------ importação da planilha
export interface PayrollImportLine { rubric: string; amount: string; note?: string | null }
export interface PayrollImportEntry { name: string; payslipNet: string; lines: PayrollImportLine[]; notes: string | null; sheetTotal: string | null }
export interface PayrollImportMonth { ref: string; label: string; row: number; entries: PayrollImportEntry[]; warnings: string[] }
export interface PayrollImportResult { months: PayrollImportMonth[]; warnings: string[]; skippedMonths: string[] }

export const payrollImportSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  months: z.array(z.object({
    ref,
    payDate: isoDate.nullish(),
    entries: z.array(z.object({
      name: z.string().trim().min(1).max(120),
      payslipNet: money,
      lines: z.array(z.object({ rubric: z.string().trim().min(1).max(64), amount: nonNeg, note: optText(120) })).max(40),
      notes: optText(1000),
    })).max(200),
  })).min(1, 'Nada para importar').max(600),
});

/** Rubricas padrão de todo espaço (criadas no 1º acesso à folha). */
export const DEFAULT_PAYROLL_RUBRICS: Array<{ name: string; section: PayrollSection; kind: PayrollKind; fixed?: boolean }> = [
  { name: 'Salário base', section: 'payslip', kind: 'earning', fixed: true },
  { name: 'Horas extras (holerite)', section: 'payslip', kind: 'earning' },
  { name: 'Adicionais (holerite)', section: 'payslip', kind: 'earning' },
  { name: 'INSS', section: 'payslip', kind: 'deduction', fixed: true },
  { name: 'IRRF', section: 'payslip', kind: 'deduction', fixed: true },
  { name: 'Vale-transporte', section: 'payslip', kind: 'deduction', fixed: true },
  { name: 'Adiantamento', section: 'payslip', kind: 'deduction' },
  { name: 'Meta global', section: 'extra', kind: 'earning' },
  { name: 'Meta individual', section: 'extra', kind: 'earning' },
  { name: 'Vitaminas', section: 'extra', kind: 'earning' },
  { name: 'Comissão', section: 'extra', kind: 'earning' },
  { name: 'Hora extra', section: 'extra', kind: 'earning' },
  { name: 'Outros proventos', section: 'extra', kind: 'earning' },
  { name: 'Desconto produtos/vale', section: 'extra', kind: 'deduction' },
  { name: 'Outros descontos', section: 'extra', kind: 'deduction' },
  { name: 'FGTS', section: 'employer', kind: 'earning', fixed: true },
];

type Cell = string | number | null;
const MONTH_NAMES = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const norm = (v: unknown) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
/** Chave para casar nomes ("ESTEVÃO" = "Estevão"). */
export const personKey = (v: string) => norm(v);
/** "EMERSON" → "Emerson"; "ana paula" → "Ana Paula". */
export function titleCaseName(v: string) {
  const small = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);
  return v.trim().toLowerCase().split(/\s+/).map((w, i) => (i > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
}
const num = (v: Cell): number | null => {
  if (v === null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const p = parseMoneyInput(v);
  return p === null ? null : toCents(p) / 100;
};
const centsOf = (v: Cell) => { const n = num(v); return n === null ? 0 : Math.round(n * 100); };

type ColRole = 'name' | 'ignored' | 'net' | 'total' | 'pay' | 'off' | { rubric: string; deduction: boolean };
function headerRole(h: string): ColRole | null {
  const t = norm(h);
  if (!t) return null;
  if (t.startsWith('funcionario') || t === 'nome') return 'name';
  if (t.includes('liquido')) return 'net';
  if (t.startsWith('total')) return 'total';
  if (t.includes('a pagar')) return 'pay';
  if (t.includes('por fora')) return 'off';
  if (t.includes('meta individual')) return { rubric: 'Meta individual', deduction: false };
  if (t.includes('meta')) return { rubric: 'Meta global', deduction: false };
  if (t.includes('vitamina')) return { rubric: 'Vitaminas', deduction: false };
  if (t.includes('comiss')) return { rubric: 'Comissão', deduction: false };
  if (t.includes('hora extra') || t.includes('horas extra')) return { rubric: 'Hora extra', deduction: false };
  if (t.includes('desconto') || t.includes('vale')) return { rubric: 'Desconto produtos/vale', deduction: true };
  return null;
}

/**
 * Lê a aba FOLHA: blocos "Mês Agosto" → cabeçalho → funcionários → TOTAL, um abaixo do outro.
 * O ano não está escrito: conta a partir de `startYear` e vira o ano quando o mês volta.
 * O total de cada funcionário fica igual ao "Salário a pagar" da planilha: diferenças (hora extra
 * somada à mão etc.) entram como "Outros proventos/descontos" com a anotação da linha.
 * Blocos de "Hora Extra" e anotações soltas que não somam no salário vão para as observações.
 */
export function parsePayrollSheet(rows: Cell[][], startYear: number): PayrollImportResult {
  const months: PayrollImportMonth[] = [];
  const warnings: string[] = [];
  let year = startYear, prevMonth = 0;
  let cur: PayrollImportMonth | null = null;
  let cols: ColRole[] | null = null;
  let mode: 'none' | 'employees' | 'overtime' = 'none';
  const byName = (name: string) => cur?.entries.find((e) => personKey(e.name) === personKey(name));

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] ?? [];
    const a = norm(r[0]);
    const mm = /^mes\s+(?:de\s+)?([a-z]+)/.exec(a);
    const mIdx = mm ? MONTH_NAMES.indexOf(mm[1]) : -1;
    if (mIdx >= 0) {
      const m = mIdx + 1;
      if (prevMonth && m <= prevMonth) year += 1;
      prevMonth = m;
      const refStr = `${year}-${String(m).padStart(2, '0')}`;
      cur = { ref: refStr, label: refLabelPT(refStr), row: i + 1, entries: [], warnings: [] };
      months.push(cur); cols = null; mode = 'none';
      continue;
    }
    if (!cur) continue;
    if (a.startsWith('funcionario')) {
      cols = r.map((h, ci) => (ci === 0 ? 'name' : headerRole(String(h ?? '')) ?? 'ignored'));
      const unknown = r.map((h, ci) => (ci > 0 && h && !headerRole(String(h)) ? String(h) : null)).filter(Boolean);
      if (unknown.length) cur.warnings.push(`Colunas ignoradas: ${unknown.join(', ')}`);
      mode = 'employees';
      continue;
    }
    if (a === 'hora extra' && norm(r[1]).startsWith('valor')) { mode = 'overtime'; continue; }
    if (a.startsWith('total')) { if (mode === 'employees') mode = 'none'; continue; }
    if (!a) continue;

    if (mode === 'overtime') {
      const e = byName(String(r[0]));
      const v = num(r[1] ?? null);
      const d = r[2];
      const when = d == null ? '' : typeof d === 'number' ? ` (${excelDateBR(d)})` : /^\d{4}-\d{2}-\d{2}$/.test(d) ? ` (${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)})` : ` (${d})`;
      const text = `Hora extra paga à parte: ${v === null ? String(r[1] ?? '') : fromCents(Math.round(v * 100)).replace('.', ',')}${when}`;
      if (e) e.notes = e.notes ? `${e.notes}\n${text}` : text;
      else cur.warnings.push(`Hora extra de "${String(r[0])}" sem funcionário no mês (linha ${i + 1})`);
      continue;
    }
    if (mode !== 'employees' || !cols) continue;

    const name = titleCaseName(String(r[0]));
    let net = 0, payCell: number | null = null;
    const lines: PayrollImportLine[] = [];
    let extras = 0;
    for (let c = 1; c < cols.length; c++) {
      const role = cols[c];
      if (role === 'net') net = centsOf(r[c] ?? null);
      else if (role === 'pay') payCell = num(r[c] ?? null);
      else if (typeof role === 'object' && role) {
        const v = centsOf(r[c] ?? null);
        if (!v) continue;
        // valor negativo numa coluna de provento vira desconto (e vice-versa)
        const deduction = role.deduction !== v < 0;
        const rubric = v < 0 ? (role.deduction ? 'Outros proventos' : 'Outros descontos') : role.rubric;
        lines.push({ rubric, amount: fromCents(Math.abs(v)) });
        extras += deduction ? -Math.abs(v) : Math.abs(v);
      }
    }
    // anotações soltas depois das colunas conhecidas (J, K…): números e textos
    const side = r.slice(cols.length).filter((v) => v !== null && v !== '');
    const sideText = side.map((v) => (typeof v === 'number' ? fromCents(Math.round(v * 100)).replace('.', ',') : String(v))).join(' ').trim();
    const notes: string[] = [];
    if (sideText) notes.push(`Planilha: ${sideText}`);

    if (!net && !extras && (payCell === null || payCell === 0)) {
      cur.warnings.push(`${name}: linha sem valores (ignorada)`);
      continue;
    }
    if (payCell === null) cur.warnings.push(`${name}: sem "Salário a pagar" na planilha — calculado pelos valores da linha`);
    else {
      const diff = Math.round(payCell * 100) - (net + extras);
      if (diff) {
        const label = /hora/i.test(sideText) ? 'hora extra' : sideText ? sideText.slice(0, 100) : 'diferença da planilha';
        lines.push({ rubric: diff > 0 ? 'Outros proventos' : 'Outros descontos', amount: fromCents(Math.abs(diff)), note: `Ajuste da importação (${label})`.slice(0, 120) });
      }
    }
    const existing = byName(name);
    if (existing) { cur.warnings.push(`${name} aparece duas vezes no mês — a 2ª linha foi ignorada`); continue; }
    cur.entries.push({ name, payslipNet: fromCents(net), lines, notes: notes.join('\n') || null, sheetTotal: payCell === null ? null : fromCents(Math.round(payCell * 100)) });
  }

  // meses faltando na sequência
  for (let k = 1; k < months.length; k++) {
    const [py, pm] = months[k - 1].ref.split('-').map(Number);
    const [y, m] = months[k].ref.split('-').map(Number);
    const gap = (y * 12 + m) - (py * 12 + pm) - 1;
    if (gap > 0) warnings.push(`${gap === 1 ? 'Falta 1 mês' : `Faltam ${gap} meses`} entre ${months[k - 1].label} e ${months[k].label}`);
  }
  const empty = months.filter((m) => !m.entries.length);
  return { months: months.filter((m) => m.entries.length), warnings, skippedMonths: empty.map((m) => m.label) };
}

/** Número de série do Excel → dd/mm/aaaa. */
function excelDateBR(n: number) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${d.getUTCFullYear()}`;
}

/** Ano do 1º bloco para que o último mês da planilha caia no mês passado (ou antes) de `today`. */
export function guessPayrollStartYear(rows: Cell[][], today: string): number {
  const ms: number[] = [];
  for (const r of rows) {
    const a = norm(r?.[0]);
    const mm = /^mes\s+(?:de\s+)?([a-z]+)/.exec(a);
    const idx = mm ? MONTH_NAMES.indexOf(mm[1]) : -1;
    if (idx >= 0) ms.push(idx + 1);
  }
  if (!ms.length) return Number(today.slice(0, 4));
  let wraps = 0;
  for (let k = 1; k < ms.length; k++) if (ms[k] <= ms[k - 1]) wraps++;
  const [ty, tm] = today.split('-').map(Number);
  const lastYear = ms[ms.length - 1] <= tm ? ty : ty - 1;
  return lastYear - wraps;
}
