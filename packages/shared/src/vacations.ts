import { z } from 'zod';
import { addDaysISO, addYearsISO, diffDaysISO, parseISODate } from './dates.js';
import { isoDate } from './schemas.js';
import type { PdfCell } from './payslips.js';

/**
 * Controle de férias (CLT, arts. 129 a 145).
 *
 * - **Período aquisitivo**: cada 12 meses de trabalho, contados da admissão (art. 130).
 * - **Período concessivo**: os 12 meses seguintes; as férias têm de ser GOZADAS dentro dele (art. 134).
 *   Os dias gozados depois do fim do concessivo são pagos em dobro (art. 137 e Súmula 81 do TST).
 * - **Direito**: 30 dias, reduzido pelas faltas injustificadas no período aquisitivo (art. 130).
 * - **Fracionamento**: até 3 períodos, um com pelo menos 14 dias e os outros com pelo menos 5 (art. 134 §1º).
 * - **Início**: não pode ser nos 2 dias que antecedem feriado ou o descanso semanal (art. 134 §3º).
 * - **Abono pecuniário**: a pessoa pode vender até 1/3 das férias (art. 143).
 * - **Aviso**: por escrito, 30 dias antes (art. 135). **Pagamento**: até 2 dias antes do início (art. 145).
 *
 * As contas são as do relatório de férias do contador ("Períodos Aquisitivos Abertos"): o limite sem
 * dobra é o fim do concessivo menos os dias que faltam gozar; o proporcional é 1/12 do direito por mês
 * trabalhado, e fração de mais de 14 dias conta como mês (art. 146, parágrafo único).
 */

/** Dias de `from` até `to` (positivo quando `to` é depois). */
const gap = (from: string, to: string) => diffDaysISO(to, from);

/** Dias de direito conforme as faltas injustificadas no período aquisitivo (art. 130). */
export function vacationEntitlement(absences: number): number {
  if (absences <= 5) return 30;
  if (absences <= 14) return 24;
  if (absences <= 23) return 18;
  if (absences <= 32) return 12;
  return 0;
}

/** Férias registradas (já gozadas ou programadas). `startDate` null = gozadas antes do controle, sem data conhecida. */
export interface VacationEntry { id?: string; periodStart: string; startDate: string | null; days: number; soldDays: number }
/** Ajuste de um período aquisitivo: faltas injustificadas, ou direito perdido (art. 133). */
export interface VacationAdjust { periodStart: string; absences: number; forfeited: boolean }

