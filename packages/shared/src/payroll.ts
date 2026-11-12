import { z } from 'zod';
import { money, isoDate, documentSchema } from './schemas.js';
import { fromCents, parseMoneyInput, toCents } from './money.js';
import { daysInMonth, toISODate, MONTHS_PT_SHORT } from './dates.js';
import { DEFAULT_PAYROLL_COMMISSIONS, payrollCommissionsSchema } from './commissions.js';
import { normBank } from './bank.js';
import { DEFAULT_PAYROLL_PAYSLIPS, payrollPayslipsSchema } from './payslips.js';

/**
 * Folha de pagamento (só em espaços do tipo Empresa).
 *
 * Cada mês (competência) tem um lançamento por funcionário. Valores:
 * - holerite: o líquido que vem do holerite do contador. Pode ser digitado direto ou detalhado em
 *   rubricas (salário, INSS, IRRF, VT…) — nesse caso o líquido é a soma delas, conferida com o
 *   valor líquido digitado do holerite (`payslipNetDeclared`): se não bater, não salva;
 * - extras (fora do holerite): metas, comissões, vitaminas, hora extra… (+) e descontos de
 *   produtos/vales (−);
 * - custos da empresa: calculados pela legislação sobre o bruto do holerite (FGTS 8%, INSS patronal
 *   conforme o regime tributário, reservas de 13º e férias + 1/3 com os encargos delas) + outros custos
 *   lançados (vale-alimentação, plano de saúde…). Não entram no valor pago ao funcionário.
 *   INSS/IRRF do holerite são do funcionário (descontados dele e só repassados pela empresa).
 *
 * A pagar = líquido do holerite + extras − descontos. "Por fora" = o que passa do holerite.
 */

export const PAYROLL_SECTIONS = ['payslip', 'extra', 'employer'] as const;
export type PayrollSection = (typeof PAYROLL_SECTIONS)[number];
export const PAYROLL_KINDS = ['earning', 'deduction'] as const;
export type PayrollKind = (typeof PAYROLL_KINDS)[number];

export const PAYROLL_SECTION_LABEL: Record<PayrollSection, string> = {
  payslip: 'Holerite', extra: 'Fora do holerite', employer: 'Outros custos da empresa',
};

/**
 * Regime tributário da empresa (decide o INSS patronal sobre a folha):
 * - simples: Simples Nacional anexos I, II, III e V — a contribuição patronal (CPP) já vem no DAS;
 * - simples_iv: Simples Nacional anexo IV (construção, vigilância, limpeza…) — 20% + RAT fora do DAS;
 * - normal: Lucro Presumido ou Real — 20% + RAT (1–3% × FAP) + terceiros (Sistema S, salário-educação…).
 */
export const PAYROLL_REGIMES = ['simples', 'simples_iv', 'normal'] as const;
export type PayrollRegime = (typeof PAYROLL_REGIMES)[number];
export const PAYROLL_REGIME_LABEL: Record<PayrollRegime, string> = {
  simples: 'Simples Nacional', simples_iv: 'Simples – Anexo IV', normal: 'Lucro Presumido ou Real',
};
/** FGTS: 8% da remuneração (Lei 8.036/90). */
export const FGTS_PCT = 8;
export const payrollCostsSchema = z.object({
  regime: z.enum(PAYROLL_REGIMES).default('simples'),
  /** RAT ajustado pelo FAP (%), só fora do Simples (ou anexo IV). */
  ratPct: z.number().min(0).max(6).default(2),
  /** Terceiros / outras entidades (%), só no Lucro Presumido/Real. */
  thirdPartyPct: z.number().min(0).max(10).default(5.8),
  /** Inclui as reservas mensais de 13º e férias + 1/3 no custo. */
  provisions: z.boolean().default(true),
});
export type PayrollCosts = z.infer<typeof payrollCostsSchema>;
export const DEFAULT_PAYROLL_COSTS: PayrollCosts = { regime: 'simples', ratPct: 2, thirdPartyPct: 5.8, provisions: true };

/** % de INSS patronal sobre a folha, pelo regime. */
export function employerInssPct(c: PayrollCosts): number {
  if (c.regime === 'simples') return 0;
  return Math.round((20 + c.ratPct + (c.regime === 'normal' ? c.thirdPartyPct : 0)) * 100) / 100;
}

