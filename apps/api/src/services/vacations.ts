import { and, asc, eq, inArray } from 'drizzle-orm';
import {
  VACATION_SETTINGS_DEFAULT, addYearsISO, parseVacationReport, payslipEmployeeFor, vacationPeriods, vacationSettingsSchema, vacationUrgency,
  type VacationEntry, type VacationPeriod, type VacationSettings, type VacationUrgency,
} from '@nopaper/shared';
import { db, schema, type DBOrTx } from '../db/client.js';
import { getOrgSetting, setOrgSetting } from '../lib/settings.js';
import { badRequest } from '../lib/errors.js';
import { pdfToCells } from './pdf.js';

/**
 * Controle de férias dos funcionários (Folha → Férias). As regras e as contas estão em
 * `packages/shared/src/vacations.ts`; aqui ficam a leitura do cadastro e o que é gravado.
 */
const KEY = 'vacations';

export async function getVacationSettings(orgId: string): Promise<VacationSettings> {
  const raw = await getOrgSetting<unknown>(orgId, KEY);
  const r = vacationSettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : VACATION_SETTINGS_DEFAULT;
}
export const saveVacationSettings = (orgId: string, v: VacationSettings) => setOrgSetting(orgId, KEY, v);

const RANK: Record<VacationUrgency, number> = { late: 4, due: 3, soon: 2, ok: 1, none: 0 };

export interface VacationEmployee {
  id: string; name: string; role: string | null; admissionDate: string | null; vacationFrom: string | null;
  /** Dá para calcular? (precisa da admissão e, para quem tem mais de um ano de casa, de onde o controle começa) */
  configured: boolean;
  /** O que falta para calcular. */
  missing: 'admission' | 'start' | null;
  periods: Array<VacationPeriod & { urgency: VacationUrgency; entries: Array<VacationEntry & { id: string; notes: string | null; source: string; needsReview: boolean }> }>;
  /** A pior situação entre os períodos. */
  urgency: VacationUrgency;
  /** O limite mais próximo (para ordenar) e quantos dias faltam para ele. */
  nextLimit: string | null; daysToLimit: number | null;
  /** Dias adquiridos ainda não gozados, somando os períodos. */
  toEnjoy: number;
  /** Férias em andamento hoje, ou a próxima programada. */
  current: { startDate: string; days: number; ongoing: boolean } | null;
  needsReview: number;
}

export async function vacationOverview(orgId: string, today: string, conn: DBOrTx = db): Promise<{ settings: VacationSettings; employees: VacationEmployee[] }> {
  const settings = await getVacationSettings(orgId);
  const emps = await conn.select().from(schema.employees)
    .where(and(eq(schema.employees.orgId, orgId), eq(schema.employees.active, true), eq(schema.employees.payslipOnly, false))).orderBy(asc(schema.employees.name));
  const ids = emps.filter((e) => !e.terminationDate || e.terminationDate >= today).map((e) => e.id);
  const entries = ids.length ? await conn.select().from(schema.employeeVacations).where(inArray(schema.employeeVacations.employeeId, ids)) : [];
  const adjusts = ids.length ? await conn.select().from(schema.employeeVacationAdjusts).where(inArray(schema.employeeVacationAdjusts.employeeId, ids)) : [];
  const out: VacationEmployee[] = [];
  for (const e of emps) {
    if (!ids.includes(e.id)) continue;
    const mine = entries.filter((x) => x.employeeId === e.id);
    // quem tem menos de um ano de casa só tem o período que está adquirindo: não precisa dizer de onde começar
    const firstYear = !!e.admissionDate && addYearsISO(e.admissionDate, 1) > today;
    const missing = !e.admissionDate ? 'admission' as const : !e.vacationFrom && !firstYear ? 'start' as const : null;
    const base = {
      id: e.id, name: e.name, role: e.role, admissionDate: e.admissionDate, vacationFrom: e.vacationFrom, configured: !missing, missing,
      needsReview: mine.filter((x) => x.needsReview).length,
    };
    if (missing) { out.push({ ...base, periods: [], urgency: 'none', nextLimit: null, daysToLimit: null, toEnjoy: 0, current: null }); continue; }
    const periods = vacationPeriods({
      admission: e.admissionDate!, from: e.vacationFrom, today,
      entries: mine.map((x) => ({ id: x.id, periodStart: x.periodStart, startDate: x.startDate, days: x.days, soldDays: x.soldDays })),
      adjusts: adjusts.filter((a) => a.employeeId === e.id),
    }).map((p) => ({
      ...p, urgency: vacationUrgency(p, settings.alertDays),
      entries: p.entries.map((x) => { const row = mine.find((m) => m.id === x.id)!; return { ...x, id: row.id, notes: row.notes, source: row.source, needsReview: row.needsReview }; }),
    }));
    const worst = periods.reduce<VacationUrgency>((w, p) => (RANK[p.urgency] > RANK[w] ? p.urgency : w), 'none');
    const limits = periods.filter((p) => p.status !== 'accruing' && p.limitStart).sort((a, b) => a.limitStart!.localeCompare(b.limitStart!));
    const dated = mine.filter((x) => x.startDate && x.days > 0).map((x) => ({ startDate: x.startDate!, days: x.days, end: addDays(x.startDate!, x.days - 1) })).sort((a, b) => a.startDate.localeCompare(b.startDate));
    const ongoing = dated.find((x) => x.startDate <= today && x.end >= today);
    const next = ongoing ?? dated.find((x) => x.startDate > today);
    out.push({
      ...base, periods, urgency: worst, nextLimit: limits[0]?.limitStart ?? null, daysToLimit: limits[0]?.daysToLimit ?? null,
      toEnjoy: Math.round(periods.reduce((n, p) => n + (p.status === 'accruing' ? 0 : p.toEnjoy), 0) * 100) / 100,
      current: next ? { startDate: next.startDate, days: next.days, ongoing: !!ongoing } : null,
    });
  }
  // quem pede atenção primeiro; depois pelo limite mais próximo
  out.sort((a, b) => RANK[b.urgency] - RANK[a.urgency] || (a.nextLimit ?? '9999').localeCompare(b.nextLimit ?? '9999') || a.name.localeCompare(b.name, 'pt-BR'));
  return { settings, employees: out };
}
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

