import { z } from 'zod';
import { money, isoDate } from './schemas.js';
import { fromCents, toCents } from './money.js';

/**
 * Comissões da folha a partir do relatório de vendas do sistema da loja ("Vendas Vendedor e Grupo
 * Produtos", totais por vendedor e grupo de produtos).
 *
 * O servidor só lê o PDF e monta as linhas pela posição do texto (`pdfToRows`); a leitura das
 * linhas e o cálculo ficam aqui, iguais na prévia (front) e ao aplicar (API).
 *
 * Regras (configuráveis no espaço): cada regra junta grupos de produtos (pelo código do relatório)
 * e paga um % sobre o "Valor de vendas" ou um valor por unidade ("Quantidade"), com faixas de meta
 * opcionais (ex.: 30 unidades ou mais → R$ 5 por unidade, para todas). O valor vai para uma rubrica
 * "fora do holerite" do lançamento de cada vendedor ligado a um funcionário (`employees.seller_code`).
 */

// ------------------------------------------------------------------ relatório
export interface SalesGroup { code: string; name: string; quantity: number; sales: string }
export interface SalesSeller { code: string; name: string; groups: SalesGroup[] }
export interface SalesReport {
  company: string | null;
  /** Período do relatório (AAAA-MM-DD). */
  from: string | null;
  to: string | null;
  sellers: SalesSeller[];
  warnings: string[];
}

const DEC = /^-?\d{1,3}(?:\.\d{3})*,\d{2}$|^-?\d+,\d{2}$/;
/** "1.234,56" → centavos. */
const decCents = (s: string) => {
  const neg = s.startsWith('-');
  const [i, d] = s.replace('-', '').replace(/\./g, '').split(',');
  const c = Number(i) * 100 + Number(d);
  return neg ? -c : c;
};
/** "1.223" → 1223; "1,5" → 1.5 (venda fracionada). */
const qtyOf = (s: string) => Number(s.replace(/\./g, '').replace(',', '.'));
const QTY = /^-?\d{1,3}(?:\.\d{3})*(?:,\d+)?$|^-?\d+(?:,\d+)?$/;
const shortYear = (y: string) => (y.length === 2 ? `20${y}` : y);

/**
 * Lê as linhas do relatório (cada linha = textos na ordem da esquerda para a direita).
 * Colunas depois da quantidade: desconto, custo, vendas, % part., margem, valor médio de desconto,
 * % médio de desconto, valor médio de vendas, % rentabilidade.
 */
export function parseSalesReport(rows: string[][]): SalesReport {
  const out: SalesReport = { company: null, from: null, to: null, sellers: [], warnings: [] };
  let cur: SalesSeller | null = null;
  let sawTitle = false;
  const totals = new Map<string, { qty: number; sales: number }>();
  const check = (seller: SalesSeller, qty: number, salesCents: number) => {
    const q = seller.groups.reduce((a, g) => a + g.quantity, 0);
    const s = seller.groups.reduce((a, g) => a + toCents(g.sales), 0);
    if (Math.abs(q - qty) > 0.001 || s !== salesCents) {
      out.warnings.push(`${seller.name}: a soma dos grupos (${fmtQty(q)} un · ${fmtMoney(s)}) não bate com o total do vendedor no relatório (${fmtQty(qty)} un · ${fmtMoney(salesCents)}). Confira o arquivo.`);
    }
  };
  for (const raw of rows) {
    const cells = raw.map((c) => c.trim()).filter(Boolean);
    const line = cells.join(' ').replace(/\s+/g, ' ');
    if (!line) continue;
    if (/vendas vendedor e grupo produtos/i.test(line)) sawTitle = true;
    if (!out.company && / - /.test(line) && /\bData:/.test(line)) out.company = line.replace(/\s*Data:.*$/, '').trim() || null;
    const per = /Sele[çc][ãa]o Per[íi]odo:\s*(\d{2})\/(\d{2})\/(\d{2,4})\s*A\s*(\d{2})\/(\d{2})\/(\d{2,4})/i.exec(line);
    if (per) {
      out.from = `${shortYear(per[3])}-${per[2]}-${per[1]}`;
      out.to = `${shortYear(per[6])}-${per[5]}-${per[4]}`;
      continue;
    }
    const v = /^Vendedor:\s*(\S+)\s+(.+)$/i.exec(line);
    if (v) {
      cur = { code: v[1], name: v[2].trim(), groups: [] };
      out.sellers.push(cur);
      continue;
    }
    const tokens = line.split(' ');
    const tv = /^Total Vendedor:$/i.test(tokens.slice(0, 2).join(' '));
    if (tv && cur) {
      const nums = tokens.slice(2);
      if (nums.length >= 4 && QTY.test(nums[0]) && DEC.test(nums[3])) {
        const t = totals.get(cur.code) ?? { qty: 0, sales: 0 };
        totals.set(cur.code, { qty: t.qty + qtyOf(nums[0]), sales: t.sales + decCents(nums[3]) });
      }
      continue;
    }
    // linha de grupo: código, nome (pode ter espaços), quantidade e 9 colunas com centavos
    if (!cur || tokens.length < 12 || !/^\d+$/.test(tokens[0])) continue;
    const tail = tokens.slice(-9);
    const qty = tokens[tokens.length - 10];
    const name = tokens.slice(1, -10).join(' ');
    if (!name || !QTY.test(qty) || !tail.every((t) => DEC.test(t))) continue;
    const g = { code: tokens[0], name, quantity: qtyOf(qty), sales: fromCents(decCents(tail[2])) };
    const same = cur.groups.find((x) => x.code === g.code);
    if (same) { same.quantity += g.quantity; same.sales = fromCents(toCents(same.sales) + toCents(g.sales)); } else cur.groups.push(g);
  }
  // vendedores repetidos (relatório quebrado em páginas) viram um só
  const merged: SalesSeller[] = [];
  for (const s of out.sellers) {
    const m = merged.find((x) => x.code === s.code);
    if (!m) { merged.push(s); continue; }
    for (const g of s.groups) {
      const same = m.groups.find((x) => x.code === g.code);
      if (same) { same.quantity += g.quantity; same.sales = fromCents(toCents(same.sales) + toCents(g.sales)); } else m.groups.push(g);
    }
  }
  out.sellers = merged.filter((s) => s.groups.length);
  for (const s of out.sellers) {
    const t = totals.get(s.code);
    if (t) check(s, t.qty, t.sales); else out.warnings.push(`${s.name}: sem a linha "Total Vendedor" no relatório — não deu para conferir a soma.`);
  }
  if (!sawTitle && out.sellers.length) out.warnings.push('O arquivo não tem o título "Vendas Vendedor e Grupo Produtos": confira se é o relatório certo.');
  if (!out.from) out.warnings.push('Não achei o período ("Seleção Período") no relatório.');
  return out;
}