export interface PayrollRubricLike { id: string; section: PayrollSection | string; kind: PayrollKind | string; /** false = provento sem FGTS, 13º e férias (pró-labore). */ laborCharges?: boolean | null }
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
  /** FGTS 8% sobre o bruto do holerite (só detalhado). */
  fgts: string;
  /** INSS patronal conforme o regime (0 no Simples). */
  employerInss: string;
  /** Outros custos lançados (rubricas da seção employer). */
  otherCosts: string;
  /** FGTS + INSS patronal + outros custos (desembolso do mês além do salário). */
  employerCost: string;
  /** Reservas do mês: 13º (1/12), férias + 1/3 (1/9) e FGTS/INSS sobre elas. */
  provision13: string;
  provisionVacation: string;
  provisionCharges: string;
  provisions: string;
  /** Bruto do holerite (ou líquido, se não detalhado) + extras + encargos + reservas. */
  companyCost: string;
  detailed: boolean;
}

/**
 * Conferência do holerite detalhado: o valor líquido digitado (do papel) contra o calculado pelas
 * rubricas. `diff` = digitado − calculado, em centavos (positivo = falta lançar provento).
 */
export function payslipCheck(declared: string | null | undefined, computedNet: string): { state: 'missing' | 'ok' | 'mismatch'; diff: number } {
  if (declared === null || declared === undefined || declared === '') return { state: 'missing', diff: 0 };
  const diff = toCents(declared) - toCents(computedNet);
  return { state: diff === 0 ? 'ok' : 'mismatch', diff };
}

/**
 * Calcula os totais de um lançamento. `typedNet` vale quando não há rubricas do holerite.
 * Os custos legais (FGTS, INSS patronal, reservas) só existem com o holerite detalhado, porque
 * dependem do bruto (total de vantagens).
 * `payslipOnly` (cadastro do funcionário): tem holerite, mas não recebe pela empresa — o holerite
 * fica registrado e o valor a pagar e os custos são zero.
 */
