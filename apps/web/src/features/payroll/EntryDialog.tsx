import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, Check, CircleCheck, Ghost, Lock, Minus, Plus, Trash2 } from 'lucide-react';
import { FGTS_PCT, PAYROLL_SECTION_LABEL, employerInssPct, formatBRL, payrollTotals, payslipCheck, refLabelPT, toCents, type PayrollCosts, type PayrollSection } from '@nopaper/shared';
import { Dialog, SaveFooter, useConfirm } from '@/components/ui/dialog';
import { Button, Field, IconButton, Select, Switch, Textarea } from '@/components/ui/base';
import { api, post, put, errMsg } from '@/lib/api';
import { cn } from '@/lib/utils';
import { MoneyInput } from '@/features/bills/MoneyInput';
import { SECTION_HINT, useRubricMove, type Employee, type Entry, type Period, type Rubric } from './data';

type LineState = Record<string, { amount: string; note: string | null }>;

export function EntryDialog({ open, onClose, onCreated, period, entry, employees, rubrics, costs, takenEmployeeIds, canEdit, canManage }: {
  open: boolean; onClose: () => void; onCreated: (id: string) => void; period: Period; entry: Entry | null; employees: Employee[]; rubrics: Rubric[]; costs: PayrollCosts;
  takenEmployeeIds: string[]; canEdit: boolean; canManage: boolean;
}) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [employeeId, setEmployeeId] = useState('');
  /** Líquido do holerite: o valor pago (não detalhado) ou o valor para conferência (detalhado). */
  const [net, setNet] = useState('');
  const [detailed, setDetailed] = useState(false);
  const [lines, setLines] = useState<LineState>({});
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  /** Foto do formulário no último carregar/salvar (alterações não salvas = diferente da atual). */
  const [base, setBase] = useState('');
  const snap = (v: { employeeId: string; net: string; detailed: boolean; lines: LineState; notes: string }) =>
    JSON.stringify({ ...v, lines: Object.entries(v.lines).filter(([, x]) => toCents(x.amount) !== 0).map(([k, x]) => [k, toCents(x.amount), x.note ?? null]).sort() });
  const dirty = open && snap({ employeeId, net, detailed, lines, notes }) !== base;
  /** Seção em modo "ordenar" (setas no lugar dos valores); a ordem vale para todos os lançamentos. */
  const [sorting, setSorting] = useState<PayrollSection | null>(null);
  const moveRubric = useRubricMove();
  const rmap = useMemo(() => new Map(rubrics.map((r) => [r.id, r])), [rubrics]);
  const paid = entry?.bill?.status === 'paid';
  const readOnly = !canEdit || paid;

  useEffect(() => {
    if (!open) return;
    const ls: LineState = {};
    for (const l of entry?.lines ?? []) ls[l.rubricId] = { amount: l.amount, note: l.note };
    setLines(ls);
    setEmployeeId(entry?.employeeId ?? '');
    const isDetailed = !!entry?.lines.some((l) => rmap.get(l.rubricId)?.section === 'payslip');
    const n = entry ? (isDetailed ? entry.payslipNetDeclared ?? '' : entry.payslipNet) : '';
    setNet(n);
    setDetailed(isDetailed);
    setNotes(entry?.notes ?? '');
    setSorting(null);
    setBase(snap({ employeeId: entry?.employeeId ?? '', net: n, detailed: isDetailed, lines: ls, notes: entry?.notes ?? '' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, entry?.id]);

  const lineList = Object.entries(lines).map(([rubricId, v]) => ({ rubricId, amount: v.amount || '0', note: v.note }))
    .filter((l) => detailed || rmap.get(l.rubricId)?.section !== 'payslip');
  const emp = employees.find((e) => e.id === (entry?.employeeId ?? employeeId));
  const ghost = !!emp?.payslipOnly;
  const t = payrollTotals(detailed ? '0' : net || '0', lineList, rmap, costs, { payslipOnly: ghost });
  // detalhado: a soma das rubricas tem de bater com o valor líquido do holerite
  const check = payslipCheck(detailed ? net : null, t.payslipNet);
  const mismatch = detailed && check.state === 'mismatch';
  const available = employees.filter((e) => e.active && !takenEmployeeIds.includes(e.id));

  const section = (s: PayrollSection) => {
    // ativas + as inativas que já têm valor neste lançamento
    // na ordem definida em Configurar → Rubricas
    return rubrics.filter((r) => r.section === s && (r.active || toCents(lines[r.id]?.amount) !== 0));
  };
  // a ordem é configuração geral (não muda o lançamento): disponível até em salário já pago
  const sortHeader = (s: PayrollSection) => canManage && (
    <Button size="sm" variant={sorting === s ? 'primary' : 'ghost'} icon={sorting === s ? <Check className="size-4" /> : <ArrowUpDown className="size-4" />}
      onClick={() => setSorting(sorting === s ? null : s)}>{sorting === s ? 'Pronto' : 'Ordenar'}</Button>
  );
  const row = (r: Rubric, i: number, list: Rubric[]) => sorting === r.section ? (
    <div key={r.id} className="flex items-center gap-2 py-1.5">
      <IconButton label="Subir" disabled={i === 0} onClick={() => moveRubric(rubrics, list, r, -1)}><ArrowUp className="size-4" /></IconButton>
      <IconButton label="Descer" disabled={i === list.length - 1} onClick={() => moveRubric(rubrics, list, r, 1)}><ArrowDown className="size-4" /></IconButton>
      <span className="min-w-0 truncate text-sm">{r.name}</span>
      {toCents(lines[r.id]?.amount) !== 0 && <span className="ml-auto shrink-0 text-xs text-faint tnum">{formatBRL(lines[r.id]!.amount)}</span>}
    </div>
  ) : (
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
      const body = {
        employeeId: entry?.employeeId ?? employeeId, payslipNet: detailed ? '0' : net || '0', payslipNetDeclared: detailed && net ? net : null,
        lines: lineList.filter((l) => toCents(l.amount) !== 0), notes,
      };
      const saved = snap({ employeeId, net, detailed, lines, notes });
      if (entry) await put(`/api/payroll/entries/${entry.id}`, body);
      else { const r = await post<{ id: string }>('/api/payroll/entries', { ...body, periodId: period.id }); onCreated(r.id); }
      await qc.invalidateQueries({ queryKey: ['bills'] });
      toast.success(entry ? 'Lançamento salvo' : 'Funcionário lançado na folha');
      setBase(saved);
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
    <Dialog open={open} onClose={onClose} dirty={dirty && !readOnly} size="xl"
      title={entry ? `${emp?.name ?? 'Funcionário'} · ${refLabelPT(period.ref)}` : `Lançar funcionário · ${refLabelPT(period.ref)}`}
      description={emp?.role ?? undefined}
      footer={<SaveFooter dirty={dirty} isNew={!entry} readOnly={readOnly} saving={busy} canSave={!(!entry && !employeeId) && !mismatch} onSave={save} onClose={onClose}
        left={entry && canEdit && !paid && <Button variant="ghost" className="mr-auto text-danger hover:text-danger" icon={<Trash2 className="size-4" />} onClick={remove}>Tirar da folha</Button>} />}>
      {paid && (
        <p className="mb-4 flex items-center gap-2 rounded-lg bg-ok/10 px-3 py-2 text-sm text-ok"><Lock className="size-4 shrink-0" /> Salário já pago — para alterar, reverta o pagamento.</p>
      )}
      {ghost && (
        <p className="mb-4 flex items-start gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted"><Ghost className="mt-0.5 size-4 shrink-0" /> Só holerite: {emp?.name} tem holerite, mas não recebe pela empresa. O holerite fica registrado; o valor a pagar e o custo ficam zerados e não há conta a pagar. (Muda no cadastro do funcionário.)</p>
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
              <div className="flex items-center gap-2">
                {detailed && sortHeader('payslip')}
                {!readOnly && <div className="w-48"><Switch checked={detailed} onChange={setDetailed} label="Detalhar holerite" /></div>}
              </div>
            </div>
            <p className="mt-1.5 text-xs text-faint">{SECTION_HINT.payslip}</p>
            {detailed ? (
              <>
                <div className="mt-2 divide-y divide-line/60">{section('payslip').map(row)}</div>
                <div className="mt-3 grid grid-cols-3 overflow-hidden rounded-xl border border-line text-right">
                  {([['Total de vantagens', t.payslipEarnings, ''], ['Total de descontos', t.payslipDeductions, 'text-danger'], ['Valor líquido', t.payslipNet, 'font-semibold']] as const).map(([label, v, tone], i) => (
                    <div key={label} className={cn('min-w-0 px-2.5 py-2 sm:px-3', i > 0 && 'border-l border-line', i === 2 && 'bg-surface-2/60')}>
                      <p className="truncate text-[11px] text-muted sm:text-xs">{label}</p>
                      <p className={cn('tnum text-sm sm:text-base', tone)}>{formatBRL(v)}</p>
                    </div>
                  ))}
                </div>
                <div className="mt-3 grid grid-cols-[1fr_150px] items-center gap-3">
                  <span className="min-w-0 text-sm">
                    <span className="font-medium">Valor líquido do holerite</span>
                    <span className="block text-xs text-faint">Digite o valor do papel para conferir.</span>
                  </span>
                  <MoneyInput aria-label="Valor líquido do holerite" value={net} disabled={readOnly} onChange={setNet} />
                </div>
                {check.state === 'ok' && <p className="mt-2 flex items-center gap-2 rounded-lg bg-ok/10 px-3 py-2 text-sm text-ok"><CircleCheck className="size-4 shrink-0" /> Confere com o holerite.</p>}
                {check.state === 'mismatch' && (
                  <p className="mt-2 flex items-start gap-2 rounded-lg bg-danger/10 px-3 py-2 text-sm text-danger">
                    <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                    <span>Não fecha: {check.diff > 0 ? 'faltam' : 'sobram'} <b className="tnum">{formatBRL(Math.abs(check.diff) / 100)}</b> nas rubricas
                      ({check.diff > 0 ? 'algum provento não lançado ou desconto a mais' : 'algum desconto não lançado ou provento a mais'}). Confira antes de salvar.</span>
                  </p>
                )}
                {check.state === 'missing' && !readOnly && <p className="mt-2 flex items-center gap-2 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn"><AlertTriangle className="size-4 shrink-0" /> Sem conferência: informe o valor líquido do holerite.</p>}
              </>
            ) : (
              <div className="mt-3 grid grid-cols-[1fr_150px] items-center gap-3">
                <span className="text-sm">Líquido do holerite</span>
                <MoneyInput aria-label="Líquido do holerite" value={net} disabled={readOnly} onChange={setNet} />
              </div>
            )}
          </section>

          <section>
            <div className="flex items-center justify-between gap-2 border-b border-line pb-1.5"><h3 className="font-display font-semibold">{PAYROLL_SECTION_LABEL.extra}</h3>{sortHeader('extra')}</div>
            <p className="mt-1.5 text-xs text-faint">{SECTION_HINT.extra}</p>
            <div className="mt-2 divide-y divide-line/60">{section('extra').map(row)}</div>
          </section>

          <section>
            <div className="flex items-center justify-between gap-2 border-b border-line pb-1.5"><h3 className="font-display font-semibold">{PAYROLL_SECTION_LABEL.employer}</h3>{sortHeader('employer')}</div>
            <p className="mt-1.5 text-xs text-faint">{SECTION_HINT.employer}</p>
            <div className="mt-2 divide-y divide-line/60">{section('employer').map(row)}</div>
          </section>

          <Field label="Observações"><Textarea value={notes} disabled={readOnly} maxLength={1000} onChange={(e) => setNotes(e.target.value)} /></Field>
        </div>

        <aside className="flex flex-col gap-2 self-start rounded-xl border border-line bg-surface-2/50 p-4 lg:sticky lg:top-0">
          {t.detailed && sum('Total de vantagens', t.payslipEarnings)}
          {t.detailed && sum('Total de descontos', t.payslipDeductions, 'danger')}
          {sum('Líquido do holerite', t.payslipNet)}
          {sum('Extras', t.extraEarnings, 'ok')}
          {sum('Descontos (produtos/vales)', t.extraDeductions, 'danger')}
          <div className="my-1 h-px bg-line" />
          {sum('A pagar', t.total, undefined, true)}
          {sum('Pelo holerite', t.onPayroll, 'muted')}
          {sum('Por fora', t.offPayroll, 'accent')}
          <div className="my-1 h-px bg-line" />
          <p className="text-xs font-medium uppercase tracking-wide text-faint">Custo para a empresa</p>
          {sum(t.detailed ? 'Salário bruto (holerite)' : 'Líquido do holerite', t.detailed ? t.payslipEarnings : t.payslipNet, 'muted')}
          {toCents(t.extraEarnings) > 0 && sum('Extras (fora do holerite)', t.extraEarnings, 'muted')}
          {t.detailed && sum(`FGTS ${FGTS_PCT}%`, t.fgts, 'muted')}
          {t.detailed && (employerInssPct(costs) > 0
            ? sum(`INSS patronal ${employerInssPct(costs).toLocaleString('pt-BR')}%`, t.employerInss, 'muted')
            : <div className="flex items-baseline justify-between gap-3 text-sm"><span className="text-muted">INSS patronal</span><span className="text-xs text-faint">no DAS (Simples)</span></div>)}
          {t.detailed && toCents(t.provisions) > 0 && <>
            {sum('Reserva 13º salário', t.provision13, 'muted')}
            {sum('Reserva férias + 1/3', t.provisionVacation, 'muted')}
            {sum('Encargos das reservas', t.provisionCharges, 'muted')}
          </>}
          {toCents(t.otherCosts) > 0 && sum('Outros custos', t.otherCosts, 'muted')}
          {sum('Custo total no mês', t.companyCost, undefined, true)}
          {!t.detailed && !ghost && <p className="text-xs text-warn">Detalhe o holerite para calcular FGTS, 13º e férias — sem o bruto, o custo fica incompleto.</p>}
          <p className="mt-2 text-xs text-faint leading-relaxed">
            {ghost ? <>Só holerite: não gera conta a pagar.</> : period.billsEnabled
              ? <>O valor a pagar vira a conta “Salário {emp?.name ?? '…'} – {refLabelPT(period.ref)}” em Contas a pagar.</>
              : <>Mês do histórico importado: não gera conta a pagar.</>}
          </p>
        </aside>
      </div>
    </Dialog>
  );
}
