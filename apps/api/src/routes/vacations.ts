import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  addYearsISO, checkVacation, formatDateBR, isoDate, vacationAdjustSchema, vacationEntrySchema, vacationPeriods,
  vacationSettingsSchema, type Permission,
} from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { env } from '../env.js';
import { parse } from '../lib/validate.js';
import { badRequest, notFound } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { orgToday } from '../services/bills.js';
import { assertCompany, loadEmployee } from '../services/payroll.js';
import { getVacationSettings, readVacationReport, saveVacationSettings, vacationOverview } from '../services/vacations.js';

const guard = (...p: Permission[]) => ({ preHandler: [requirePerm(...p), async (req: FastifyRequest) => { assertCompany(req); }] });
const view = guard('payroll.view'), edit = guard('payroll.edit'), manage = guard('payroll.manage');

/** Linha do relatório do contador já ligada a um funcionário, como a tela devolve para aplicar. */
const applySchema = z.object({
  baseDate: isoDate.nullable(),
  rows: z.array(z.object({
    employeeId: z.string().uuid(), admission: isoDate, periodStart: isoDate,
    paid: z.number().min(0).max(30), absences: z.number().int().min(0).max(366).default(0),
  })).min(1).max(2000),
  /** Trocar a admissão do cadastro quando a do relatório for diferente. */
  updateAdmission: z.boolean().default(true),
});