export function payrollTotals(
  typedNet: string | null | undefined, lines: PayrollLineLike[], rubrics: PayrollRubricLike[] | Map<string, PayrollRubricLike>,
  costs: PayrollCosts = DEFAULT_PAYROLL_COSTS, opts: { payslipOnly?: boolean } = {},
): PayrollTotals {
  const map = rubrics instanceof Map ? rubrics : new Map(rubrics.map((r) => [r.id, r]));
  let pe = 0, pd = 0, ee = 0, ed = 0, emp = 0, noCharges = 0, detailed = false;
  for (const l of lines) {
    const r = map.get(l.rubricId);
    if (!r) continue;
    const c = toCents(l.amount);
    if (r.section === 'payslip') { detailed = true; if (r.kind === 'deduction') pd += c; else { pe += c; if (r.laborCharges === false) noCharges += c; } }
    else if (r.section === 'extra') { if (r.kind === 'deduction') ed += c; else ee += c; }
    else emp += c;
  }
  const net = detailed ? pe - pd : toCents(typedNet);
  if (opts.payslipOnly) {
    // só holerite: o documento existe, mas a empresa não paga nada nem tem custo com ele
    const z = fromCents(0);
    return {
      payslipEarnings: fromCents(pe), payslipDeductions: fromCents(pd), payslipNet: fromCents(net), extraEarnings: fromCents(ee), extraDeductions: fromCents(ed),
      total: z, offPayroll: z, onPayroll: z, fgts: z, employerInss: z, otherCosts: z, employerCost: z,
      provision13: z, provisionVacation: z, provisionCharges: z, provisions: z, companyCost: z, detailed,
    };
  }
  const total = net + ee - ed;
  const off = Math.max(0, total - net);
  // pró-labore (rubrica sem encargos trabalhistas) não tem FGTS, 13º nem férias; o INSS patronal incide
  const base = detailed ? pe - noCharges : 0;
  const pct = (c: number, p: number) => Math.round((c * p) / 100);
  const inssPct = employerInssPct(costs);
  const fgts = pct(base, FGTS_PCT);
  const inss = pct(detailed ? pe : 0, inssPct);
  const p13 = costs.provisions ? Math.round(base / 12) : 0;
  const pVac = costs.provisions ? Math.round(base / 9) : 0; // 1/12 de férias + 1/3 constitucional
  const pCharges = pct(p13 + pVac, FGTS_PCT + inssPct);
  const employer = fgts + inss + emp;
  const provisions = p13 + pVac + pCharges;
  return {
    payslipEarnings: fromCents(pe), payslipDeductions: fromCents(pd), payslipNet: fromCents(net),
    extraEarnings: fromCents(ee), extraDeductions: fromCents(ed),
    total: fromCents(total), offPayroll: fromCents(off), onPayroll: fromCents(total - off),
    fgts: fromCents(fgts), employerInss: fromCents(inss), otherCosts: fromCents(emp), employerCost: fromCents(employer),
    provision13: fromCents(p13), provisionVacation: fromCents(pVac), provisionCharges: fromCents(pCharges), provisions: fromCents(provisions),
    companyCost: fromCents((detailed ? pe : net) + ee + employer + provisions), detailed,
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

/** Só os dígitos de um telefone brasileiro, sem o +55 (10 = fixo, 11 = celular). */
export function phoneDigitsBR(v: string): string {
  const d = v.replace(/\D/g, '');
  return (d.length === 12 || d.length === 13) && d.startsWith('55') ? d.slice(2) : d;
}
/** "11912345678" → "(11) 91234-5678"; "1133334444" → "(11) 3333-4444"; outro tamanho fica como digitado. */
export function formatPhoneBR(v: string): string {
  const d = phoneDigitsBR(v);
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return v.trim();
}
/** Link do WhatsApp (wa.me) para um telefone brasileiro; null se não for um número completo. */
export function whatsappLink(v: string | null | undefined): string | null {
  const d = phoneDigitsBR(v ?? '');
  return d.length === 10 || d.length === 11 ? `https://wa.me/55${d}` : null;
}
const phoneSchema = z.string().max(32).nullish().transform((v, ctx) => {
  if (!v || !v.trim()) return null;
  const d = phoneDigitsBR(v);
  if (d.length !== 10 && d.length !== 11) {
    ctx.addIssue({ code: 'custom', message: 'Telefone incompleto: use DDD + número, ex.: (11) 91234-5678' });
    return z.NEVER;
  }
  return formatPhoneBR(v);
});

export const EMPLOYEE_ACCOUNT_KINDS = ['checking', 'savings', 'salary', 'payment'] as const;
export type EmployeeAccountKind = (typeof EMPLOYEE_ACCOUNT_KINDS)[number];
export const EMPLOYEE_ACCOUNT_KIND_LABEL: Record<EmployeeAccountKind, string> = { checking: 'Corrente', savings: 'Poupança', salary: 'Salário', payment: 'Pagamento' };

export const employeeSchema = z.object({
  name: z.string().trim().min(1, 'Informe o nome').max(120),
  document: documentSchema.optional(),
  role: optText(64),
  admissionDate: isoDate.nullish().or(z.literal('').transform(() => null)),
  terminationDate: isoDate.nullish().or(z.literal('').transform(() => null)),
  active: z.boolean().default(true),
  pixKey: optText(140),
  phone: phoneSchema,
  /** Código do vendedor no relatório de vendas (comissões). Vazio = não recebe comissão. */
  sellerCode: z.string().max(20).nullish().transform((v) => (v && v.trim() ? v.trim() : null)),
  /** Matrícula no holerite do contador (liga o holerite importado ao funcionário). */
  payslipCode: z.string().max(20).nullish().transform((v) => (v && v.trim() ? v.trim() : null)),
  /** Tem holerite, mas não recebe pela empresa (sócio que não trabalha, acordo…): a pagar e custo ficam zerados. */
  payslipOnly: z.boolean().default(false),
  /** Conta do funcionário: código do banco (3 dígitos), agência, conta e tipo. */
  bankCode: optText(8).transform((v) => (v ? normBank(v) : null)),
  bankBranch: optText(20),
  bankAccount: optText(30),
  bankAccountKind: z.enum(EMPLOYEE_ACCOUNT_KINDS).nullish().or(z.literal('').transform(() => null)).transform((v) => v ?? null),
  /** Anotação livre antiga ("Banco / agência / conta" num campo só); os campos acima a substituem. */
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
  /** Provento do holerite que conta para FGTS, 13º e férias. Desligado para pró-labore. */
  laborCharges: z.boolean().default(true),
});

/**
 * Colunas escondidas na impressão da folha: chaves fixas (PAYROLL_PRINT_FIXED) ou ids de rubricas
 * "fora do holerite". Extra escondido com valor no mês vai para a coluna "Outros extras".
 * `order` = ordem das colunas depois de "Funcionário" (mesmas chaves); coluna que não estiver na
 * lista entra logo depois da vizinha da ordem padrão (`printColumnOrder`).
 */
export const payrollPrintSchema = z.object({
  hidden: z.array(z.string().max(40)).max(100).default([]),
  order: z.array(z.string().max(40)).max(200).default([]),
});
export type PayrollPrintSettings = z.infer<typeof payrollPrintSchema>;

/**
 * Aplica a ordem salva às colunas do mês (`defaults` = ordem padrão). Chave nova (ex.: extra que
 * não estava na lista) entra logo depois da coluna que a antecede em `defaults`.
 */
export function printColumnOrder(defaults: string[], saved: string[]): string[] {
  const out = saved.filter((k, i) => defaults.includes(k) && saved.indexOf(k) === i);
  defaults.forEach((k, i) => {
    if (out.includes(k)) return;
    let pos = 0;
    for (let j = i - 1; j >= 0; j--) { const p = out.indexOf(defaults[j]!); if (p >= 0) { pos = p + 1; break; } }
    out.splice(pos, 0, k);
  });
  return out;
}

/** Ordem para salvar: a nova ordem das colunas do mês + as salvas que não apareceram, no lugar de antes. */
export function mergePrintOrder(saved: string[], current: string[]): string[] {
  return printColumnOrder([...saved, ...current.filter((k) => !saved.includes(k))], current);
}
export const PAYROLL_PRINT_FIXED = [
  { key: 'net', label: 'Líquido holerite' }, { key: 'gross', label: 'Total salário' }, { key: 'deductions', label: 'Descontos' },
  { key: 'total', label: 'Salário a pagar' }, { key: 'off', label: 'Por fora' },
] as const;

/** Nova ordem das rubricas (ids na ordem desejada; as que faltarem vão para o fim). */
export const payrollRubricOrderSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(300) });

