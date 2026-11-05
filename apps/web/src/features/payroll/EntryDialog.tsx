import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Lock, Minus, Plus, Trash2 } from 'lucide-react';
import { PAYROLL_SECTION_LABEL, formatBRL, payrollTotals, refLabelPT, toCents, type PayrollSection } from '@nopaper/shared';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { Button, Field, Select, Switch, Textarea } from '@/components/ui/base';
import { api, post, put, errMsg } from '@/lib/api';
import { cn } from '@/lib/utils';
import { MoneyInput } from '@/features/bills/MoneyInput';
import { SECTION_HINT, type Employee, type Entry, type Period, type Rubric } from './data';

type LineState = Record<string, { amount: string; note: string | null }>;

export function EntryDialog({ open, onClose, period, entry, employees, rubrics, takenEmployeeIds, canEdit }: {
  open: boolean; onClose: () => void; period: Period; entry: Entry | null; employees: Employee[]; rubrics: Rubric[];
  takenEmployeeIds: string[]; canEdit: boolean;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [employeeId, setEmployeeId] = useState('');
  const [net, setNet] = useState('');
  const [detailed, setDetailed] = useState(false);
  const [lines, setLines] = useState<LineState>({});
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const rmap = useMemo(() => new Map(rubrics.map((r) => [r.id, r])), [rubrics]);
  const paid = entry?.bill?.status === 'paid';
  const readOnly = !canEdit || paid;

  useEffect(() => {
    if (!open) return;
    const ls: LineState = {};
    for (const l of entry?.lines ?? []) ls[l.rubricId] = { amount: l.amount, note: l.note };
    setLines(ls);
    setEmployeeId(entry?.employeeId ?? '');
    setNet(entry ? entry.payslipNet : '');
    setDetailed(!!entry?.lines.some((l) => rmap.get(l.rubricId)?.section === 'payslip'));
    setNotes(entry?.notes ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entry?.id]);

  const lineList = Object.entries(lines).map(([rubricId, v]) => ({ rubricId, amount: v.amount || '0', note: v.note }))
    .filter((l) => detailed || rmap.get(l.rubricId)?.section !== 'payslip');
  const t = payrollTotals(net || '0', lineList, rmap);
  const available = employees.filter((e) => e.active && !takenEmployeeIds.includes(e.id));
  const emp = employees.find((e) => e.id === (entry?.employeeId ?? employeeId));

  const section = (s: PayrollSection) => {
    // ativas + as inativas que já têm valor neste lançamento
    const rs = rubrics.filter((r) => r.section === s && (r.active || toCents(lines[r.id]?.amount) !== 0));
    const order = (r: Rubric) => (r.kind === 'deduction' ? 1 : 0);
    return [...rs].sort((a, b) => order(a) - order(b) || a.sortOrder - b.sortOrder);
  };
  const row = (r: Rubric) => (
    <div key={r.id} className="grid grid-cols-[1fr_150px] items-center gap-3 py-1.5">
      <div className="min-w-0">
        <p className="flex items-center gap-1.5 text-sm">
          {r.section !== 'employer' && (r.kind === 'deduction' ? <Minus className="size-3.5 shrink-0 text-danger" aria-label="desconta" /> : <Plus className="size-3.5 shrink-0 text-ok" aria-label="soma" />)}
          <span className="truncate">{r.name}</span>
          {!r.active && <span className="text-[11px] text-faint">(inativa)</span>}
        </p>
        {lines[r.id]?.note && <p className="truncate pl-5 text-xs text-faint" title={lines[r.id]!.note!}>{lines[r.id]!.note}</p>}
      </div>
      <MoneyInput aria-label={r.name} value={lines[r.id]?.amount ?? ''} disabled={readOnly}
        onChange={(amount) => setLines((p) => ({ ...p, [r.id]: { amount, note: p[r.id]?.note ?? null } }))} />
    </div>
  );

  const save = async () => {
    if (!entry && !employeeId) return;
    setBusy(true);
    try {
      const body = { employeeId: entry?.employeeId ?? employeeId, payslipNet: detailed ? '0' : net || '0', lines: lineList.filter((l) => toCents(l.amount) !== 0), notes };
      if (entry) await put(`/api/payroll/entries/${entry.id}`, body);
      else await post('/api/payroll/entries', { ...body, periodId: period.id });
      qc.invalidateQueries({ queryKey: ['bills'] });
      toast.success(entry ? 'Lançamento atualizado' : 'Funcionário lançado na folha');
      onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!entry) return;
    const ok = await confirm({
      title: `Tirar ${emp?.name ?? 'o funcionário'} da folha de ${refLabelPT(period.ref)}?`, tone: 'danger', confirmLabel: 'Tirar da folha',
      body: entry.billId ? 'O lançamento e a conta a pagar dele neste mês são apagados.' : 'O lançamento deste mês é apagado.',
    });
    if (!ok) return;
    try { await api('DELETE', `/api/payroll/entries/${entry.id}`); qc.invalidateQueries({ queryKey: ['bills'] }); toast.success('Removido da folha'); onClose(); } catch (e) { toast.error(errMsg(e)); }
  };

  const sum = (label: string, v: string, tone?: 'ok' | 'danger' | 'accent' | 'muted', strong?: boolean) => (
    <div className={cn('flex items-baseline justify-between gap-3', strong ? 'py-1' : 'text-sm')}>
      <span className={cn(strong ? 'font-medium' : 'text-muted')}>{label}</span>
      <span className={cn('tnum', strong && 'font-display text-xl font-semibold', tone === 'ok' && 'text-ok', tone === 'danger' && 'text-danger', tone === 'accent' && 'text-accent', tone === 'muted' && 'text-muted')}>{formatBRL(v)}</span>
    </div>
  );

  return (
    <Dialog open={open} onClose={onClose} size="xl"
      title={entry ? `${emp?.name ?? 'Funcionário'} · ${refLabelPT(period.ref)}` : `Lançar funcionário · ${refLabelPT(period.ref)}`}
      description={emp?.role ?? undefined}
      footer={<>
        {entry && canEdit && !paid && <Button variant="ghost" className="mr-auto text-danger hover:text-danger" icon={<Trash2 className="size-4" />} onClick={remove}>Tirar da folha</Button>}
        <Button variant="ghost" onClick={onClose}>{readOnly ? 'Fechar' : 'Cancelar'}</Button>
        {!readOnly && <Button variant="primary" loading={busy} disabled={!entry && !employeeId} onClick={save}>Salvar</Button>}
      </>}>
      {paid && (
        <p className="mb-4 flex items-center gap-2 rounded-lg bg-ok/10 px-3 py-2 text-sm text-ok"><Lock className="size-4 shrink-0" /> Salário já pago — para alterar, reverta o pagamento.</p>
      )}
      <div className="grid gap-5 lg:grid-cols-[1fr_280px]">
        <div className="flex min-w-0 flex-col gap-5">
          {!entry && (
            <Field label="Funcionário" required hint={!available.length ? 'Todos os funcionários ativos já estão neste mês. Cadastre outro na aba Funcionários.' : undefined}>
              <Select value={employeeId} onChange={(e) => setEmployeeId(e.target.value)} autoFocus>
                <option value="">Escolha…</option>
                {available.map((e) => <option key={e.id} value={e.id}>{e.name}{e.role ? ` — ${e.role}` : ''}</option>)}
              </Select>
            </Field>
          )}

          <section>
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pb-2">
              <h3 className="font-display font-semibold">{PAYROLL_SECTION_LABEL.payslip}</h3>
              {!readOnly && <div className="w-56"><Switch checked={detailed} onChange={setDetailed} label="Detalhar holerite" /></div>}
            </div>
            <p className="mt-1.5 text-xs text-faint">{SECTION_HINT.payslip}</p>
            {detailed ? <div className="mt-2 divide-y divide-line/60">{section('payslip').map(row)}</div> : (
              <div className="mt-3 grid grid-cols-[1fr_150px] items-center gap-3">
                <span className="text-sm">Líquido do holerite</span>
                <MoneyInput aria-label="Líquido do holerite" value={net} disabled={readOnly} onChange={setNet} />
              </div>
            )}
          </section>

          <section>
            <h3 className="border-b border-line pb-2 font-display font-semibold">{PAYROLL_SECTION_LABEL.extra}</h3>
            <p className="mt-1.5 text-xs text-faint">{SECTION_HINT.extra}</p>
            <div className="mt-2 divide-y divide-line/60">{section('extra').map(row)}</div>
          </section>

          <section>
            <h3 className="border-b border-line pb-2 font-display font-semibold">{PAYROLL_SECTION_LABEL.employer}</h3>
            <p className="mt-1.5 text-xs text-faint">{SECTION_HINT.employer}</p>
            <div className="mt-2 divide-y divide-line/60">{section('employer').map(row)}</div>
          </section>

          <Field label="Observações"><Textarea value={notes} disabled={readOnly} maxLength={1000} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>

        <aside className="flex flex-col gap-2 self-start rounded-xl border border-line bg-surface-2/50 p-4 lg:sticky lg:top-0">
          {t.detailed && sum('Proventos do holerite', t.payslipEarnings)}
          {t.detailed && sum('Descontos do holerite', t.payslipDeductions, 'danger')}
          {sum('Líquido do holerite', t.payslipNet)}
          {sum('Extras', t.extraEarnings, 'ok')}
          {sum('Descontos (produtos/vales)', t.extraDeductions, 'danger')}
          <div className="my-1 h-px bg-line" />
          {sum('A pagar', t.total, undefined, true)}
          {sum('Pelo holerite', t.onPayroll, 'muted')}
          {sum('Por fora', t.offPayroll, 'accent')}
          <div className="my-1 h-px bg-line" />
          {sum('Encargos', t.employerCost, 'muted')}
          {sum('Custo para a empresa', t.companyCost)}
          <p className="mt-2 text-xs text-faint leading-relaxed">
            {period.billsEnabled
              ? <>O valor a pagar vira a conta “Salário {emp?.name ?? '…'} – {refLabelPT(period.ref)}” em Contas a pagar.</>
              : <>Mês do histórico importado: não gera conta a pagar.</>}
          </p>
        </aside>
      </div>
    </Dialog>
  );
}