export type VacationStatus = 'accruing' | 'vested' | 'overdue';
export interface VacationPeriod {
  /** Período aquisitivo. */
  start: string; end: string;
  /** Período concessivo: quando as férias podem (e têm de) ser gozadas. */
  concessiveStart: string; concessiveEnd: string;
  /** accruing = adquirindo; vested = direito adquirido, dentro do concessivo; overdue = concessivo acabou com saldo. */
  status: VacationStatus;
  absences: number;
  forfeited: boolean;
  /** Dias de direito do período (30, 24, 18, 12 ou 0). */
  entitled: number;
  /** Dias já adquiridos hoje (proporcional enquanto adquire; depois = `entitled`). */
  accrued: number;
  /** Dias já gozados (início até hoje), programados (início no futuro) e vendidos (abono). */
  taken: number; scheduled: number; sold: number;
  /** Dias ainda sem programação: direito − gozados − programados − vendidos. */
  balance: number;
  /** Dias ainda não gozados (o que o relatório do contador chama de Saldo, sobre o adquirido). */
  toEnjoy: number;
  /** Último dia para COMEÇAR os dias sem programação sem dobra; null se não há nada a programar. */
  limitStart: string | null;
  /** Dias de hoje até `limitStart` (negativo = já não cabe inteiro sem dobra). */
  daysToLimit: number | null;
  /** Dias (programados ou não) que cairiam depois do fim do concessivo, pagos em dobro. */
  doubledDays: number;
  entries: VacationEntry[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Meses trabalhados entre duas datas, contando como mês a fração de mais de 14 dias (art. 146, parágrafo único). */
export function monthsWorked(from: string, to: string): number {
  if (to <= from) return 0;
  let months = 0;
  while (months < 12 && addMonthsExact(from, months + 1) <= to) months++;
  const rest = gap(addMonthsExact(from, months), to);
  return Math.min(12, months + (rest > 14 ? 1 : 0));
}
/** Mesmo dia N meses depois (31 → último dia do mês). */
function addMonthsExact(base: string, n: number): string {
  const { y, m, d } = parseISODate(base);
  const total = (m - 1) + n, yy = y + Math.floor(total / 12), mm = (total % 12) + 1;
  const last = new Date(Date.UTC(yy, mm, 0)).getUTCDate();
  return `${yy}-${String(mm).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

/**
 * Períodos aquisitivos de um funcionário, do primeiro em aberto (`from`) até o que está sendo adquirido hoje.
 * `from` = início do período aquisitivo mais antigo ainda em aberto (os anteriores já foram resolvidos);
 * sem ele, vale a admissão (funcionário novo). Períodos totalmente gozados antes do último não são devolvidos.
 */
export function vacationPeriods(o: {
  admission: string; today: string; from?: string | null; termination?: string | null;
  entries?: VacationEntry[]; adjusts?: VacationAdjust[];
}): VacationPeriod[] {
  const out: VacationPeriod[] = [];
  const end = o.termination && o.termination < o.today ? o.termination : o.today;
  if (!o.admission || o.admission > end) return out;
  // início de cada período = aniversário da admissão
  let n = 0;
  if (o.from && o.from > o.admission) { while (addYearsISO(o.admission, n + 1) <= o.from) n++; }
  for (; ; n++) {
    const start = addYearsISO(o.admission, n);
    if (start > end) break;
    const pEnd = addDaysISO(addYearsISO(o.admission, n + 1), -1);
    const concessiveStart = addDaysISO(pEnd, 1), concessiveEnd = addDaysISO(addYearsISO(o.admission, n + 2), -1);
    const adj = o.adjusts?.find((a) => a.periodStart === start);
    const absences = adj?.absences ?? 0, forfeited = !!adj?.forfeited;
    const entitled = forfeited ? 0 : vacationEntitlement(absences);
    const entries = (o.entries ?? []).filter((e) => e.periodStart === start).sort((a, b) => (a.startDate ?? '').localeCompare(b.startDate ?? ''));
    const accruing = pEnd >= end;
    const accrued = accruing ? round2((entitled / 12) * monthsWorked(start, end)) : entitled;
    let taken = 0, scheduled = 0, sold = 0, doubledDays = 0;
    for (const e of entries) {
      sold += e.soldDays;
      if (e.startDate && e.startDate > o.today) scheduled += e.days; else taken += e.days;
      if (e.startDate) {
        const last = addDaysISO(e.startDate, e.days - 1);
        if (last > concessiveEnd) doubledDays += Math.min(e.days, gap(concessiveEnd, last));
      }
    }
    const balance = Math.max(0, round2(entitled - taken - scheduled - sold));
    const toEnjoy = Math.max(0, round2(accrued - taken - sold));
    const limitStart = balance > 0 ? addDaysISO(concessiveEnd, -Math.ceil(balance)) : null;
    const status: VacationStatus = accruing ? 'accruing' : o.today > concessiveEnd && balance > 0 ? 'overdue' : 'vested';
    // o que sobrou sem programar e já não cabe até o fim do concessivo também vira dobra
    if (balance > 0 && !accruing) {
      const room = Math.max(0, gap(o.today, concessiveEnd) + 1);
      doubledDays += Math.max(0, Math.ceil(balance) - room);
    }
    out.push({
      start, end: pEnd, concessiveStart, concessiveEnd, status, absences, forfeited, entitled, accrued, taken, scheduled, sold, balance, toEnjoy,
      limitStart, daysToLimit: limitStart ? gap(o.today, limitStart) : null, doubledDays, entries,
    });
  }
  // períodos antigos já zerados não interessam (fica o que tem saldo, programação futura, ou o atual)
  return out.filter((p, i) => i === out.length - 1 || p.balance > 0 || p.scheduled > 0 || p.status === 'accruing');
}

export type VacationUrgency = 'late' | 'due' | 'soon' | 'ok' | 'none';
/**
 * O quanto um período pede atenção. `alertDays` = antecedências configuradas (ex.: [120, 60, 30]):
 * late = já passou do limite; due = dentro da menor antecedência; soon = dentro da maior.
 * Período ainda sendo adquirido não gera aviso (as férias só podem ser gozadas depois de adquiridas).
 */
export function vacationUrgency(p: VacationPeriod, alertDays: number[]): VacationUrgency {
  if (p.status === 'accruing' || p.daysToLimit === null) return 'none';
  if (p.status === 'overdue' || p.daysToLimit < 0) return 'late';
  const sorted = [...alertDays].sort((a, b) => a - b);
  if (!sorted.length) return 'ok';
  if (p.daysToLimit <= sorted[0]!) return 'due';
  if (p.daysToLimit <= sorted[sorted.length - 1]!) return 'soon';
  return 'ok';
}
export const VACATION_URGENCY_LABEL: Record<VacationUrgency, string> = { late: 'Prazo estourado', due: 'Urgente', soon: 'Programar', ok: 'Em dia', none: 'Adquirindo' };

/** Datas que decorrem de uma programação: aviso ao funcionário (30 dias antes) e pagamento (2 dias antes). */
export function vacationDates(startDate: string, days: number) {
  return { end: addDaysISO(startDate, days - 1), noticeBy: addDaysISO(startDate, -30), payBy: addDaysISO(startDate, -2), returnOn: addDaysISO(startDate, days) };
}

/**
 * Confere uma programação com as regras da CLT. Devolve avisos (a tela mostra; não impede de gravar —
 * convenção coletiva e acordo podem mudar alguns pontos, e a decisão é de quem cuida da folha).
 * `others` = as outras férias já registradas no mesmo período aquisitivo.
 */
export function checkVacation(p: Pick<VacationPeriod, 'start' | 'end' | 'entitled' | 'concessiveEnd'>, e: { startDate: string | null; days: number; soldDays: number }, others: VacationEntry[], today: string): string[] {
  const w: string[] = [];
  const all = [...others, { periodStart: p.start, ...e }];
  const days = all.reduce((n, x) => n + x.days, 0), sold = all.reduce((n, x) => n + x.soldDays, 0);
  if (days + sold > p.entitled) w.push(`Soma ${days + sold} dias, mais que os ${p.entitled} de direito deste período.`);
  if (sold > Math.floor(p.entitled / 3)) w.push(`O abono (venda) é de no máximo 1/3 das férias: ${Math.floor(p.entitled / 3)} dias (art. 143).`);
  const parts = all.filter((x) => x.days > 0);
  if (parts.length > 3) w.push('As férias podem ser divididas em no máximo 3 períodos (art. 134, §1º).');
  if (parts.length > 1) {
    if (!parts.some((x) => x.days >= 14)) w.push('Ao dividir, um dos períodos precisa ter pelo menos 14 dias (art. 134, §1º).');
    if (parts.some((x) => x.days < 5)) w.push('Ao dividir, nenhum período pode ter menos de 5 dias (art. 134, §1º).');
  }
  if (e.startDate && e.days > 0) {
    if (e.startDate <= p.end) w.push('O início é antes de o período aquisitivo se completar: as férias só podem ser gozadas depois.');
    const last = addDaysISO(e.startDate, e.days - 1);
    if (last > p.concessiveEnd) w.push(`${gap(p.concessiveEnd, last)} dia(s) ficam depois do fim do período concessivo (${brDate(p.concessiveEnd)}) e são pagos em dobro (art. 137).`);
    const { y, m, d } = parseISODate(e.startDate);
    const wd = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
    if (wd === 5 || wd === 6) w.push('O início cai nos 2 dias antes do descanso semanal (sexta ou sábado): a lei não permite (art. 134, §3º). Confira também os feriados.');
    if (e.startDate > today && gap(today, e.startDate) < 30) w.push('Faltam menos de 30 dias para o início: o aviso ao funcionário tem de ser por escrito, com 30 dias de antecedência (art. 135).');
  }
  return w;
}
const brDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;

// ------------------------------------------------------------------ cadastro e configuração
export const vacationEntrySchema = z.object({
  employeeId: z.string().uuid(),
  /** Início do período aquisitivo a que estas férias pertencem. */
  periodStart: isoDate,
  /** Vazio = férias já gozadas antes do controle, sem data conhecida. */
  startDate: isoDate.nullish().transform((v) => v ?? null),
  days: z.number().int().min(0).max(30),
  /** Dias vendidos (abono pecuniário). */
  soldDays: z.number().int().min(0).max(10).default(0),
  notes: z.string().trim().max(500).nullish().transform((v) => (v ? v : null)),
}).refine((v) => v.days + v.soldDays > 0, 'Informe os dias de férias ou os dias vendidos');
export type VacationEntryInput = z.output<typeof vacationEntrySchema>;

export const vacationAdjustSchema = z.object({
  employeeId: z.string().uuid(), periodStart: isoDate,
  absences: z.number().int().min(0).max(366).default(0),
  forfeited: z.boolean().default(false),
});

export const VACATION_ALERT_DEFAULT = [120, 60, 30];
export const vacationSettingsSchema = z.object({
  /** Antecedências (em dias) em relação ao limite sem dobra. */
  alertDays: z.array(z.number().int().min(1).max(365)).min(1, 'Informe ao menos uma antecedência').max(5)
    .transform((v) => [...new Set(v)].sort((a, b) => b - a)).default(VACATION_ALERT_DEFAULT),
  /** Entra no resumo diário dos alertas (Telegram/e-mail)? */
  inDigest: z.boolean().default(true),
});
export type VacationSettings = z.output<typeof vacationSettingsSchema>;
export const VACATION_SETTINGS_DEFAULT: VacationSettings = { alertDays: VACATION_ALERT_DEFAULT, inDigest: true };

// ------------------------------------------------------------------ relatório do contador
export interface VacationReportRow {
  code: string; name: string; limit: string; admission: string;
  periodStart: string; periodEnd: string; absences: number; leave: number;
  /** Saldo e Pago, em dias. */
  balance: number; paid: number;
  /** V = período vencido (direito adquirido); A = em aquisição. */
  kind: 'V' | 'A';
}
export interface VacationReport { company: string | null; baseDate: string | null; rows: VacationReportRow[] }

const iso = (br: string) => `${br.slice(6, 10)}-${br.slice(3, 5)}-${br.slice(0, 2)}`;
const num = (s: string) => Number(s.replace(/\./g, '').replace(',', '.'));

/**
 * Lê o relatório "Períodos Aquisitivos Abertos de Férias" (sistema do contador). Cada linha: matrícula e
 * nome, limite sem dobra, admissão, período aquisitivo, faltas, afastamentos, saldo, pago e tipo (V/A).
 * As colunas de faltas e afastamentos costumam vir vazias: o número é atribuído pela posição do título.
 */
export function parseVacationReport(rows: PdfCell[][]): VacationReport {
  const out: VacationReport = { company: null, baseDate: null, rows: [] };
  let xAbs: number | null = null, xLeave: number | null = null, xBal: number | null = null;
  for (const raw of rows) {
    const row = [...raw].filter((c) => c.s.trim()).sort((a, b) => a.x - b.x);
    if (!row.length) continue;
    const text = row.map((c) => c.s.trim()).join(' ');
    const base = /Data Base:\s*(\d{2}\/\d{2}\/\d{4})/i.exec(text);
    if (base) out.baseDate = iso(base[1]!);
    if (!out.company) { const m = /^\d+\s*-\s*(.+?)(?:\s+\d{2}\/\d{2}\/\d{4}.*)?$/.exec(row[0]!.s.trim()); if (m && row.length <= 3 && !/à/.test(text)) out.company = m[1]!.trim(); }
    if (row.some((c) => /^Faltas$/i.test(c.s.trim()))) {
      xAbs = row.find((c) => /^Faltas$/i.test(c.s.trim()))!.x;
      xLeave = row.find((c) => /^Afast/i.test(c.s.trim()))?.x ?? null;
      xBal = row.find((c) => /^Saldo$/i.test(c.s.trim()))?.x ?? null;
      continue;
    }
    const m = /^(\d+)\s+(.+?)\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+(\d{2}\/\d{2}\/\d{4})\s+à\s+(\d{2}\/\d{2}\/\d{4})\s+(.*?)(\d+(?:\.\d{3})*,\d{2})\s+(\d+(?:\.\d{3})*,\d{2})\s+([VA])\b/.exec(text);
    if (!m) continue;
    // números soltos entre o período e o saldo: faltas ou afastamentos, conforme a coluna em que estão
    let absences = 0, leave = 0;
    const period = row.findIndex((c) => /\d{2}\/\d{2}\/\d{4}\s+à\s+\d{2}\/\d{2}\/\d{4}/.test(c.s));
    for (const c of row.slice(period + 1)) {
      if (xBal !== null && c.x >= xBal - 12) break;
      const v = /^\d+(?:,\d+)?$/.test(c.s.trim()) ? Math.round(num(c.s.trim())) : null;
      if (v === null) continue;
      if (xLeave !== null && xAbs !== null && Math.abs(c.x - xLeave) < Math.abs(c.x - xAbs)) leave = v; else absences = v;
    }
    out.rows.push({
      code: m[1]!, name: m[2]!.trim(), limit: iso(m[3]!), admission: iso(m[4]!), periodStart: iso(m[5]!), periodEnd: iso(m[6]!),
      absences, leave, balance: num(m[8]!), paid: num(m[9]!), kind: m[10] as 'V' | 'A',
    });
  }
  return out;
}