const fmtQty = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const fmtMoney = (c: number) => `R$ ${(c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Grupos que aparecem no relatório (código → nome), em ordem de código. */
export function reportGroups(r: Pick<SalesReport, 'sellers'>): CommissionGroupRef[] {
  const m = new Map<string, string>();
  for (const s of r.sellers) for (const g of s.groups) if (!m.has(g.code)) m.set(g.code, g.name);
  return [...m].map(([code, name]) => ({ code, name })).sort((a, b) => Number(a.code) - Number(b.code) || a.code.localeCompare(b.code));
}

// ------------------------------------------------------------------ configuração
export const COMMISSION_BASES = ['sales', 'quantity'] as const;
export type CommissionBase = (typeof COMMISSION_BASES)[number];
export const COMMISSION_BASE_LABEL: Record<CommissionBase, string> = { sales: '% sobre o valor de vendas', quantity: 'R$ por unidade vendida' };

const groupRef = z.object({ code: z.string().trim().min(1).max(12), name: z.string().trim().max(60).default('') });
export type CommissionGroupRef = z.infer<typeof groupRef>;
const rate = z.number().min(0, 'Use valores positivos').max(1_000_000);

export const commissionRuleSchema = z.object({
  id: z.string().min(1).max(40),
  name: z.string().trim().min(1, 'Dê um nome à regra').max(60),
  groups: z.array(groupRef).min(1, 'Escolha ao menos um grupo de produtos').max(40),
  base: z.enum(COMMISSION_BASES),
  /** % (base sales) ou R$ por unidade (base quantity). */
  rate,
  /** Metas: atingiu `min` (unidades, ou R$ de vendas) → vale `rate` no lugar do padrão, para tudo. */
  tiers: z.array(z.object({ min: z.number().positive('A meta tem de ser maior que zero'), rate })).max(10).default([]),
  rubricId: z.string({ message: 'Escolha a rubrica' }).uuid('Escolha a rubrica'),
  active: z.boolean().default(true),
});
export type CommissionRule = z.infer<typeof commissionRuleSchema>;

export const payrollCommissionsSchema = z.object({
  rules: z.array(commissionRuleSchema).max(30).default([]),
  /** Grupos já vistos nos relatórios lidos (para escolher nas regras). */
  groups: z.array(groupRef).max(300).default([]),
});
export type PayrollCommissions = z.infer<typeof payrollCommissionsSchema>;
export const DEFAULT_PAYROLL_COMMISSIONS: PayrollCommissions = { rules: [], groups: [] };

/** Junta os grupos conhecidos com os de um relatório (nome mais recente vence). */
export function mergeCommissionGroups(known: CommissionGroupRef[], found: CommissionGroupRef[]): CommissionGroupRef[] {
  const m = new Map(known.map((g) => [g.code, g.name]));
  for (const g of found) m.set(g.code, g.name || m.get(g.code) || '');
  return [...m].map(([code, name]) => ({ code, name })).sort((a, b) => Number(a.code) - Number(b.code) || a.code.localeCompare(b.code)).slice(0, 300);
}

// ------------------------------------------------------------------ cálculo
export interface CommissionLine {
  ruleId: string; ruleName: string; rubricId: string; base: CommissionBase;
  /** Unidades (quantity) ou valor de vendas (sales, "1234.56"). */
  quantity: number; sales: string;
  /** Taxa aplicada e a meta atingida (null = taxa padrão). */
  rate: number; tierMin: number | null;
  amount: string;
  /** Grupos da regra que o vendedor vendeu. */
  groups: SalesGroup[];
}
export interface SellerCommission { code: string; name: string; lines: CommissionLine[]; total: string }

/** Taxa da regra para uma medida (unidades ou R$ de vendas): a maior meta atingida, senão a padrão. */
export function commissionRate(rule: Pick<CommissionRule, 'rate' | 'tiers'>, measure: number): { rate: number; tierMin: number | null } {
  let best: { rate: number; tierMin: number | null } = { rate: rule.rate, tierMin: null };
  for (const t of [...rule.tiers].sort((a, b) => a.min - b.min)) if (measure >= t.min) best = { rate: t.rate, tierMin: t.min };
  return best;
}

export function sellerCommission(seller: Pick<SalesSeller, 'code' | 'name' | 'groups'>, rules: CommissionRule[]): SellerCommission {
  const lines: CommissionLine[] = [];
  for (const r of rules) {
    if (!r.active) continue;
    const codes = new Set(r.groups.map((g) => g.code));
    const groups = seller.groups.filter((g) => codes.has(g.code));
    const quantity = Math.round(groups.reduce((a, g) => a + g.quantity, 0) * 1000) / 1000;
    const salesC = groups.reduce((a, g) => a + toCents(g.sales), 0);
    const measure = r.base === 'quantity' ? quantity : salesC / 100;
    const { rate: applied, tierMin } = commissionRate(r, measure);
    const amount = r.base === 'quantity' ? Math.round(quantity * applied * 100) : Math.round((salesC * applied) / 100);
    lines.push({ ruleId: r.id, ruleName: r.name, rubricId: r.rubricId, base: r.base, quantity, sales: fromCents(salesC), rate: applied, tierMin, amount: fromCents(Math.max(0, amount)), groups });
  }
  return { code: seller.code, name: seller.name, lines, total: fromCents(lines.reduce((a, l) => a + toCents(l.amount), 0)) };
}

/** Soma por rubrica (duas regras podem cair na mesma rubrica). */
export function commissionByRubric(c: SellerCommission): Map<string, { amount: string; lines: CommissionLine[] }> {
  const m = new Map<string, { amount: string; lines: CommissionLine[] }>();
  for (const l of c.lines) {
    const cur = m.get(l.rubricId) ?? { amount: '0.00', lines: [] };
    m.set(l.rubricId, { amount: fromCents(toCents(cur.amount) + toCents(l.amount)), lines: [...cur.lines, l] });
  }
  return m;
}

const pct = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 4 });
const brl = (s: string) => (toCents(s) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** "R$ 28.828,60 × 3%" / "30 un × R$ 5,00 (meta 30)". */
export function commissionFormula(l: Pick<CommissionLine, 'base' | 'quantity' | 'sales' | 'rate' | 'tierMin'>): string {
  const meta = l.tierMin !== null ? ` (meta ${l.base === 'quantity' ? fmtQty(l.tierMin) : `R$ ${brl(fromCents(Math.round(l.tierMin * 100)))}`})` : '';
  return l.base === 'quantity' ? `${fmtQty(l.quantity)} un × R$ ${brl(fromCents(Math.round(l.rate * 100)))}${meta}` : `R$ ${brl(l.sales)} × ${pct(l.rate)}%${meta}`;
}
/** Anotação da rubrica no lançamento (até 120 caracteres). */
export function commissionNote(lines: CommissionLine[], from: string | null, to: string | null): string {
  const d = (s: string) => `${s.slice(8, 10)}/${s.slice(5, 7)}`;
  const when = from && to ? `Vendas ${d(from)}–${d(to)}/${to.slice(2, 4)}: ` : 'Vendas: ';
  return (when + lines.map(commissionFormula).join(' + ')).slice(0, 120);
}

// ------------------------------------------------------------------ aplicar no mês
export const payrollCommissionApplySchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  from: isoDate.nullable(),
  to: isoDate.nullable(),
  sellers: z.array(z.object({
    code: z.string().trim().min(1).max(20),
    name: z.string().trim().min(1).max(120),
    groups: z.array(z.object({ code: z.string().trim().min(1).max(12), name: z.string().trim().max(60), quantity: z.number().finite(), sales: money })).max(100),
  })).min(1, 'O relatório não tem vendedores').max(300),
  /** Ligações vendedor → funcionário escolhidas na prévia (null = não recebe comissão). */
  links: z.array(z.object({ code: z.string().trim().min(1).max(20), employeeId: z.string().uuid().nullable() })).max(300).default([]),
});
export type PayrollCommissionApply = z.infer<typeof payrollCommissionApplySchema>;