export const payrollSettingsSchema = z.object({
  categoryId: z.string().uuid('Escolha a categoria das contas de salário').nullish(),
  folderId: z.string().uuid().nullish(),
  payDay: z.number().int().min(0).max(31).default(0),
  payMonth: z.enum(['same', 'next']).default('next'),
  paymentMethod: optText(64),
  costs: payrollCostsSchema.default(DEFAULT_PAYROLL_COSTS),
  print: payrollPrintSchema.default({ hidden: [], order: [] }),
  commissions: payrollCommissionsSchema.default(DEFAULT_PAYROLL_COMMISSIONS),
  payslips: payrollPayslipsSchema.default(DEFAULT_PAYROLL_PAYSLIPS),
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
  /** Holerite detalhado: valor líquido do holerite, para conferir com as rubricas (vazio = sem conferência). */
  payslipNetDeclared: money.nullish().or(z.literal('').transform(() => null)),
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
  })).min(1, 'Nada para importar').max(240, 'No máximo 240 meses por importação'),
});

/** Rubricas padrão de todo espaço (criadas no 1º acesso à folha). */
export const DEFAULT_PAYROLL_RUBRICS: Array<{ name: string; section: PayrollSection; kind: PayrollKind; fixed?: boolean }> = [
  { name: 'Salário base', section: 'payslip', kind: 'earning', fixed: true },
  { name: 'Diferença salarial', section: 'payslip', kind: 'earning' },
  { name: 'Horas extras (holerite)', section: 'payslip', kind: 'earning' },
  { name: 'Periculosidade', section: 'payslip', kind: 'earning' },
  { name: 'Adicionais (holerite)', section: 'payslip', kind: 'earning' },
  { name: 'INSS', section: 'payslip', kind: 'deduction', fixed: true },
  { name: 'IRRF', section: 'payslip', kind: 'deduction', fixed: true },
  { name: 'Vale-transporte', section: 'payslip', kind: 'deduction', fixed: true },
  { name: 'Adiantamento', section: 'payslip', kind: 'deduction' },
  { name: 'Empréstimo consignado', section: 'payslip', kind: 'deduction' },
  { name: 'Meta global', section: 'extra', kind: 'earning' },
  { name: 'Meta individual', section: 'extra', kind: 'earning' },
  { name: 'Vitaminas', section: 'extra', kind: 'earning' },
  { name: 'Comissão', section: 'extra', kind: 'earning' },
  { name: 'Hora extra', section: 'extra', kind: 'earning' },
  { name: 'Outros proventos', section: 'extra', kind: 'earning' },
  { name: 'Desconto produtos/vale', section: 'extra', kind: 'deduction' },
  { name: 'Outros descontos', section: 'extra', kind: 'deduction' },
  { name: 'Vale-alimentação', section: 'employer', kind: 'earning', fixed: true },
  { name: 'Vale-transporte (parte da empresa)', section: 'employer', kind: 'earning', fixed: true },
];

type Cell = string | number | null;
const MONTH_NAMES = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const norm = (v: unknown) => String(v ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
/** Chave para casar nomes ("ESTEVÃO" = "Estevão"). */
export const personKey = (v: string) => norm(v);
/** "JOÃO" → "João"; "ana paula" → "Ana Paula". */
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
