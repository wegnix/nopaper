/**
 * 13º salário na folha: cada funcionário e parcela vira um pagamento com vencimento e conta a pagar
 * próprios, no mês da folha em que é pago (separado do salário do mês).
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { and, eq, inArray } from 'drizzle-orm';
import {
  THIRTEENTH_LABEL, billPerm, parsePayslips, refLabelPT, thirteenthApplySchema, thirteenthClash, thirteenthUpdateSchema, toCents,
  type Permission, type ThirteenthInstallment,
} from '@nopaper/shared';
import { db, schema } from '../db/client.js';
import { env } from '../env.js';
import { parse } from '../lib/validate.js';
import { badRequest, conflict, forbidden } from '../lib/errors.js';
import { requirePerm } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { pdfToCells } from '../services/pdf.js';
import { checkPayslipsSpace } from '../services/spaceCheck.js';
import {
  assertCompany, assertThirteenthEditable, assertThirteenthSlips, deleteThirteenth, loadEmployee, loadPeriod, loadThirteenth, syncThirteenthBill,
} from '../services/payroll.js';

const guard = (...p: Permission[]) => ({ preHandler: [requirePerm(...p), async (req: FastifyRequest) => { assertCompany(req); }] });
const view = guard('payroll.view');
const edit = guard('payroll.edit');

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
          periodId: p.id, payDate: it.payDate, net: it.net, amount: it.amount, gross: it.gross ?? null, fgts: it.fgts ?? null,
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
    await db.transaction((tx) => deleteThirteenth(tx, [t.id]));
    await audit(req, { action: 'payroll.thirteenth.delete', entityType: 'payroll_thirteenth', entityId: t.id, description: `Apagou o 13º de ${t.year} (${label(t.installment).toLowerCase()}) de ${emp.name}`, details: { snapshot: t } });
    return { ok: true };
  });

  /** Mês da folha de um 13º (link "abrir na folha" de Contas a pagar). */
  app.get<{ Params: { id: string } }>('/api/payroll/thirteenth/:id/ref', view, async (req) => {
    const t = await loadThirteenth(req.org!.id, req.params.id);
    const p = await loadPeriod(req.org!.id, t.periodId);
    return { ref: p.ref, employeeId: t.employeeId };
  });
}
