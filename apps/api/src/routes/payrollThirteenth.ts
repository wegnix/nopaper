/**
 * 13º salário na folha: cada funcionário e parcela vira um pagamento com vencimento e conta a pagar
 * próprios, no mês da folha em que é pago (separado do salário do mês).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import {
  THIRTEENTH_LABEL, billPerm, thirteenthDefaultPayDate, thirteenthJoinSchema, parsePayslips, refLabelPT, thirteenthApplySchema, thirteenthClash, thirteenthUpdateSchema, toCents,
  type Permission, type ThirteenthInstallment,
} from '@nopaper/shared';
import { db, schema, type DBOrTx } from '../db/client.js';
import { env } from '../env.js';
import { parse } from '../lib/validate.js';
import { badRequest, conflict, forbidden } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { pdfToCells } from '../services/pdf.js';
import { checkPayslipsSpace } from '../services/spaceCheck.js';
import {
  assertCompany, assertThirteenthEditable, assertThirteenthSlips, deleteThirteenth, loadEmployee, loadPeriod, loadThirteenth, syncThirteenthBill, thirteenthPartner,
} from '../services/payroll.js';

const guard = (...p: Permission[]) => ({ preHandler: [requirePerm(...p), async (req: FastifyRequest) => { assertCompany(req); }] });
const view = guard('payroll.view');
const edit = guard('payroll.edit');

const billStatus = async (tx: DBOrTx, ids: Array<string | null>) => {
  const list = ids.filter((x): x is string => !!x);
  if (!list.length) return new Map<string, string>();
  return new Map((await tx.select({ id: schema.bills.id, status: schema.bills.status }).from(schema.bills).where(inArray(schema.bills.id, list))).map((b) => [b.id, b.status]));
};

const label = (i: string) => THIRTEENTH_LABEL[i as ThirteenthInstallment] ?? i;

export default async function payrollThirteenthRoutes(app: FastifyInstance) {
  /** Lê o PDF do 13º (só aceita recibos de 13º). Nada é gravado. */
  app.post('/api/payroll/thirteenth/read', edit, async (req) => {
    const file = await req.file({ limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 } });
    if (!file) throw badRequest('Envie o PDF do 13º salário');
    const buf = await file.toBuffer();
    if (file.file.truncated) throw badRequest(`Arquivo maior que ${env.MAX_UPLOAD_MB} MB`);
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw badRequest('O arquivo não é um PDF. Envie o PDF do 13º que o contador manda.');
    let cells;
    try { cells = await pdfToCells(buf, 200); } catch { throw badRequest('Não consegui ler este PDF. Peça o arquivo de novo ao contador e tente outra vez.'); }
    const report = parsePayslips(cells);
    if (!report.slips.length) throw badRequest('Não achei recibos neste PDF. Ele precisa ser o PDF original do contador, não uma foto ou digitalização.', 'payslips_unknown');
    assertThirteenthSlips(report);
    return { fileName: file.filename.slice(0, 200), report, spaceCheck: await checkPayslipsSpace(req, report) };
  });

  /**
   * Lança pagamentos de 13º no mês da folha (do recibo do contador ou à mão). O mesmo funcionário, ano
   * e parcela já lançado é substituído (se ainda não foi pago); parcela única não convive com 1ª/2ª.
   */
  app.post<{ Params: { id: string } }>('/api/payroll/periods/:id/thirteenth', edit, async (req) => {
    const body = parse(thirteenthApplySchema, req.body);
    const orgId = req.org!.id;
    const p = await loadPeriod(orgId, req.params.id);
    const canManage = req.org!.can('payroll.manage');
    const keys = body.items.map((i) => `${i.employeeId}|${i.year}|${i.installment}`);
    if (new Set(keys).size !== keys.length) throw badRequest('O mesmo 13º aparece duas vezes no envio');
    const out = await db.transaction(async (tx) => {
      const emps = await tx.select().from(schema.employees).where(eq(schema.employees.orgId, orgId));
      const ids = [...new Set(body.items.map((i) => i.employeeId))];
      const existing = await tx.select().from(schema.payrollThirteenth).where(and(eq(schema.payrollThirteenth.orgId, orgId), inArray(schema.payrollThirteenth.employeeId, ids)));
      const applied: Array<{ employee: string; installment: string; amount: string; created: boolean }> = [];
      const skipped: Array<{ employee: string; reason: string }> = [];
      const linked: string[] = [];
      for (const it of body.items) {
        const emp = emps.find((e) => e.id === it.employeeId);
        if (!emp) throw badRequest('Funcionário inválido');
        if (it.code && emp.payslipCode !== it.code) {
          if (!canManage) throw forbidden('Ligar um recibo a um funcionário exige a permissão de gerenciar a folha.');
          const holder = emps.find((e) => e.payslipCode === it.code);
          if (holder) { await tx.update(schema.employees).set({ payslipCode: null }).where(eq(schema.employees.id, holder.id)); holder.payslipCode = null; }
          await tx.update(schema.employees).set({ payslipCode: it.code }).where(eq(schema.employees.id, emp.id));
          emp.payslipCode = it.code;
          linked.push(emp.name);
        }
        const mine = existing.filter((x) => x.employeeId === emp.id && x.year === it.year);
        const same = mine.find((x) => x.installment === it.installment);
        const clash = thirteenthClash(it.installment, mine.filter((x) => x !== same).map((x) => x.installment as ThirteenthInstallment));
        if (clash) throw conflict(`${emp.name} já tem o 13º de ${it.year} lançado como ${label(clash).toLowerCase()}. Apague esse lançamento antes de lançar a ${label(it.installment).toLowerCase()}.`);
        if (same?.billId) {
          const [b] = await tx.select({ status: schema.bills.status }).from(schema.bills).where(eq(schema.bills.id, same.billId));
          if (b?.status === 'paid') { skipped.push({ employee: emp.name, reason: `${label(it.installment).toLowerCase()} do 13º já paga` }); continue; }
        }
        const values = {
          // parcelas juntas mantêm o vencimento combinado
          periodId: p.id, payDate: same?.joined ? same.payDate : it.payDate, net: it.net, amount: it.amount, gross: it.gross ?? null, fgts: it.fgts ?? null,
          lines: it.lines, source: body.fileName ? 'pdf' : 'manual', fileName: body.fileName ?? null, notes: it.notes ?? same?.notes ?? null,
        };
        let id = same?.id;
        if (same) await tx.update(schema.payrollThirteenth).set(values).where(eq(schema.payrollThirteenth.id, same.id));
        else {
          const [t] = await tx.insert(schema.payrollThirteenth).values({ ...values, orgId, employeeId: emp.id, year: it.year, installment: it.installment, createdBy: req.user!.id }).returning();
          id = t.id;
        }
        await syncThirteenthBill(tx, id!, req.user!.id);
        applied.push({ employee: emp.name, installment: it.installment, amount: it.amount, created: !same });
      }
      return { applied, skipped, linked };
    });
    await audit(req, {
      action: 'payroll.thirteenth', entityType: 'payroll_period', entityId: p.id,
      description: `Lançou o 13º salário${body.fileName ? ` de "${body.fileName}"` : ''} na folha de ${refLabelPT(p.ref)} (${out.applied.length} funcionário(s))`,
      details: { fileName: body.fileName ?? null, docId: body.docId ?? null, ...out },
    });
    return out;
  });

  app.put<{ Params: { id: string } }>('/api/payroll/thirteenth/:id', edit, async (req) => {
    const body = parse(thirteenthUpdateSchema, req.body);
    const t = await loadThirteenth(req.org!.id, req.params.id);
    await assertThirteenthEditable(t);
    if (t.source === 'pdf' && toCents(body.net) !== toCents(t.net)) throw badRequest('O líquido vem do recibo do contador. Para mudar o valor pago, altere o valor a pagar.');
    const emp = await loadEmployee(req.org!.id, t.employeeId);
    await db.transaction(async (tx) => {
      await tx.update(schema.payrollThirteenth).set({ payDate: body.payDate, net: body.net, amount: body.amount, notes: body.notes }).where(eq(schema.payrollThirteenth.id, t.id));
      // parcelas juntas: uma conta, um vencimento
      const partner = t.joined ? await thirteenthPartner(tx, t) : null;
      if (partner?.joined) await tx.update(schema.payrollThirteenth).set({ payDate: body.payDate }).where(eq(schema.payrollThirteenth.id, partner.id));
      await syncThirteenthBill(tx, t.id, req.user!.id);
    });
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (t.payDate !== body.payDate) changes.payDate = { from: t.payDate, to: body.payDate };
    if (toCents(t.net) !== toCents(body.net)) changes.net = { from: t.net, to: body.net };
    if (toCents(t.amount) !== toCents(body.amount)) changes.amount = { from: t.amount, to: body.amount };
    if ((t.notes ?? null) !== body.notes) changes.notes = { from: t.notes, to: body.notes };
    await audit(req, { action: 'payroll.thirteenth.update', entityType: 'payroll_thirteenth', entityId: t.id, description: `Editou o 13º de ${t.year} (${label(t.installment).toLowerCase()}) de ${emp.name}`, details: { changes } });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/payroll/thirteenth/:id', edit, async (req) => {
    const t = await loadThirteenth(req.org!.id, req.params.id);
    await assertThirteenthEditable(t);
    if (t.billId && !req.org!.can(billPerm('payable', 'delete'))) throw forbidden('Apagar o 13º apaga a conta a pagar dele, e você não tem permissão para apagar contas a pagar.');
    const emp = await loadEmployee(req.org!.id, t.employeeId);
    await db.transaction(async (tx) => {
      const partner = t.joined ? await thirteenthPartner(tx, t) : null;
      await deleteThirteenth(tx, [t.id]);
      // a outra parcela volta a ter a conta dela
      if (partner) {
        await tx.update(schema.payrollThirteenth).set({ joined: false }).where(eq(schema.payrollThirteenth.id, partner.id));
        await syncThirteenthBill(tx, partner.id, req.user!.id);
      }
    });
    await audit(req, { action: 'payroll.thirteenth.delete', entityType: 'payroll_thirteenth', entityId: t.id, description: `Apagou o 13º de ${t.year} (${label(t.installment).toLowerCase()}) de ${emp.name}`, details: { snapshot: t } });
    return { ok: true };
  });

  /**
   * Junta a 1ª e a 2ª parcela de cada funcionário escolhido numa conta só (a soma), com um vencimento.
   * As duas parcelas continuam registradas (recibos, linhas); só a conta a pagar vira uma.
   */
  app.post<{ Params: { id: string } }>('/api/payroll/periods/:id/thirteenth/join', edit, async (req) => {
    const body = parse(thirteenthJoinSchema, req.body);
    const orgId = req.org!.id;
    const p = await loadPeriod(orgId, req.params.id);
    const out = await db.transaction(async (tx) => {
      const rows = await tx.select().from(schema.payrollThirteenth).where(and(eq(schema.payrollThirteenth.orgId, orgId), eq(schema.payrollThirteenth.periodId, p.id)));
      const bills = await billStatus(tx, rows.map((r) => r.billId));
      const joined: string[] = [];
      for (const employeeId of body.employeeIds) {
        const first = rows.find((r) => r.employeeId === employeeId && r.installment === 'first');
        const second = first && rows.find((r) => r.employeeId === employeeId && r.installment === 'second' && r.year === first.year);
        if (!first || !second) throw badRequest('Só dá para juntar quem tem a 1ª e a 2ª parcela neste mês.');
        if ([first, second].some((r) => r.billId && bills.get(r.billId) === 'paid')) throw conflict('Uma das parcelas já foi paga. Para juntar, reverta o pagamento antes.');
        await tx.update(schema.payrollThirteenth).set({ joined: true, payDate: body.payDate }).where(inArray(schema.payrollThirteenth.id, [first.id, second.id]));
        await syncThirteenthBill(tx, first.id, req.user!.id);
        joined.push(employeeId);
      }
      return joined;
    });
    const emps = await db.select({ name: schema.employees.name }).from(schema.employees).where(inArray(schema.employees.id, out));
    await audit(req, {
      action: 'payroll.thirteenth.join', entityType: 'payroll_period', entityId: p.id,
      description: `Juntou a 1ª e a 2ª parcela do 13º numa conta só na folha de ${refLabelPT(p.ref)} (${out.length} funcionário(s))`,
      details: { payDate: body.payDate, employees: emps.map((e) => e.name) },
    });
    return { joined: out.length };
  });

  /** Separa as parcelas juntas: cada uma volta a ter a sua conta (a 2ª com o vencimento sugerido). */
  app.post<{ Params: { id: string } }>('/api/payroll/thirteenth/:id/split', edit, async (req) => {
    const t = await loadThirteenth(req.org!.id, req.params.id);
    if (!t.joined) throw badRequest('Estas parcelas não estão juntas.');
    await assertThirteenthEditable(t);
    const emp = await loadEmployee(req.org!.id, t.employeeId);
    const p = await loadPeriod(req.org!.id, t.periodId);
    await db.transaction(async (tx) => {
      const partner = await thirteenthPartner(tx, t);
      const second = t.installment === 'second' ? t : partner;
      await tx.update(schema.payrollThirteenth).set({ joined: false }).where(inArray(schema.payrollThirteenth.id, [t.id, ...(partner ? [partner.id] : [])]));
      if (second) {
        await tx.update(schema.payrollThirteenth).set({ billId: null, payDate: thirteenthDefaultPayDate('second', second.year, p.ref, p.payDate) }).where(eq(schema.payrollThirteenth.id, second.id));
      }
      for (const id of [t.id, ...(partner ? [partner.id] : [])]) await syncThirteenthBill(tx, id, req.user!.id);
    });
    await audit(req, { action: 'payroll.thirteenth.split', entityType: 'payroll_thirteenth', entityId: t.id, description: `Separou a 1ª e a 2ª parcela do 13º de ${t.year} de ${emp.name}` });
    return { ok: true };
  });

  /** Mês da folha de um 13º (link "abrir na folha" de Contas a pagar). */
  app.get<{ Params: { id: string } }>('/api/payroll/thirteenth/:id/ref', view, async (req) => {
    const t = await loadThirteenth(req.org!.id, req.params.id);
    const p = await loadPeriod(req.org!.id, t.periodId);
    return { ref: p.ref, employeeId: t.employeeId };
  });
}