/** Controle de férias (Folha → Férias; só espaço Empresa). */
export default async function vacationRoutes(app: FastifyInstance) {
  app.get('/api/payroll/vacations', view, async (req) => vacationOverview(req.org!.id, orgToday(req)));

  app.put('/api/payroll/vacations/settings', manage, async (req) => {
    const body = parse(vacationSettingsSchema, req.body);
    const before = await getVacationSettings(req.org!.id);
    await saveVacationSettings(req.org!.id, body);
    await audit(req, { action: 'payroll.vacation.settings', entityType: 'payroll', description: 'Alterou os avisos de férias', details: { changes: { alertDays: { from: before.alertDays, to: body.alertDays }, inDigest: { from: before.inDigest, to: body.inDigest } } } });
    return body;
  });

  /** De onde o controle começa para um funcionário (e a admissão, se faltar). */
  app.put<{ Params: { id: string } }>('/api/payroll/vacations/employees/:id', edit, async (req) => {
    const body = parse(z.object({ admissionDate: isoDate.optional(), vacationFrom: isoDate.nullable() }), req.body);
    const e = await loadEmployee(req.org!.id, req.params.id);
    const admission = body.admissionDate ?? e.admissionDate;
    if (!admission) throw badRequest('Informe a data de admissão.');
    if (admission > orgToday(req)) throw badRequest('A admissão não pode ser no futuro.');
    let from = body.vacationFrom;
    if (from) {
      // tem de ser o começo de um período aquisitivo (aniversário da admissão)
      let n = 0; while (addYearsISO(admission, n) < from && n < 80) n++;
      if (addYearsISO(admission, n) !== from) throw badRequest(`O período aquisitivo começa sempre no dia da admissão (${formatDateBR(admission).slice(0, 5)}). Escolha um dos períodos da lista.`);
    }
    if (from === admission) from = null; // do primeiro período = sem corte
    await db.update(schema.employees).set({ admissionDate: admission, vacationFrom: from ?? (addYearsISO(admission, 1) > orgToday(req) ? null : admission) }).where(eq(schema.employees.id, e.id));
    await audit(req, { action: 'payroll.vacation.start', entityType: 'employee', entityId: e.id, description: `Definiu o início do controle de férias de ${e.name}`, details: { changes: { admissionDate: { from: e.admissionDate, to: admission }, vacationFrom: { from: e.vacationFrom, to: from } } } });
    return { ok: true };
  });

  // ------------------------------------------------------------ férias gozadas / programadas
  const periodOf = async (req: FastifyRequest, employeeId: string, periodStart: string, exceptId?: string) => {
    const e = await loadEmployee(req.org!.id, employeeId);
    if (!e.admissionDate) throw badRequest(`Informe a data de admissão de ${e.name} antes de registrar férias.`);
    const today = orgToday(req);
    const all = await db.select().from(schema.employeeVacations).where(eq(schema.employeeVacations.employeeId, e.id));
    const adjusts = await db.select().from(schema.employeeVacationAdjusts).where(eq(schema.employeeVacationAdjusts.employeeId, e.id));
    // todos os períodos desde a admissão: dá para lançar férias antigas mesmo de período já fechado
    const periods = vacationPeriods({ admission: e.admissionDate, today, entries: [], adjusts });
    const all30 = vacationPeriods({ admission: e.admissionDate, today: addYearsISO(today, 1), entries: [], adjusts });
    const p = [...periods, ...all30].find((x) => x.start === periodStart);
    if (!p) throw badRequest('Período aquisitivo inválido para este funcionário.');
    const others = all.filter((x) => x.periodStart === periodStart && x.id !== exceptId).map((x) => ({ id: x.id, periodStart: x.periodStart, startDate: x.startDate, days: x.days, soldDays: x.soldDays }));
    return { e, p, others, today };
  };

  app.post('/api/payroll/vacations/entries', edit, async (req, reply) => {
    const body = parse(vacationEntrySchema, req.body);
    const { e, p, others, today } = await periodOf(req, body.employeeId, body.periodStart);
    const warnings = checkVacation(p, body, others, today);
    const [row] = await db.insert(schema.employeeVacations).values({
      orgId: req.org!.id, employeeId: e.id, periodStart: body.periodStart, startDate: body.startDate, days: body.days, soldDays: body.soldDays, notes: body.notes, createdBy: req.user?.id ?? null,
    }).returning();
    await audit(req, { action: 'payroll.vacation.create', entityType: 'employee', entityId: e.id, description: `Registrou férias de ${e.name}: ${describe(body)}`, details: { ...body, warnings } });
    reply.code(201);
    return { id: row!.id, warnings };
  });

  app.put<{ Params: { id: string } }>('/api/payroll/vacations/entries/:id', edit, async (req) => {
    const body = parse(vacationEntrySchema, req.body);
    const [cur] = await db.select().from(schema.employeeVacations).where(and(eq(schema.employeeVacations.id, req.params.id), eq(schema.employeeVacations.orgId, req.org!.id)));
    if (!cur || cur.employeeId !== body.employeeId) throw notFound('Registro de férias não encontrado');
    const { e, p, others, today } = await periodOf(req, body.employeeId, body.periodStart, cur.id);
    const warnings = checkVacation(p, body, others, today);
    await db.update(schema.employeeVacations).set({ periodStart: body.periodStart, startDate: body.startDate, days: body.days, soldDays: body.soldDays, notes: body.notes, needsReview: false, updatedAt: new Date() }).where(eq(schema.employeeVacations.id, cur.id));
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const k of ['periodStart', 'startDate', 'days', 'soldDays', 'notes'] as const) if (cur[k] !== body[k]) changes[k] = { from: cur[k], to: body[k] };
    await audit(req, { action: 'payroll.vacation.update', entityType: 'employee', entityId: e.id, description: `Alterou férias de ${e.name}: ${describe(body)}`, details: { changes, warnings } });
    return { id: cur.id, warnings };
  });

  app.delete<{ Params: { id: string } }>('/api/payroll/vacations/entries/:id', edit, async (req) => {
    const [cur] = await db.select().from(schema.employeeVacations).where(and(eq(schema.employeeVacations.id, req.params.id), eq(schema.employeeVacations.orgId, req.org!.id)));
    if (!cur) throw notFound('Registro de férias não encontrado');
    const e = await loadEmployee(req.org!.id, cur.employeeId);
    await db.delete(schema.employeeVacations).where(eq(schema.employeeVacations.id, cur.id));
    await audit(req, { action: 'payroll.vacation.delete', entityType: 'employee', entityId: e.id, description: `Apagou um registro de férias de ${e.name}: ${describe(cur)}`, details: { periodStart: cur.periodStart, startDate: cur.startDate, days: cur.days, soldDays: cur.soldDays } });
    return { ok: true };
  });

  /** Faltas injustificadas do período aquisitivo (reduzem o direito) ou direito perdido. */
  app.put('/api/payroll/vacations/adjust', edit, async (req) => {
    const body = parse(vacationAdjustSchema, req.body);
    const e = await loadEmployee(req.org!.id, body.employeeId);
    const t = schema.employeeVacationAdjusts;
    if (!body.absences && !body.forfeited) await db.delete(t).where(and(eq(t.employeeId, e.id), eq(t.periodStart, body.periodStart)));
    else await db.insert(t).values({ orgId: req.org!.id, employeeId: e.id, periodStart: body.periodStart, absences: body.absences, forfeited: body.forfeited })
      .onConflictDoUpdate({ target: [t.employeeId, t.periodStart], set: { absences: body.absences, forfeited: body.forfeited } });
    await audit(req, { action: 'payroll.vacation.adjust', entityType: 'employee', entityId: e.id, description: `Ajustou o período aquisitivo de ${e.name} iniciado em ${formatDateBR(body.periodStart)}`, details: { absences: body.absences, forfeited: body.forfeited } });
    return { ok: true };
  });

  // ------------------------------------------------------------ relatório do contador
  /** Só lê: devolve as linhas e a quem cada uma parece pertencer (matrícula do holerite, ou nome). */
  app.post('/api/payroll/vacations/report/read', edit, async (req) => {
    const file = await req.file({ limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });
    if (!file) throw badRequest('Envie o PDF do relatório de férias');
    return readVacationReport(req.org!.id, await file.toBuffer(), file.filename);
  });

  /**
   * Aplica o relatório: admissão, início do controle (o período aberto mais antigo de cada pessoa), faltas e
   * os dias já gozados que o relatório informa ("Pago") e ainda não estão registrados aqui.
   */
  app.post('/api/payroll/vacations/report/apply', edit, async (req) => {
    const body = parse(applySchema, req.body);
    const ids = [...new Set(body.rows.map((r) => r.employeeId))];
    const emps = await db.select().from(schema.employees).where(and(eq(schema.employees.orgId, req.org!.id), inArray(schema.employees.id, ids)));
    if (emps.length !== ids.length) throw badRequest('Funcionário inválido no relatório.');
    let entries = 0, employees = 0;
    await db.transaction(async (tx) => {
      for (const e of emps) {
        const mine = body.rows.filter((r) => r.employeeId === e.id);
        const admission = body.updateAdmission || !e.admissionDate ? mine[0]!.admission : e.admissionDate;
        const from = mine.map((r) => r.periodStart).sort()[0]!;
        await tx.update(schema.employees).set({ admissionDate: admission, vacationFrom: from }).where(eq(schema.employees.id, e.id));
        employees++;
        const existing = await tx.select().from(schema.employeeVacations).where(eq(schema.employeeVacations.employeeId, e.id));
        for (const r of mine) {
          const t = schema.employeeVacationAdjusts;
          if (r.absences) await tx.insert(t).values({ orgId: req.org!.id, employeeId: e.id, periodStart: r.periodStart, absences: r.absences, forfeited: false })
            .onConflictDoUpdate({ target: [t.employeeId, t.periodStart], set: { absences: r.absences } });
          // "Pago" do relatório = dias já gozados/vendidos daquele período: lança só o que ainda não está aqui
          // (férias que ainda vão começar não contam: o contador só informa o que já foi pago)
          const known = existing.filter((x) => x.periodStart === r.periodStart && (!x.startDate || !body.baseDate || x.startDate <= body.baseDate)).reduce((n, x) => n + x.days + x.soldDays, 0);
          const missing = Math.round(r.paid - known);
          if (missing > 0) {
            await tx.insert(schema.employeeVacations).values({
              orgId: req.org!.id, employeeId: e.id, periodStart: r.periodStart, startDate: null, days: missing, soldDays: 0, source: 'report',
              notes: `Já gozados, conforme o relatório do contador${body.baseDate ? ` de ${formatDateBR(body.baseDate)}` : ''}`, createdBy: req.user?.id ?? null,
            });
            entries++;
          }
        }
      }
    });
    await audit(req, { action: 'payroll.vacation.report', entityType: 'payroll', description: `Aplicou o relatório de férias do contador${body.baseDate ? ` (data base ${formatDateBR(body.baseDate)})` : ''}: ${employees} funcionário(s)`, details: { employees, entries, baseDate: body.baseDate } });
    return { employees, entries };
  });
}

const describe = (v: { startDate: string | null; days: number; soldDays: number }) =>
  [v.days ? `${v.days} dia(s)${v.startDate ? ` a partir de ${formatDateBR(v.startDate)}` : ' (já gozados)'}` : '', v.soldDays ? `${v.soldDays} dia(s) vendido(s)` : ''].filter(Boolean).join(' + ');
