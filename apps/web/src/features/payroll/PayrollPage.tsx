import { useEffect, useMemo, useState } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowDown, ArrowUp, BadgePercent, Banknote, CalendarDays, AlertTriangle, Check, ChevronLeft, ChevronRight, FileSpreadsheet, HandCoins, Landmark, MoreHorizontal, Pencil, Plus, Printer,
  Receipt, RotateCcw, Settings2, Trash2, UserPlus, UsersRound, Wallet,
} from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { MONTHS_PT, PAYROLL_PRINT_FIXED, addMonthsRef, mergePrintOrder, type PayrollPrintSettings, formatBRL, formatDateBR, fromCents, payrollTotals, payslipCheck, refLabelPT, sumMoney, toCents, todayISO, type AttachmentSlot } from '@nopaper/shared';
import { Button, Card, Checkbox, Empty, Field, IconButton, Input, PageHeader, Segmented, Spinner, Switch, Textarea } from '@/components/ui/base';
import { StatusChip } from '@/components/ui/chips';
import { Dialog, SaveFooter, useConfirm, useFormState } from '@/components/ui/dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { api, get, post, put, errMsg } from '@/lib/api';
import { useCan, useOrg } from '@/lib/session';
import { cn, plural } from '@/lib/utils';
import type { Bill } from '@/lib/types';
import { CountUp } from '@/features/bills/KpiRibbon';
import { PayDialog } from '@/features/bills/dialogs';
import { FileViewer, type FileViewerTarget } from '@/features/bills/FileViewer';
import { useCommissionImport, useMonth, usePayrollMeta, usePeriods, type Entry, type Period, type PeriodSummary, type Rubric } from './data';
import { EntryDialog } from './EntryDialog';
import { EmployeesTab } from './Employees';
import { SettingsDialog, type SettingsTab } from './SettingsDialog';
import { CommissionsDialog } from './Commissions';
import { ImportDialog } from './ImportDialog';
import { PayrollPrint, amountOf, extraColumnsOf, printColumnsOf, type PrintRow } from './PayrollPrint';

type Tab = 'mes' | 'funcionarios' | 'historico';

