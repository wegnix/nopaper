import { z } from 'zod';
import { money, isoDate } from './schemas.js';
import { fromCents, toCents } from './money.js';
import type { PayrollKind } from './payroll.js';

// (cópias locais: payroll.ts importa este módulo, então aqui só entra o tipo dele)
const personKey = (v: unknown) => String(v ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const titleCaseName = (v: string) => {
  const small = new Set(['da', 'de', 'do', 'das', 'dos', 'e']);
  return v.trim().toLowerCase().split(/\s+/).map((w, i) => (i > 0 && small.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
};

/**
 * Holerites do contador (PDF "Recibo/Demonstrativo de Pagamento de Salário", um ou mais por página,
 * normalmente em duas vias). O servidor só devolve os textos com a posição (`pdfToCells`); aqui as
 * colunas Vencimentos/Descontos são separadas pela posição do valor e cada holerite é conferido com
 * os totais impressos nele.
 *
 * Cada linha do holerite vira uma rubrica da seção "Holerite" do lançamento; o "Valor Líquido"
 * vira o líquido de conferência (`payslipNetDeclared`). A ligação holerite → funcionário é a
 * matrícula (`employees.payslip_code`) e a de linha → rubrica fica em `org_settings.payroll.payslips.map`.
 */

/** Texto do PDF com a posição horizontal (x = começo, w = largura). */
export interface PdfCell { x: number; w: number; s: string }

export interface PayslipItem {
  /** Chave estável da linha: o código do contador ("c:927") ou, sem código, o nome ("n:inss"). */
  key: string;
  code: string | null;
  name: string;
  /** Coluna "Ref." (30D, 14,00H, 10,2%…). */
  ref: string | null;
  kind: PayrollKind;
  amount: string;
}
export interface Payslip {
  /** Matrícula. */
  code: string;
  name: string;
  /** "Salário", "Pro-labore"… (do título "Recibo de Pagamento de …"). */
  title: string;
  role: string | null;
  department: string | null;
  admissionDate: string | null;
  /** CPF, quando o holerite traz. */
  document: string | null;
  items: PayslipItem[];
  totalEarnings: string;
  totalDeductions: string;
  net: string;
  fgts: string | null;
  warnings: string[];
}
export interface PayslipReport {
  company: string | null;
  /** Competência (AAAA-MM). */
  ref: string | null;
  slips: Payslip[];
  warnings: string[];
}

const MONEY_RE = /^\d{1,3}(?:\.\d{3})*,\d{2}$/;
const DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const MONTHS = ['janeiro', 'fevereiro', 'marco', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
const brMoney = (s: string) => fromCents(toCents(s.replace(/\./g, '').replace(',', '.')));
const isMoney = (c: PdfCell) => MONEY_RE.test(c.s);
const center = (c: PdfCell) => c.x + c.w / 2;
const join = (cells: PdfCell[]) => cells.map((c) => c.s).join(' ').replace(/\s+/g, ' ').trim();

/** Chave de uma linha do holerite (código do contador ou nome sem acento/pontuação). */
export function payslipItemKey(code: string | null, name: string) {
  return code ? `c:${code}` : `n:${personKey(name).replace(/[^a-z0-9]+/g, ' ').trim().replace(/ /g, '-')}`;
}

/**
 * Lê os holerites das linhas posicionadas do PDF. Vias repetidas do mesmo holerite contam uma vez.
 * Layouts conhecidos (os dois têm os mesmos blocos, com títulos diferentes):
 * - "Recibo de Pagamento de Salário/Pro-labore": Matricula/Nome, Código/Nomenclatura/Ref./Vencimentos/Descontos,
 *   "Total de Vantagens" + valores na linha de baixo, "Valor Líquido", "F.G.T.S"; linha sem código vale (I.N.S.S.);
 * - "Demonstrativo de Pagamento de Salário": Cadastro/Nome do Funcionário, Ev/Descrição/Referência/Proventos/Descontos,
 *   "Total" com os valores na mesma linha, "Total Líquido", "FGTS Mês", CPF no cabeçalho; linha sem
 *   código é detalhe da anterior (contratos do consignado) e não entra.
 */
export function parsePayslips(rows: PdfCell[][]): PayslipReport {
  const out: PayslipReport = { company: null, ref: null, slips: [], warnings: [] };
  const all: Payslip[] = [];
  let cur: Payslip | null = null;
  let state: 'head' | 'person' | 'role' | 'items' | 'totals' | 'net' | 'bases' | 'done' = 'done';
  /** Limites das colunas (pela posição dos títulos). */
  let nameLimit = 326, refX = 290, split = 410, earnX = 346;
  let fgtsX: number | null = null;
  /** Só linhas com código são rubricas (as sem código detalham a anterior). */
  let codedOnly = false;
  const setTotals = (ms: PdfCell[]) => {
    const e = ms.find((c) => center(c) < split), d = ms.find((c) => center(c) >= split);
    if (e) cur!.totalEarnings = brMoney(e.s);
    if (d) cur!.totalDeductions = brMoney(d.s);
  };

  for (const raw of rows) {
    const row = [...raw].filter((c) => c.s.trim()).sort((a, b) => a.x - b.x);
    if (!row.length) continue;
    const text = join(row);
    const ntext = personKey(text);

    const title = row.find((c) => /(recibo|demonstrativo) de pagamento/i.test(c.s));
    if (title) {
      cur = {
        code: '', name: '', title: title.s.replace(/^.*(recibo|demonstrativo) de pagamento\s*(de\s+)?/i, '').trim() || 'Salário', role: null, department: null,
        admissionDate: null, document: null, items: [], totalEarnings: '0.00', totalDeductions: '0.00', net: '0.00', fgts: null, warnings: [],
      };
      all.push(cur);
      state = 'head';
      fgtsX = null;
      codedOnly = /demonstrativo/i.test(title.s);
      const comp = row.find((c) => c !== title && /^\d+\s*-\s*\S/.test(c.s));
      if (comp && !out.company) out.company = comp.s.replace(/^\d+\s*-\s*/, '').trim();
      continue;
    }
    if (!cur) continue;

    if (state === 'head') {
      if (!out.ref) {
        const m = /(janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\s*(?:\/|de)\s*(\d{4})/.exec(ntext);
        const n = row.map((c) => /^(0[1-9]|1[0-2])\/(\d{4})$/.exec(c.s)).find(Boolean);
        if (m) out.ref = `${m[2]}-${String(MONTHS.indexOf(m[1]!) + 1).padStart(2, '0')}`;
        else if (n) out.ref = `${n[2]}-${n[1]}`;
      }
      const cpf = /cpf:?\s*(\d{3}\.?\d{3}\.?\d{3}-?\d{2})/i.exec(text);
      if (cpf) cur.document = cpf[1]!;
      if (ntext.startsWith('matricula') || ntext.startsWith('cadastro')) {
        // a coluna depois de "Nome" marca onde o nome acaba
        const nameCell = row.find((c) => personKey(c.s).startsWith('nome'));
        const next = nameCell ? row.find((c) => c.x > nameCell.x) : null;
        if (next) nameLimit = next.x - 15;
        state = 'person';
      }
      continue;
    }
    if (state === 'person') {
      const date = row.find((c) => DATE_RE.test(c.s));
      const first = row[0]!;
      if (/^\d+$/.test(first.s)) cur.code = first.s;
      cur.name = join(row.filter((c) => !(c === first && cur!.code) && c !== date && c.x < nameLimit));
      const dm = date ? DATE_RE.exec(date.s) : null;
      if (dm) cur.admissionDate = `${dm[3]}-${dm[2]}-${dm[1]}`;
      state = 'role';
      continue;
    }
    if ((ntext.includes('vencimentos') || ntext.includes('proventos')) && ntext.includes('descontos')) {
      const venc = row.find((c) => ['vencimentos', 'proventos'].includes(personKey(c.s))), desc = row.find((c) => personKey(c.s) === 'descontos');
      const rf = row.find((c) => /^ref(\.|er[eê]ncia)?$/i.test(c.s));
      if (venc && desc) { split = (center(venc) + center(desc)) / 2; earnX = venc.x; }
      if (rf) refX = rf.x;
      state = 'items';
      continue;
    }
    if (state === 'role') {
      // cargo (e, conforme o layout, "Função:", o departamento ou a data de admissão na mesma linha)
      const date = row.find((c) => DATE_RE.test(c.s));
      const dm = date ? DATE_RE.exec(date.s) : null;
      if (dm && !cur.admissionDate) cur.admissionDate = `${dm[3]}-${dm[2]}-${dm[1]}`;
      const cells = row.filter((c) => c !== date && !/^fun[cç][aã]o:?$/i.test(c.s) && !/admiss/i.test(c.s));
      const role = join(cells.filter((c) => c.x < nameLimit)), dept = join(cells.filter((c) => c.x >= nameLimit));
      if (role) cur.role = role;
      if (dept) cur.department = dept;
      continue;
    }
    if (state === 'items' || state === 'totals') {
      const totalCell = row.find((c) => /^total( de (vantagens|vencimentos|proventos))?$/.test(personKey(c.s)));
      if (totalCell || state === 'totals') {
        const ms = row.filter(isMoney);
        if (ms.length) { setTotals(ms); state = 'net'; } else state = 'totals';
        continue;
      }
    }
    if (state === 'items') {
      const amounts = row.filter((c) => isMoney(c) && c.x + c.w > earnX);
      if (!amounts.length) continue;
      const first = row[0]!;
      const code = /^\d+$/.test(first.s) && !amounts.includes(first) && first.x < refX - 100 ? first.s : null;
      if (codedOnly && !code) continue;
      const rest = row.filter((c) => !amounts.includes(c) && !(code && c === first));
      const refCells = rest.filter((c) => c.x >= refX - 35 && /\d/.test(c.s));
      const name = join(rest.filter((c) => !refCells.includes(c)));
      if (!name) continue;
      for (const a of amounts) {
        cur.items.push({ key: payslipItemKey(code, name), code, name, ref: join(refCells) || null, kind: center(a) < split ? 'earning' : 'deduction', amount: brMoney(a.s) });
      }
      continue;
    }
    if (state === 'net') {
      // "Valor Líquido" / "Total Líquido" + valor (na mesma linha ou na seguinte)
      const m = row.filter(isMoney).at(-1);
      if (m) { cur.net = brMoney(m.s); state = 'bases'; }
      continue;
    }
    if (state === 'bases') {
      // títulos das bases: o FGTS do mês é a coluna "F.G.T.S" / "FGTS Mês" (o valor vem na linha de baixo)
      const label = row.find((c) => /^f\.?g\.?t\.?s\.?( m[eê]s)?$/i.test(c.s));
      if (label) { fgtsX = center(label); continue; }
      const ms = row.filter(isMoney);
      if (!ms.length || fgtsX === null) continue;
      const fx = fgtsX;
      const near = [...ms].sort((a, b) => Math.abs(center(a) - fx) - Math.abs(center(b) - fx))[0]!;
      if (Math.abs(center(near) - fx) < 25) cur.fgts = brMoney(near.s);
      fgtsX = null;
      state = 'done';
      continue;
    }
  }

  // confere cada holerite e tira as vias repetidas
  const seen = new Map<string, string>();
  for (const s of all) {
    if (!s.code || !s.name) continue;
    const sig = JSON.stringify([s.title, s.items.map((i) => [i.key, i.kind, i.amount]), s.net]);
    if (seen.has(s.code)) {
      if (seen.get(s.code) !== sig) out.warnings.push(`${titleCaseName(s.name)} (matrícula ${s.code}) tem mais de um recibo diferente neste PDF — só o primeiro foi lido.`);
      continue;
    }
    seen.set(s.code, sig);
    const e = s.items.filter((i) => i.kind === 'earning').reduce((a, i) => a + toCents(i.amount), 0);
    const d = s.items.filter((i) => i.kind === 'deduction').reduce((a, i) => a + toCents(i.amount), 0);
    if (!s.items.length) s.warnings.push('Não achei as linhas deste holerite.');
    else if (e !== toCents(s.totalEarnings) || d !== toCents(s.totalDeductions) || e - d !== toCents(s.net)) {
      s.warnings.push('As linhas lidas não fecham com os totais impressos no holerite. Confira este holerite à mão.');
    }
    out.slips.push(s);
  }
  out.slips.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return out;
}

/** O holerite fecha com os próprios totais (pode ser lançado). */
export const payslipOk = (s: Payslip) => !s.warnings.length;

// ------------------------------------------------------------------ rubricas
/** Nomes do contador → nome da rubrica no NoPaper (o 1º trecho que casar vale). */
const RUBRIC_ALIASES: Array<[RegExp, string]> = [
  [/pro.?labore/, 'Pró-labore'],
  [/diferenca salarial/, 'Diferença salarial'],
  [/salario.familia/, 'Salário-família'],
  [/13|decimo terceiro/, '13º salário'],
  [/ferias/, 'Férias'],
  [/^salario/, 'Salário base'],
  [/horas? extras?/, 'Horas extras (holerite)'],
  [/periculosidade/, 'Periculosidade'],
  [/insalubridade/, 'Insalubridade'],
  [/adicional noturno/, 'Adicional noturno'],
  [/d\.?s\.?r|descanso semanal/, 'DSR'],
  [/consignado|credito do trabalhador/, 'Empréstimo consignado'],
  [/sobre ?aviso/, 'Sobreaviso'],
  [/i\.?n\.?s\.?s/, 'INSS'],
  [/i\.?r\.?r\.?f|imposto de renda/, 'IRRF'],
  [/vale.transporte/, 'Vale-transporte'],
  [/adiantamento/, 'Adiantamento'],
  [/faltas?/, 'Faltas'],
  [/pensao/, 'Pensão alimentícia'],
  [/plano de saude|assistencia medica/, 'Plano de saúde'],
];

/** Nome sugerido para a rubrica de uma linha do holerite ("DIFERENCA SALARIAL" → "Diferença salarial"). */
export function payslipRubricName(item: { name: string }): string {
  const n = personKey(item.name);
  for (const [re, label] of RUBRIC_ALIASES) if (re.test(n)) return label;
  const t = item.name.trim().toLowerCase();
  return (t.charAt(0).toUpperCase() + t.slice(1)).slice(0, 64);
}

/**
 * Rubrica do holerite para uma linha: a ligação salva (`map`), senão a de mesmo nome sugerido.
 * Só vale rubrica da seção Holerite e do mesmo tipo (provento/desconto).
 */
export function payslipRubricFor<R extends { id: string; name: string; section: string; kind: string }>(
  item: { key: string; name: string; kind: PayrollKind }, rubrics: R[], map: Record<string, string> = {},
): R | null {
  const ok = (r: R | undefined) => (r && r.section === 'payslip' && r.kind === item.kind ? r : null);
  const saved = ok(rubrics.find((r) => r.id === map[item.key]));
  if (saved) return saved;
  const want = personKey(payslipRubricName(item));
  return ok(rubrics.find((r) => r.section === 'payslip' && r.kind === item.kind && personKey(r.name) === want));
}

/** Funcionário sugerido pelo nome do holerite ("ANA EXEMPLO DA SILVA" → "Ana"); só se for o único. */
export function payslipEmployeeFor<E extends { id: string; name: string; payslipCode?: string | null }>(slip: { code: string; name: string }, employees: E[]): { employee: E; by: 'code' | 'name' } | null {
  const byCode = employees.find((e) => e.payslipCode === slip.code);
  if (byCode) return { employee: byCode, by: 'code' };
  const b = personKey(slip.name);
  const m = employees.filter((e) => !e.payslipCode && (() => { const a = personKey(e.name); return a === b || b.startsWith(`${a} `); })());
  return m.length === 1 ? { employee: m[0]!, by: 'name' } : null;
}

// ------------------------------------------------------------------ configuração e envio
/** Nota da linha "por fora" que guarda a diferença entre o combinado e o holerite (reimportar troca essa linha). */
export const PAYSLIP_ADJUST_NOTE = 'Diferença entre o combinado e o holerite';

export const payrollPayslipsSchema = z.object({
  /** Linha do holerite (chave) → rubrica. */
  map: z.record(z.string().max(90), z.string().uuid()).default({}),
});
export type PayrollPayslipsSettings = z.infer<typeof payrollPayslipsSchema>;
export const DEFAULT_PAYROLL_PAYSLIPS: PayrollPayslipsSettings = { map: {} };

const amount = money.refine((v) => !v.startsWith('-'), 'Valor inválido');
const text = (max: number) => z.string().max(max).nullish().transform((v) => (v && v.trim() ? v.trim() : null));

export const payrollPayslipApplySchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  slips: z.array(z.object({
    code: z.string().trim().min(1).max(20),
    name: z.string().trim().min(1).max(120),
    net: amount,
    items: z.array(z.object({
      key: z.string().trim().min(1).max(90), name: z.string().trim().min(1).max(80), ref: text(24), kind: z.enum(['earning', 'deduction']), amount,
    })).min(1).max(60),
    /** Funcionário que recebe este holerite; vazio + `create` = cadastra agora. */
    employeeId: z.string().uuid().nullish(),
    create: z.object({
      name: z.string().trim().min(1).max(120), role: text(64), admissionDate: isoDate.nullish(), document: text(20),
      /** Tem holerite, mas não recebe pela empresa (sócio que não trabalha, acordo…). */
      payslipOnly: z.boolean().default(false),
    }).nullish(),
    /**
     * Líquido combinado, quando a pessoa recebe um valor diferente do holerite (ex.: sócia com pró-labore
     * que recebe como funcionária): a diferença entra por fora (extra ou desconto) com a nota
     * PAYSLIP_ADJUST_NOTE. Igual ao líquido = sem diferença. Vazio = não mexe na diferença que já existir.
     */
    agreedNet: amount.nullish(),
  }).refine((s) => !!s.employeeId !== !!s.create, 'Escolha o funcionário de cada holerite')).min(1, 'Nenhum holerite para lançar').max(300),
  /** Escolhas de rubrica feitas na prévia (o que não vier usa a ligação já salva). */
  rubrics: z.array(z.object({
    key: z.string().trim().min(1).max(90),
    rubricId: z.string().uuid().nullish(),
    /** Cria a rubrica (seção Holerite) com este nome. */
    createName: z.string().trim().min(1).max(64).nullish(),
  }).refine((r) => !!r.rubricId !== !!r.createName, 'Escolha a rubrica')).max(200).default([]),
  /** Rubricas "fora do holerite" que recebem a diferença de quem mantém o valor a pagar. */
  adjustEarningId: z.string().uuid().nullish(),
  adjustDeductionId: z.string().uuid().nullish(),
});
export type PayrollPayslipApply = z.infer<typeof payrollPayslipApplySchema>;

/** Rubrica de pró-labore: sócio não tem FGTS, 13º nem férias (não entra na base desses custos). */
export const isProLabore = (name: string) => /pro.?labore/.test(personKey(name));