/**
 * O que entra no resumo diário: quem cruzou hoje uma das antecedências configuradas e, toda segunda-feira,
 * quem está urgente ou com o prazo estourado (para o aviso não se repetir todos os dias por meses).
 */
export async function vacationDigest(orgId: string, today: string): Promise<Array<{ name: string; days: number; limit: string; daysToLimit: number; urgency: VacationUrgency }>> {
  const [org] = await db.select({ kind: schema.organizations.kind }).from(schema.organizations).where(eq(schema.organizations.id, orgId));
  if (org?.kind !== 'company') return [];
  const { settings, employees } = await vacationOverview(orgId, today);
  if (!settings.inDigest) return [];
  const monday = new Date(`${today}T00:00:00Z`).getUTCDay() === 1;
  const out: Array<{ name: string; days: number; limit: string; daysToLimit: number; urgency: VacationUrgency }> = [];
  for (const e of employees) for (const p of e.periods) {
    if (p.status === 'accruing' || !p.limitStart || p.daysToLimit === null || p.balance <= 0) continue;
    const crossed = settings.alertDays.includes(p.daysToLimit);
    const nag = monday && (p.urgency === 'late' || p.urgency === 'due');
    if (crossed || nag) out.push({ name: e.name, days: p.balance, limit: p.limitStart, daysToLimit: p.daysToLimit, urgency: p.urgency });
  }
  return out.sort((a, b) => a.daysToLimit - b.daysToLimit);
}

// ------------------------------------------------------------------ recibo de férias → registro automático
const isoBR = (br: string) => `${br.slice(6, 10)}-${br.slice(3, 5)}-${br.slice(0, 2)}`;

/**
 * Acha no texto de um recibo de férias o período de gozo e o período aquisitivo. Cada intervalo de datas
 * ("01/12/2026 a 30/12/2026") é classificado pelo rótulo que vem antes dele. Formatos variam de contador
 * para contador: o que não for reconhecido volta null e alguém completa na tela.
 */
export function readVacationReceipt(text: string): { start: string | null; days: number | null; periodStart: string | null } {
  const flat = text.replace(/\s+/g, ' ');
  let start: string | null = null, days: number | null = null, periodStart: string | null = null;
  let prevEnd = 0;
  for (const m of flat.matchAll(/(\d{2}\/\d{2}\/\d{4})\s*(?:a|à|até|ate|-|–)\s*(\d{2}\/\d{2}\/\d{4})/gi)) {
    // o rótulo é o texto entre o intervalo anterior e este (senão o rótulo do vizinho contamina a leitura)
    const label = flat.slice(Math.max(prevEnd, m.index - 60), m.index).toLowerCase();
    prevEnd = m.index + m[0].length;
    const a = isoBR(m[1]!), b = isoBR(m[2]!);
    const span = Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000) + 1;
    if (/aquisitiv/.test(label)) { periodStart ??= a; continue; }
    if (/gozo|concess|f[eé]rias|descanso|per[ií]odo/.test(label) && span >= 5 && span <= 30) { start ??= a; days ??= span; continue; }
    // sem rótulo: um intervalo de ~1 ano é o aquisitivo; um de 5 a 30 dias é o gozo
    if (span >= 360 && span <= 367) periodStart ??= a; else if (span >= 5 && span <= 30) { start ??= a; days ??= span; }
  }
  return { start, days, periodStart };
}