export function PayrollPage() {
  const org = useOrg();
  const can = useCan();
  const [sp, setSp] = useSearchParams();
  const tab = (['mes', 'funcionarios', 'historico'].includes(sp.get('aba') ?? '') ? sp.get('aba') : 'mes') as Tab;
  const ref = /^\d{4}-\d{2}$/.test(sp.get('mes') ?? '') ? sp.get('mes')! : todayISO().slice(0, 7);
  const set = (patch: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) v === null ? n.delete(k) : n.set(k, v); setSp(n, { replace: true }); };
  const meta = usePayrollMeta();
  const periods = usePeriods();
  const [settingsOpen, setSettingsOpen] = useState<SettingsTab | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [salesOpen, setSalesOpen] = useState(false);
  const [openEntryId, setOpenEntryId] = useState<string | null>(null);

  // vindo de Contas a pagar: ?lancamento=<id> → abre o mês e o lançamento
  const target = sp.get('lancamento');
  useEffect(() => {
    if (!target) return;
    get<{ ref: string }>(`/api/payroll/entries/${target}/ref`)
      .then((r) => { set({ lancamento: null, mes: r.ref, aba: null }); setOpenEntryId(target); })
      .catch((e) => { toast.error(errMsg(e)); set({ lancamento: null }); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);

  if (org && org.kind !== 'company') return <Navigate to="/" replace />;
  if (meta.isLoading) return <div className="grid place-items-center py-24"><Spinner /></div>;
  if (!meta.data) return <Card><Empty title="Não foi possível carregar a folha">{meta.error ? errMsg(meta.error) : null}</Empty></Card>;
  const { settings, rubrics, employees } = meta.data;
  const canManage = can('payroll.manage');

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <PageHeader title="Folha de pagamento"
        description="Holerite, metas, comissões e descontos de cada funcionário, mês a mês. Cada salário vira uma conta a pagar."
        actions={(canManage || can('payroll.edit')) && <>
          {can('payroll.edit') && <Button variant="ghost" icon={<BadgePercent className="size-4" />} onClick={() => setSalesOpen(true)}>Importar vendas</Button>}
          {canManage && <Button variant="ghost" icon={<FileSpreadsheet className="size-4" />} onClick={() => setImportOpen(true)}>Importar planilha</Button>}
          {canManage && <Button variant="secondary" icon={<Settings2 className="size-4" />} onClick={() => setSettingsOpen('bills')}>Configurar</Button>}
        </>} />

      <Segmented className="self-start max-sm:self-stretch" value={tab} onChange={(v) => set({ aba: v === 'mes' ? null : v })} options={[
        { value: 'mes', label: 'Mês' }, { value: 'funcionarios', label: `Funcionários (${employees.filter((e) => e.active).length})` }, { value: 'historico', label: 'Histórico' },
      ]} />

      {!settings.categoryId && canManage && (
        <p className="rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn">Escolha a categoria das contas de salário em <button className="font-medium underline" onClick={() => setSettingsOpen('bills')}>Configurar</button> antes de abrir o primeiro mês.</p>
      )}

      {tab === 'mes' && <MonthView refStr={ref} onRef={(r) => set({ mes: r })} openEntryId={openEntryId} onEntryOpened={() => setOpenEntryId(null)} onConfigure={() => setSettingsOpen('commissions')} />}
      {tab === 'funcionarios' && <EmployeesTab employees={employees} canManage={canManage} onOpenMonth={(r) => set({ aba: null, mes: r })} />}
      {tab === 'historico' && <HistoryView periods={periods.data ?? []} loading={periods.isLoading} onOpen={(r) => set({ aba: null, mes: r })} />}

      <SettingsDialog open={!!settingsOpen} initialTab={settingsOpen ?? 'bills'} onClose={() => setSettingsOpen(null)} settings={settings} rubrics={rubrics} employees={employees} />
      <CommissionsDialog open={salesOpen} onClose={() => setSalesOpen(false)} periods={periods.data ?? []} currentRef={ref} employees={employees} rubrics={rubrics}
        commissions={settings.commissions} canManage={canManage} onConfigure={() => setSettingsOpen('commissions')} onDone={(r) => set({ aba: null, mes: r })} />
      <ImportDialog open={importOpen} onClose={() => setImportOpen(false)} rubrics={rubrics} existingRefs={(periods.data ?? []).map((p) => p.ref)} onDone={(r) => set({ aba: 'historico', mes: r })} />
    </div>
  );
}

// ------------------------------------------------------------------ mês
function MonthView({ refStr: ref, onRef, openEntryId, onEntryOpened, onConfigure }: { refStr: string; onRef: (r: string) => void; openEntryId: string | null; onEntryOpened: () => void; onConfigure: () => void }) {
  const can = useCan();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const meta = usePayrollMeta().data!;
  const month = useMonth(ref);
  const m = month.data;
  const period = m?.period ?? null;
  const canEdit = can('payroll.edit');
  const canPay = can('payable.pay');
  const empMap = useMemo(() => new Map(meta.employees.map((e) => [e.id, e])), [meta.employees]);
  const rmap = useMemo(() => new Map(meta.rubrics.map((r) => [r.id, r])), [meta.rubrics]);
  const [entryDlg, setEntryDlg] = useState<{ open: boolean; entry: Entry | null }>({ open: false, entry: null });
  const [openDlg, setOpenDlg] = useState(false);
  const [editPeriod, setEditPeriod] = useState(false);
  const [pay, setPay] = useState<{ bill: Bill; proofOnly: boolean } | null>(null);
  const [viewer, setViewer] = useState<FileViewerTarget | null>(null);
  const [printOpen, setPrintOpen] = useState(false);
  // último relatório de vendas importado neste mês (comissões): dá para rever a tela
  const commImport = useCommissionImport(period?.id ?? null).data ?? null;
  const periodsList = usePeriods().data ?? [];
  const [commOpen, setCommOpen] = useState(false);
  const commRubrics = new Set(meta.settings.commissions.rules.filter((r) => r.active).map((r) => r.rubricId));
  const commTotal = sumMoney((m?.entries ?? []).flatMap((e) => e.lines.filter((l) => commRubrics.has(l.rubricId)).map((l) => l.amount)));
  /** Lançamento recém-criado: a janela passa a editá-lo assim que o mês recarregar. */
  const [createdId, setCreatedId] = useState<string | null>(null);
  useEffect(() => {
    const e = createdId ? m?.entries.find((x) => x.id === createdId) : null;
    if (e) { setEntryDlg((d) => (d.open ? { open: true, entry: e } : d)); setCreatedId(null); }
  }, [createdId, m]);
  const [printCfg, setPrintCfg] = useState<PayrollPrintSettings>(meta.settings.print);
  useEffect(() => setPrintCfg(meta.settings.print), [meta.settings.print]);
  /** Guarda as colunas escolhidas (no espaço, quando pode) e abre a impressão do navegador. */
  const doPrint = async (hidden: string[], monthOrder: string[]) => {
    // guarda também a posição das colunas que não aparecem neste mês (extras sem valor)
    const next: PayrollPrintSettings = { hidden, order: mergePrintOrder(meta.settings.print.order, monthOrder) };
    setPrintCfg(next);
    setPrintOpen(false);
    if (canEdit && JSON.stringify(next) !== JSON.stringify(meta.settings.print)) {
      put('/api/payroll/settings/print', next).then(() => qc.invalidateQueries({ queryKey: ['bills'] })).catch((e) => toast.error(errMsg(e)));
    }
    setTimeout(() => window.print(), 250); // depois do diálogo fechar e a folha remontar
  };
  const today = todayISO();

  useEffect(() => {
    if (!openEntryId || !m) return;
    const e = m.entries.find((x) => x.id === openEntryId);
    if (e) { setEntryDlg({ open: true, entry: e }); onEntryOpened(); }
  }, [openEntryId, m, onEntryOpened]);

  const entries = useMemo(() => [...(m?.entries ?? [])].sort((a, b) => (empMap.get(a.employeeId)?.name ?? '').localeCompare(empMap.get(b.employeeId)?.name ?? '', 'pt-BR')), [m, empMap]);
  const rows = entries.map((e) => ({ e, emp: empMap.get(e.employeeId), t: payrollTotals(e.payslipNet, e.lines, rmap, meta.settings.costs) }));
  const k = {
    total: sumMoney(rows.map((r) => r.t.total)), net: sumMoney(rows.map((r) => r.t.payslipNet)),
    // descontos maiores que os extras saem do próprio líquido: o depósito fica abaixo do holerite
    netCut: sumMoney(rows.map((r) => fromCents(Math.max(0, toCents(r.t.payslipNet) - toCents(r.t.onPayroll))))), off: sumMoney(rows.map((r) => r.t.offPayroll)),
    extras: sumMoney(rows.map((r) => r.t.extraEarnings)), employer: sumMoney(rows.flatMap((r) => [r.t.employerCost, r.t.provisions])), cost: sumMoney(rows.map((r) => r.t.companyCost)),
    paid: rows.filter((r) => r.e.bill?.status === 'paid').length, bills: rows.filter((r) => r.e.bill).length,
  };

  /** Holerite detalhado sem o valor líquido para conferir (ex.: mês aberto copiando as rubricas fixas). */
  const unchecked = (e: Entry, t: { detailed: boolean; payslipNet: string }) => t.detailed && payslipCheck(e.payslipNetDeclared, t.payslipNet).state !== 'ok';
  /** Desconto maior que os extras: o resto sai do líquido e o depósito fica abaixo do holerite. */
  const cutNote = (t: { payslipNet: string; onPayroll: string }) => {
    const cut = toCents(t.payslipNet) - toCents(t.onPayroll);
    return cut > 0 && (
      <span className="flex items-center gap-1 text-xs text-warn" title={`Os descontos passam dos extras em ${formatBRL(cut / 100)}: o depósito é ${formatBRL(t.onPayroll)}, abaixo do líquido do holerite.`}>
        <AlertTriangle className="size-3 shrink-0" /> desconto maior que os extras · deposita {formatBRL(t.onPayroll)}
      </span>
    );
  };
  const status = (e: Entry) => {
    if (!period?.billsEnabled) return <StatusChip status="pending" label="Histórico" />;
    if (!e.bill) return <span className="text-xs text-faint">sem conta</span>;
    if (e.bill.status === 'paid') return <StatusChip status="paid" label={`Pago ${formatDateBR(e.bill.paidAt).slice(0, 5)}`} />;
    if (e.bill.dueDate < today) return <StatusChip status="overdue" label="Atrasado" />;
    if (e.bill.dueDate === today) return <StatusChip status="today" label="Vence hoje" />;
    return <StatusChip status="pending" label="Pendente" />;
  };
  const unpay = async (b: Bill) => {
    if (!(await confirm({ title: 'Reverter o pagamento?', body: 'O salário volta para Pendente aqui e em Contas a pagar, e o lançamento pode ser editado de novo.', confirmLabel: 'Reverter' }))) return;
    try { await post(`/api/bills/${b.id}/unpay`); qc.invalidateQueries({ queryKey: ['bills'] }); toast.success('Pagamento revertido'); } catch (e) { toast.error(errMsg(e)); }
  };
  const enableBills = async () => {
    if (!period) return;
    if (!(await confirm({ title: `Gerar as contas a pagar de ${refLabelPT(ref)}?`, body: `Cria ${plural(rows.filter((r) => toCents(r.t.total) > 0).length, 'conta', 'contas')} de salário com vencimento em ${formatDateBR(period.payDate)}. Use para um mês importado que ainda vai ser pago.`, confirmLabel: 'Gerar contas' }))) return;
    try { await post(`/api/payroll/periods/${period.id}/enable-bills`); qc.invalidateQueries({ queryKey: ['bills'] }); toast.success('Contas a pagar criadas'); } catch (e) { toast.error(errMsg(e)); }
  };
  const view = (b: Bill, slot: AttachmentSlot) => { const a = b.attachments[slot]; if (a) setViewer({ attachmentId: a.id, slot, title: b.description }); };

  const rowMenu = (e: Entry) => {
    const b = e.bill;
    const items = [
      b && b.status === 'paid' && canPay && { label: 'Comprovante', icon: Receipt, on: () => setPay({ bill: b, proofOnly: true }) },
      b && b.status === 'paid' && canPay && { label: 'Reverter pagamento', icon: RotateCcw, on: () => unpay(b) },
      b && { label: 'Ver em Contas a pagar', icon: Wallet, href: `/pagar?ano=${b.dueDate.slice(0, 4)}&mes=${Number(b.dueDate.slice(5, 7))}&situacao=` },
    ].filter(Boolean) as Array<{ label: string; icon: typeof Receipt; on?: () => void; href?: string }>;
    if (!items.length) return null;
    return (
      <DropdownMenu.Root>
        <DropdownMenu.Trigger onClick={(ev) => ev.stopPropagation()} className="grid size-8 pointer-coarse:size-10 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink" aria-label="Mais ações"><MoreHorizontal className="size-4" /></DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={4} onClick={(ev) => ev.stopPropagation()} className="z-[6000] w-56 rounded-xl border border-line bg-raised p-1.5 shadow-2xl text-sm">
            {items.map((i) => i.href
              ? <DropdownMenu.Item key={i.label} asChild><Link to={i.href} className="flex items-center gap-2 rounded-lg px-2 py-2 outline-none data-[highlighted]:bg-surface-2 cursor-pointer"><i.icon className="size-4 text-faint" /> {i.label}</Link></DropdownMenu.Item>
              : <DropdownMenu.Item key={i.label} onSelect={i.on} className="flex items-center gap-2 rounded-lg px-2 py-2 outline-none data-[highlighted]:bg-surface-2 cursor-pointer"><i.icon className="size-4 text-faint" /> {i.label}</DropdownMenu.Item>)}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    );
  };
  const payBtn = (e: Entry) => e.bill?.status === 'pending' && canPay && (
    <Button size="sm" variant="ok" className="h-7 px-2.5" icon={<Check className="size-3.5" />} onClick={(ev) => { ev.stopPropagation(); setPay({ bill: e.bill!, proofOnly: false }); }}>Pagar</Button>
  );

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 sm:gap-4 border-b border-line p-3 sm:p-4 md:p-5">
        <div className="flex items-center rounded-lg border border-line bg-surface-2">
          <button className="grid size-10 place-items-center text-muted hover:text-ink" onClick={() => onRef(addMonthsRef(ref, -1))} aria-label="Mês anterior"><ChevronLeft className="size-4" /></button>
          <span className="min-w-[110px] text-center font-display font-semibold">{refLabelPT(ref)}</span>
          <button className="grid size-10 place-items-center text-muted hover:text-ink" onClick={() => onRef(addMonthsRef(ref, 1))} aria-label="Próximo mês"><ChevronRight className="size-4" /></button>
        </div>
        {ref !== today.slice(0, 7) && <button className="text-xs text-accent hover:underline" onClick={() => onRef(today.slice(0, 7))}>ir para o mês atual</button>}
        {period && (
          <span className="flex items-center gap-1.5 text-sm text-muted"><CalendarDays className="size-4 text-faint" />
            {period.billsEnabled ? <>Pagamento em <b className="font-medium text-ink">{formatDateBR(period.payDate)}</b></> : 'Importado do histórico'}
          </span>
        )}
        <div className="ml-auto flex flex-wrap gap-2 max-sm:ml-0 max-sm:w-full max-sm:[&>button]:flex-1">
          {period && rows.length > 0 && <Button variant="ghost" icon={<Printer className="size-4" />} onClick={() => setPrintOpen(true)}>Imprimir</Button>}
          {period && canEdit && <Button variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setEditPeriod(true)}>Editar mês</Button>}
          {period && canEdit && <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setEntryDlg({ open: true, entry: null })}>Lançar funcionário</Button>}
        </div>
      </div>

      {month.isLoading ? <div className="grid place-items-center py-20"><Spinner /></div> : !period ? (
        <Empty icon={<UsersRound className="size-5" />} title={`A folha de ${MONTHS_PT[Number(ref.slice(5)) - 1].toLowerCase()} de ${ref.slice(0, 4)} ainda não foi aberta`}
          action={canEdit && <Button variant="primary" icon={<Plus className="size-4" />} disabled={!meta.settings.categoryId} onClick={() => setOpenDlg(true)}>Abrir folha de {refLabelPT(ref)}</Button>}>
          Ao abrir, os funcionários ativos entram com o líquido do holerite e as rubricas fixas do último mês de cada um. Depois é só lançar metas, comissões e descontos.
        </Empty>
      ) : (
        <>
          <div className="flex max-sm:snap-x max-sm:snap-mandatory max-sm:overflow-x-auto no-scrollbar sm:grid sm:grid-cols-3 xl:grid-cols-6 border-b border-line">
            <Kpi icon={HandCoins} label="A pagar" value={k.total} sub={plural(rows.length, 'funcionário', 'funcionários')} tone="accent" first />
            <Kpi icon={Landmark} label="Líquido dos holerites" value={k.net} sub={toCents(k.netCut) > 0 ? `${formatBRL(k.netCut)} abatidos` : 'soma dos holerites'} />
            <Kpi icon={Banknote} label="Por fora" value={k.off} sub="metas, comissões…" />
            <Kpi icon={Plus} label="Extras" value={k.extras} sub="antes dos descontos" />
            <Kpi icon={Receipt} label="Encargos" value={k.employer} sub={meta.settings.costs.provisions ? 'FGTS, 13º e férias' : 'FGTS e outros custos'} />
            <Kpi icon={Wallet} label="Custo da empresa" value={k.cost} sub={period.billsEnabled ? `${k.paid}/${k.bills} pagos` : 'histórico'} />
          </div>
          {!period.billsEnabled && (
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-surface-2/40 px-4 py-2.5 text-xs text-muted md:px-5">
              <FileSpreadsheet className="size-3.5 text-accent" /> Mês importado da planilha: fica só como histórico e não aparece em Contas a pagar.
              {canEdit && <button className="font-medium text-accent hover:underline" onClick={enableBills}>Gerar contas a pagar deste mês</button>}
            </p>
          )}
          {commImport && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line bg-accent-soft/30 px-4 py-2.5 text-sm md:px-5">
              <BadgePercent className="size-4 shrink-0 text-accent" />
              <span className="min-w-0 flex-1">
                Comissões{commImport.from && commImport.to ? <> das vendas de <b className="tnum">{formatDateBR(commImport.from).slice(0, 5)} a {formatDateBR(commImport.to)}</b></> : null}: <b className="tnum">{formatBRL(commTotal)}</b>
                <span className="block truncate text-xs text-faint">“{commImport.fileName}” · importado em {formatDateBR(commImport.createdAt.slice(0, 10))}{commImport.createdByName ? ` por ${commImport.createdByName}` : ''}</span>
              </span>
              <Button size="sm" variant="secondary" onClick={() => setCommOpen(true)}>Ver comissões</Button>
            </div>
          )}
          {!rows.length ? <p className="px-5 py-14 text-center text-sm text-muted">Ninguém lançado neste mês.</p> : (
            <>
              {/* desktop: tabela */}
              <table className="hidden w-full text-sm lg:table">
                <thead className="text-xs text-muted">
                  <tr className="border-b border-line">
                    <th className="px-5 py-2.5 text-left font-medium">Funcionário</th>
                    <th className="px-3 py-2.5 text-right font-medium">Holerite</th>
                    <th className="px-3 py-2.5 text-right font-medium">Extras</th>
                    <th className="px-3 py-2.5 text-right font-medium">Descontos</th>
                    <th className="px-3 py-2.5 text-right font-medium">A pagar</th>
                    <th className="px-3 py-2.5 text-right font-medium">Por fora</th>
                    <th className="px-3 py-2.5 text-left font-medium">Situação</th>
                    <th className="w-[130px] px-5 py-2.5" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map(({ e, emp, t }) => (
                    <tr key={e.id} className="cursor-pointer hover:bg-surface-2/50" onClick={() => setEntryDlg({ open: true, entry: e })}>
                      <td className="px-5 py-3">
                        <p className="font-medium">{emp?.name ?? '—'}</p>
                        <p className="text-xs text-faint">{emp?.role ?? (t.detailed ? 'holerite detalhado' : '')}{e.notes ? `${emp?.role ? ' · ' : ''}${e.notes.split('\n')[0]}` : ''}</p>
                        {cutNote(t)}
                        {unchecked(e, t) && <p className="flex items-center gap-1 text-xs text-warn"><AlertTriangle className="size-3" /> holerite não conferido</p>}
                      </td>
                      <td className="px-3 py-3 text-right tnum">{formatBRL(t.payslipNet)}</td>
                      <td className="px-3 py-3 text-right tnum text-ok">{toCents(t.extraEarnings) ? `+ ${formatBRL(t.extraEarnings)}` : '—'}</td>
                      <td className="px-3 py-3 text-right tnum text-danger">{toCents(t.extraDeductions) ? `− ${formatBRL(t.extraDeductions)}` : '—'}</td>
                      <td className="px-3 py-3 text-right font-semibold tnum">{formatBRL(t.total)}</td>
                      <td className="px-3 py-3 text-right tnum text-accent">{toCents(t.offPayroll) ? formatBRL(t.offPayroll) : '—'}</td>
                      <td className="px-3 py-3">{status(e)}</td>
                      <td className="px-5 py-3"><div className="flex items-center justify-end gap-1">{payBtn(e)}{rowMenu(e)}</div></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="border-t border-line-strong text-sm font-semibold">
                  <tr>
                    <td className="px-5 py-3">Total</td>
                    <td className="px-3 py-3 text-right tnum">{formatBRL(sumMoney(rows.map((r) => r.t.payslipNet)))}</td>
                    <td className="px-3 py-3 text-right tnum text-ok">{formatBRL(k.extras)}</td>
                    <td className="px-3 py-3 text-right tnum text-danger">{formatBRL(sumMoney(rows.map((r) => r.t.extraDeductions)))}</td>
                    <td className="px-3 py-3 text-right tnum">{formatBRL(k.total)}</td>
                    <td className="px-3 py-3 text-right tnum text-accent">{formatBRL(k.off)}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
              {/* celular/tablet: cartões */}
              <ul className="grid gap-3 p-3 sm:grid-cols-2 sm:p-4 lg:hidden">
                {rows.map(({ e, emp, t }) => (
                  <li key={e.id}>
                    <button type="button" onClick={() => setEntryDlg({ open: true, entry: e })} className="flex w-full min-w-0 flex-col gap-2 rounded-xl border border-line bg-surface-2/40 p-3.5 text-left">
                      <span className="flex items-start justify-between gap-2">
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{emp?.name ?? '—'}</span>
                          <span className="block truncate text-xs text-faint">{emp?.role ?? ''}</span>
                          {cutNote(t)}
                          {unchecked(e, t) && <span className="flex items-center gap-1 text-xs text-warn"><AlertTriangle className="size-3" /> holerite não conferido</span>}
                        </span>
                        <span className="shrink-0">{status(e)}</span>
                      </span>
                      <span className="flex items-end justify-between gap-2">
                        <span className="text-xs text-muted tnum">
                          Holerite {formatBRL(t.payslipNet)}
                          {toCents(t.extraEarnings) > 0 && <span className="block text-ok">+ {formatBRL(t.extraEarnings)}</span>}
                          {toCents(t.extraDeductions) > 0 && <span className="block text-danger">− {formatBRL(t.extraDeductions)}</span>}
                        </span>
                        <span className="text-right">
                          <span className="block font-display text-lg font-semibold tnum">{formatBRL(t.total)}</span>
                          {toCents(t.offPayroll) > 0 && <span className="block text-xs text-accent tnum">por fora {formatBRL(t.offPayroll)}</span>}
                        </span>
                      </span>
                    </button>
                    {(payBtn(e) || rowMenu(e)) && <div className="mt-1.5 flex items-center justify-end gap-1">{payBtn(e)}{rowMenu(e)}</div>}
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}

      {period && <EntryDialog open={entryDlg.open} entry={entryDlg.entry} period={period} employees={meta.employees} rubrics={meta.rubrics}
        costs={meta.settings.costs} takenEmployeeIds={entries.map((e) => e.employeeId)} canEdit={canEdit} canManage={can('payroll.manage')} onClose={() => setEntryDlg({ open: false, entry: null })}
        onCreated={setCreatedId} />}
      <OpenMonthDialog open={openDlg} refStr={ref} suggested={m?.suggestedPayDate ?? null} onClose={() => setOpenDlg(false)} />
      {period && rows.length > 0 && <PayrollPrint period={period} rows={rows} rubrics={meta.rubrics} print={printCfg} />}
      {period && rows.length > 0 && <PrintDialog open={printOpen} refStr={ref} rows={rows} rubrics={meta.rubrics} print={printCfg} onClose={() => setPrintOpen(false)} onPrint={doPrint} />}
      {period && commImport && <CommissionsDialog open={commOpen} onClose={() => setCommOpen(false)} periods={periodsList} currentRef={ref} employees={meta.employees} rubrics={meta.rubrics}
        commissions={meta.settings.commissions} canManage={can('payroll.manage')} canEdit={canEdit} initial={{ ...commImport, ref }}
        onConfigure={onConfigure} onDone={() => undefined} />}
      {period && <EditPeriodDialog open={editPeriod} period={period} onClose={() => setEditPeriod(false)} />}
      {pay && <PayDialog bill={pay.bill} proofOnly={pay.proofOnly} onClose={() => setPay(null)} onView={view} />}
      <FileViewer target={viewer} onClose={() => setViewer(null)} />
    </Card>
  );
}

function Kpi({ icon: Icon, label, value, sub, tone, first }: { icon: typeof Wallet; label: string; value: string; sub: string; tone?: 'accent'; first?: boolean }) {
  return (
    <div className={cn('p-3.5 sm:p-4 md:p-5 border-line max-sm:w-[44%] max-sm:min-w-[150px] max-sm:shrink-0 max-sm:snap-start', !first && 'border-l', 'sm:max-xl:[&:nth-child(3n+1)]:border-l-0 sm:max-xl:[&:nth-child(n+4)]:border-t')}>
      <span className="flex items-center gap-2 text-[13px] text-muted"><Icon className={cn('size-4', tone === 'accent' ? 'text-accent' : 'text-faint')} />{label}</span>
      <CountUp value={value} className="mt-2 block font-display text-[19px] sm:text-[22px] font-semibold leading-none whitespace-nowrap" />
      <span className="mt-1.5 block truncate text-xs text-faint">{sub}</span>
    </div>
  );
}

/** Escolha e ordem das colunas da impressão: fixas + cada extra com valor no mês. Fica salva no espaço. */
function PrintDialog({ open, refStr, rows, rubrics, print, onClose, onPrint }: {
  open: boolean; refStr: string; rows: PrintRow[]; rubrics: Rubric[]; print: PayrollPrintSettings;
  onClose: () => void; onPrint: (hidden: string[], order: string[]) => void;
}) {
  const extras = useMemo(() => extraColumnsOf(rows, rubrics), [rows, rubrics]);
  const [sel, setSel] = useState<string[]>(print.hidden);
  const [order, setOrder] = useState<string[]>(() => printColumnsOf(extras, print.order));
  useEffect(() => { if (open) { setSel(print.hidden); setOrder(printColumnsOf(extras, print.order)); } }, [open, print, extras]);
  const toggle = (k: string, on: boolean) => setSel((p) => (on ? p.filter((x) => x !== k) : [...p, k]));
  const move = (i: number, d: -1 | 1) => setOrder((p) => { const n = [...p]; [n[i], n[i + d]] = [n[i + d]!, n[i]!]; return n; });
  const hiddenExtras = extras.filter((r) => sel.includes(r.id));
  const labelOf = (k: string) => PAYROLL_PRINT_FIXED.find((f) => f.key === k)?.label ?? extras.find((r) => r.id === k)?.name ?? k;
  const subOf = (k: string) => (extras.some((r) => r.id === k) ? formatBRL(sumMoney(rows.map(({ e }) => amountOf(e, k)))) : null);
  return (
    <Dialog open={open} onClose={onClose} size="sm" title={`Imprimir folha de ${refLabelPT(refStr)}`} description="Marque as colunas que vão para o papel (A4 deitado) e use as setas para mudar a ordem. A escolha fica salva para os próximos meses."
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" icon={<Printer className="size-4" />} onClick={() => onPrint(sel, order)}>Imprimir</Button></>}>
      <ul className="divide-y divide-line/60">
        <li className="flex items-center justify-between gap-3 py-2"><Checkbox checked disabled onChange={() => {}} label="Funcionário" /><span className="text-xs text-faint">sempre a 1ª</span></li>
        {order.map((k, i) => {
          const sub = subOf(k);
          return (
            <li key={k} className="flex items-center gap-2 py-1.5">
              <div className="min-w-0 flex-1"><Checkbox checked={!sel.includes(k)} onChange={(v) => toggle(k, v)} label={labelOf(k)} /></div>
              {sub && <span className="shrink-0 text-xs text-faint tnum">{sub}</span>}
              <div className="flex shrink-0">
                <IconButton label="Subir" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="size-4" /></IconButton>
                <IconButton label="Descer" disabled={i === order.length - 1} onClick={() => move(i, 1)}><ArrowDown className="size-4" /></IconButton>
              </div>
            </li>
          );
        })}
      </ul>
      {hiddenExtras.length > 0 && (
        <p className="mt-3 rounded-lg bg-surface-2/60 px-3 py-2 text-xs text-muted">
          {hiddenExtras.map((r) => r.name).join(', ')} {hiddenExtras.length > 1 ? 'entram' : 'entra'} na coluna <b className="text-ink">Outros extras</b>, para o total do salário continuar fechando no papel.
        </p>
      )}
      <p className="mt-3 text-xs text-faint">Extras sem valor neste mês não aparecem na lista nem no papel (a posição deles fica guardada).</p>
    </Dialog>
  );
}

function OpenMonthDialog({ open, refStr: ref, suggested, onClose }: { open: boolean; refStr: string; suggested: string | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [payDate, setPayDate] = useState('');
  const [copy, setCopy] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) { setPayDate(suggested ?? ''); setCopy(true); } }, [open, suggested]);
  const go = async () => {
    setBusy(true);
    try {
      const r = await post<{ created: number }>('/api/payroll/periods', { ref, payDate, copyPrevious: copy });
      qc.invalidateQueries({ queryKey: ['bills'] });
      toast.success(`Folha de ${refLabelPT(ref)} aberta${r.created ? ` com ${plural(r.created, 'funcionário', 'funcionários')}` : ''}`);
      onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} size="sm" title={`Abrir folha de ${refLabelPT(ref)}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={!payDate} onClick={go}>Abrir</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Data do pagamento" hint="Vencimento das contas de salário deste mês."><DatePicker value={payDate} onChange={setPayDate} /></Field>
        <Switch checked={copy} onChange={setCopy} label="Trazer os funcionários ativos" hint="Com o líquido do holerite e as rubricas fixas do último mês de cada um." />
      </div>
    </Dialog>
  );
}

function EditPeriodDialog({ open, period, onClose }: { open: boolean; period: Period; onClose: () => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [f, setF, form] = useFormState({ payDate: period.payDate, notes: period.notes ?? '' });
  const { payDate, notes } = f;
  const [busy, setBusy] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (open) form.load({ payDate: period.payDate, notes: period.notes ?? '' }); }, [open, period.payDate, period.notes]);
  const save = async () => {
    setBusy(true);
    try { await put(`/api/payroll/periods/${period.id}`, f); form.markSaved(f); qc.invalidateQueries({ queryKey: ['bills'] }); toast.success('Mês salvo'); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    const ok = await confirm({ title: `Apagar a folha de ${refLabelPT(period.ref)}?`, tone: 'danger', confirmLabel: 'Apagar mês',
      body: 'Apaga todos os lançamentos do mês e as contas a pagar pendentes deles. Se algum salário já foi pago, reverta antes.' });
    if (!ok) return;
    try { await api('DELETE', `/api/payroll/periods/${period.id}`); qc.invalidateQueries({ queryKey: ['bills'] }); toast.success('Mês apagado'); onClose(); } catch (e) { toast.error(errMsg(e)); }
  };
  return (
    <Dialog open={open} onClose={onClose} dirty={form.dirty} size="sm" title={`Folha de ${refLabelPT(period.ref)}`}
      footer={<SaveFooter dirty={form.dirty} saving={busy} canSave={!!payDate} onSave={save} onClose={onClose}
        left={<Button variant="ghost" className="mr-auto text-danger hover:text-danger" icon={<Trash2 className="size-4" />} onClick={remove}>Apagar mês</Button>} />}>
      <div className="flex flex-col gap-4">
        <Field label="Data do pagamento" hint={period.billsEnabled ? 'Muda o vencimento das contas de salário ainda pendentes.' : undefined}><DatePicker value={payDate} onChange={(payDate) => setF((p) => ({ ...p, payDate }))} /></Field>
        <Field label="Observações"><Textarea maxLength={1000} value={notes} onChange={(e) => setF((p) => ({ ...p, notes: e.target.value }))} /></Field>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ histórico
function HistoryView({ periods, loading, onOpen }: { periods: PeriodSummary[]; loading: boolean; onOpen: (ref: string) => void }) {
  const years = useMemo(() => {
    const m = new Map<string, PeriodSummary[]>();
    for (const p of periods) m.set(p.ref.slice(0, 4), [...(m.get(p.ref.slice(0, 4)) ?? []), p]);
    return [...m.entries()];
  }, [periods]);
  const max = Math.max(1, ...periods.map((p) => toCents(p.total)));
  if (loading) return <div className="grid place-items-center py-20"><Spinner /></div>;
  if (!periods.length) return <Card><Empty icon={<CalendarDays className="size-5" />} title="Nenhum mês na folha">Abra o mês atual na aba Mês ou importe a planilha com os meses anteriores.</Empty></Card>;
  return (
    <div className="flex flex-col gap-4">
      {years.map(([year, ps]) => (
        <Card key={year} className="overflow-hidden">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3 md:px-5">
            <h3 className="font-display text-lg font-semibold">{year}</h3>
            <p className="text-sm text-muted">Pago <b className="font-semibold text-ink tnum">{formatBRL(sumMoney(ps.map((p) => p.total)))}</b> · por fora <span className="tnum text-accent">{formatBRL(sumMoney(ps.map((p) => p.offPayroll)))}</span></p>
          </div>
          <ul className="divide-y divide-line">
            {ps.map((p) => {
              const on = toCents(p.total) - toCents(p.offPayroll);
              return (
                <li key={p.id}>
                  <button type="button" onClick={() => onOpen(p.ref)} className="grid w-full grid-cols-[64px_1fr_auto] items-center gap-3 px-4 py-2.5 text-left hover:bg-surface-2/50 md:grid-cols-[90px_1fr_170px_auto] md:px-5">
                    <span className="text-sm font-medium tnum">{refLabelPT(p.ref).slice(0, 3)}</span>
                    <span className="flex h-2 overflow-hidden rounded-full bg-surface-2" title={`Holerite ${formatBRL(on / 100)} · por fora ${formatBRL(p.offPayroll)}`}>
                      <span className="h-full bg-accent/45" style={{ width: `${(on / max) * 100}%` }} />
                      <span className="h-full bg-accent" style={{ width: `${(toCents(p.offPayroll) / max) * 100}%` }} />
                    </span>
                    <span className="hidden text-xs text-faint md:block">{plural(p.employees, 'funcionário', 'funcionários')}{p.imported ? ' · importado' : p.bills ? ` · ${p.paid}/${p.bills} pagos` : ''}</span>
                    <span className="text-right text-sm font-semibold tnum">{formatBRL(p.total)}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </Card>
      ))}
      <p className="flex items-center gap-3 text-xs text-faint"><span className="inline-block h-2 w-5 rounded-full bg-accent/45" /> pelo holerite <span className="inline-block h-2 w-5 rounded-full bg-accent" /> por fora</p>
    </div>
  );
}