/**
 * Chegou um recibo de férias para assinatura: registra as férias do funcionário sozinho, marcadas para
 * conferência (`needs_review`). Com as datas lidas do recibo, já entra programada; sem elas, entra em branco
 * para alguém completar. Um registro por assinatura (reenviar o recibo não duplica).
 */
export async function registerVacationReceipt(o: { orgId: string; employeeId: string; signatureId: string; text: string; today: string; createdBy: string | null }) {
  const [dup] = await db.select({ id: schema.employeeVacations.id }).from(schema.employeeVacations).where(eq(schema.employeeVacations.signatureId, o.signatureId));
  if (dup) return null;
  const [e] = await db.select().from(schema.employees).where(and(eq(schema.employees.id, o.employeeId), eq(schema.employees.orgId, o.orgId)));
  if (!e?.admissionDate) return null;
  const read = readVacationReceipt(o.text);
  const existing = await db.select().from(schema.employeeVacations).where(eq(schema.employeeVacations.employeeId, e.id));
  // já existe a programação dessas mesmas datas (alguém lançou antes): só liga o recibo a ela
  const same = read.start ? existing.find((x) => x.startDate === read.start) : undefined;
  if (same) { await db.update(schema.employeeVacations).set({ signatureId: o.signatureId }).where(eq(schema.employeeVacations.id, same.id)); return same.id; }
  const periods = vacationPeriods({ admission: e.admissionDate, from: e.vacationFrom, today: o.today, entries: existing.map((x) => ({ periodStart: x.periodStart, startDate: x.startDate, days: x.days, soldDays: x.soldDays })) });
  // período do recibo, se ele existe para este funcionário; senão o mais antigo com saldo
  const period = periods.find((p) => p.start === read.periodStart) ?? periods.find((p) => p.status !== 'accruing' && p.balance > 0) ?? periods[0];
  if (!period) return null;
  const [row] = await db.insert(schema.employeeVacations).values({
    orgId: o.orgId, employeeId: e.id, periodStart: period.start, startDate: read.start, days: read.days ?? 0, soldDays: 0, source: 'receipt', needsReview: true, signatureId: o.signatureId,
    notes: read.start ? 'Registrado pelo recibo de férias enviado para assinatura. Confira as datas.' : 'Recibo de férias enviado para assinatura: informe as datas.', createdBy: o.createdBy,
  }).returning({ id: schema.employeeVacations.id });
  return row!.id;
}

/**
 * Lê o relatório de férias do contador (PDF enviado na tela ou documento da área do contador) e diz a
 * quem cada linha parece pertencer: pela matrícula do holerite ou, sem ela, pelo nome. Não grava nada.
 */
export async function readVacationReport(orgId: string, buf: Buffer, fileName: string) {
  if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw badRequest('O arquivo não é um PDF.');
  let report;
  try { report = parseVacationReport(await pdfToCells(buf)); } catch { throw badRequest('Não consegui ler este PDF. Peça o relatório de novo ao contador.'); }
  if (!report.rows.length) throw badRequest('Não achei períodos de férias neste PDF. Use o relatório "Períodos Aquisitivos Abertos de Férias" do contador.', 'vacation_report_unknown');
  const employees = await db.select({ id: schema.employees.id, name: schema.employees.name, payslipCode: schema.employees.payslipCode, admissionDate: schema.employees.admissionDate })
    .from(schema.employees).where(and(eq(schema.employees.orgId, orgId), eq(schema.employees.active, true)));
  const rows = report.rows.map((r) => {
    const hit = payslipEmployeeFor({ code: r.code, name: r.name }, employees);
    return { ...r, employeeId: hit?.employee.id ?? null, matchedBy: hit?.by ?? null, currentAdmission: hit?.employee.admissionDate ?? null };
  });
  return { fileName: fileName.slice(0, 200), company: report.company, baseDate: report.baseDate, rows, employees: employees.map(({ id, name }) => ({ id, name })) };
}
