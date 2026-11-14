import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  ArrowDownLeft, ArrowUpRight, Check, CheckCheck, ChevronLeft, ChevronRight, CircleDashed, EyeOff, FileClock, Landmark, Link2, Pencil, Plus, RotateCcw, Sparkles, Upload,
} from 'lucide-react';
import {
  MONTHS_PT, accountLabel, addMonthsRef, billsByAmount, candidatesFor, sameAmountBills, daysInMonth, formatBRL, formatDateBR, suggestMatches, sumMoney, todayISO, txDescription,
  type MatchBill, type ReconcileAction,
} from '@nopaper/shared';
import { Button, Card, Empty, PageHeader, Segmented, Select, Input, Spinner } from '@/components/ui/base';
import { useConfirm } from '@/components/ui/dialog';
import { post, errMsg } from '@/lib/api';
import { useCategories } from '@/lib/queries';
import { useCan } from '@/lib/session';
import { cn, plural } from '@/lib/utils';
import type { Bill } from '@/lib/types';
import { useProgressive } from '@/lib/useProgressive';
import { CountUp } from '@/features/bills/KpiRibbon';
import { useBankAccounts, useReconcile, type BankAccount, type BankTx } from './data';
import { AccountDialog, ImportOfxDialog, ImportsDialog } from './BankDialogs';

type Mode = 'check' | 'link' | 'create';
type Decision = { kind: 'none' } | { kind: 'link'; billId: string } | { kind: 'create'; description: string; categoryId: string } | { kind: 'ignore' };
const MODE_KEY = 'np:bank-mode';
const MODES: Array<{ value: Mode; label: string }> = [{ value: 'check', label: 'Só conferir' }, { value: 'link', label: 'Ligar às contas' }, { value: 'create', label: 'Ligar e criar contas' }];
const readMode = (): Mode => { try { const v = localStorage.getItem(MODE_KEY); return v === 'check' || v === 'link' || v === 'create' ? v : 'link'; } catch { return 'link'; } };

const txTitle = (t: Pick<BankTx, 'memo' | 'name'>) => txDescription(t);
const txSub = (t: Pick<BankTx, 'memo' | 'name'>) => { const a = txTitle(t); return [t.memo, t.name].filter((x) => x && x !== a).join(' · '); };
const toMatch = (b: Bill): MatchBill => ({ id: b.id, type: b.type, description: b.description, relatedPerson: b.relatedPerson, amount: b.amount, dueDate: b.dueDate, status: b.status, paidAt: b.paidAt, paidAmount: b.paidAmount });

export function BankPage() {
  const can = useCan();
  const [sp, setSp] = useSearchParams();
  const set = (patch: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) v === null ? n.delete(k) : n.set(k, v); setSp(n, { replace: true }); };
  const accountsQ = useBankAccounts();
  const accounts = accountsQ.data ?? [];
  const [showInactive, setShowInactive] = useState(false);
  const list = accounts.filter((a) => a.active || showInactive || a.id === sp.get('conta'));
  const account = accounts.find((a) => a.id === sp.get('conta')) ?? list[0] ?? null;
  const [accDlg, setAccDlg] = useState<{ open: boolean; account: BankAccount | null }>({ open: false, account: null });
  const [importOpen, setImportOpen] = useState(false);

  if (accountsQ.isLoading) return <div className="grid place-items-center py-24"><Spinner /></div>;
  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <PageHeader title="Contas bancárias"
        description="Importe o extrato do banco (OFX) e confira com as contas a pagar e a receber: o NoPaper sugere os pares e dá baixa na data do banco."
        actions={<>
          {can('bank.import') && <Button variant={accounts.length ? 'secondary' : 'primary'} icon={<Upload className="size-4" />} onClick={() => setImportOpen(true)}>Importar extrato</Button>}
          {can('bank.manage') && <Button variant="ghost" icon={<Plus className="size-4" />} onClick={() => setAccDlg({ open: true, account: null })}>Nova conta</Button>}
        </>} />

      {!accounts.length ? (
        <Card><Empty icon={<Landmark className="size-5" />} title="Nenhuma conta bancária ainda"
          action={can('bank.import') && <Button variant="primary" icon={<Upload className="size-4" />} onClick={() => setImportOpen(true)}>Importar o primeiro extrato</Button>}>
          Importe o extrato em OFX: a conta é cadastrada sozinha com o banco, a agência e o número do arquivo.
        </Empty></Card>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {list.map((a) => (
              <button key={a.id} type="button" onClick={() => set({ conta: a.id })}
                className={cn('group relative flex min-w-0 flex-col gap-2 rounded-xl border bg-surface p-4 text-left shadow-card transition hover:-translate-y-0.5',
                  account?.id === a.id ? 'border-accent ring-2 ring-accent/25' : 'border-line hover:border-line-strong', !a.active && 'opacity-60')}>
                <span className="flex items-center gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent"><Landmark className="size-5" /></span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{a.name}{!a.active && <span className="ml-1.5 text-xs text-faint">(desativada)</span>}</span>
                    <span className="block truncate text-xs text-faint">{accountLabel(a)}</span>
                  </span>
                  {can('bank.manage') && (
                    <span role="button" tabIndex={0} aria-label="Editar conta" onClick={(e) => { e.stopPropagation(); setAccDlg({ open: true, account: a }); }}
                      onKeyDown={(e) => { if (e.key === 'Enter') { e.stopPropagation(); setAccDlg({ open: true, account: a }); } }}
                      className="grid size-8 place-items-center rounded-md text-faint opacity-0 transition hover:bg-surface-2 hover:text-ink group-hover:opacity-100 pointer-coarse:opacity-100"><Pencil className="size-4" /></span>
                  )}
                </span>
                <span className="flex items-end justify-between gap-2">
                  <span>
                    <span className="block text-xs text-faint">{a.balanceDate ? `Saldo em ${formatDateBR(a.balanceDate)}` : 'Saldo'}</span>
                    <span className={cn('font-display text-xl font-semibold tnum', a.balance && a.balance.startsWith('-') && 'text-danger')}>{a.balance ? formatBRL(a.balance) : '—'}</span>
                  </span>
                  {a.pending > 0
                    ? <span className="rounded-full bg-warn/15 px-2 py-0.5 text-xs font-medium text-warn">{plural(a.pending, 'pendente', 'pendentes')}</span>
                    : a.transactions > 0 ? <span className="inline-flex items-center gap-1 rounded-full bg-ok/10 px-2 py-0.5 text-xs font-medium text-ok"><CheckCheck className="size-3.5" />conciliada</span> : null}
                </span>
              </button>
            ))}
          </div>
          {accounts.some((a) => !a.active) && (
            <button className="-mt-2 self-start text-xs font-medium text-accent hover:underline" onClick={() => setShowInactive(!showInactive)}>{showInactive ? 'Esconder desativadas' : 'Mostrar desativadas'}</button>
          )}
          {account && <Reconcile key={account.id} account={account} refStr={sp.get('mes')} onRef={(r) => set({ mes: r })} />}
        </>
      )}

      <AccountDialog open={accDlg.open} account={accDlg.account} onClose={() => setAccDlg({ open: false, account: null })} onSaved={(a) => { setAccDlg({ open: true, account: a }); set({ conta: a.id }); }} />
      <ImportOfxDialog open={importOpen} onClose={() => setImportOpen(false)} accounts={accounts} onDone={(id, ref) => set({ conta: id, mes: ref })} />
    </div>
  );
}

// ------------------------------------------------------------------ conciliação de uma conta num mês
function Reconcile({ account, refStr, onRef }: { account: BankAccount; refStr: string | null; onRef: (r: string) => void }) {
  const can = useCan();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: categories = [] } = useCategories();
  const ref = refStr && /^\d{4}-\d{2}$/.test(refStr) ? refStr : (account.lastDate ?? todayISO()).slice(0, 7);
  const from = `${ref}-01`, to = `${ref}-${String(daysInMonth(+ref.slice(0, 4), +ref.slice(5, 7))).padStart(2, '0')}`;
  const q = useReconcile(account.id, from, to);
  const [mode, setModeState] = useState<Mode>(readMode);
  const setMode = (m: Mode) => { setModeState(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ } };
  const [filter, setFilter] = useState<'pending' | 'linked' | 'ignored' | 'all'>('pending');
  const [over, setOver] = useState<Record<string, Decision>>({});
  const [busy, setBusy] = useState(false);
  const [importsOpen, setImportsOpen] = useState(false);
  useEffect(() => setOver({}), [ref, account.id]);

  const txs = q.data?.transactions ?? [];
  const bills = q.data?.candidates ?? [];
  const billMap = useMemo(() => new Map(bills.map((b) => [b.id, b])), [bills]);
  // tudo memorizado pelos dados: antes `pending` era uma lista nova a cada desenho e as sugestões
  // (cada lançamento × cada conta) eram refeitas a cada clique na tela
  const pending = useMemo(() => txs.filter((t) => t.status === 'pending'), [txs]);
  const matchBills = useMemo(() => bills.map(toMatch), [bills]);
  const byAmount = useMemo(() => billsByAmount(matchBills), [matchBills]);
  const suggestions = useMemo(() => {
    const m = new Map<string, { billId: string; reason: string }>();
    for (const s of suggestMatches(pending.map((t) => ({ id: t.id, date: t.postedAt, amount: t.amount, memo: t.memo, name: t.name })), matchBills)) m.set(s.txId, s);
    return m;
  }, [pending, matchBills]);
  const decisionOf = (t: BankTx): Decision => over[t.id] ?? (suggestions.has(t.id) ? { kind: 'link', billId: suggestions.get(t.id)!.billId } : { kind: 'none' });
  const chosen = new Map<string, string>(); // billId → txId
  for (const t of pending) { const d = decisionOf(t); if (d.kind === 'link') chosen.set(d.billId, t.id); }

  const sum = (f: (t: BankTx) => boolean) => sumMoney(txs.filter(f).map((t) => t.amount));
  const k = { ins: sum((t) => !t.amount.startsWith('-')), outs: sum((t) => t.amount.startsWith('-')).replace('-', ''), linked: txs.filter((t) => t.status === 'linked').length, ignored: txs.filter((t) => t.status === 'ignored').length };
  const planned = mode === 'check' ? [] : pending.map((t) => ({ t, d: decisionOf(t) })).filter((x) => x.d.kind !== 'none' && (x.d.kind !== 'create' || (x.d.categoryId && x.d.description.trim())));
  const counts = {
    pay: planned.filter((x) => x.d.kind === 'link' && billMap.get((x.d as { billId: string }).billId)?.status === 'pending').length,
    match: planned.filter((x) => x.d.kind === 'link' && billMap.get((x.d as { billId: string }).billId)?.status === 'paid').length,
    create: planned.filter((x) => x.d.kind === 'create').length, ignore: planned.filter((x) => x.d.kind === 'ignore').length,
  };
  const catsFor = (amount: string) => categories.filter((c) => c.kind === 'both' || c.kind === (amount.startsWith('-') ? 'payable' : 'receivable'));
  const setD = (t: BankTx, d: Decision) => setOver((p) => ({ ...p, [t.id]: d }));

  const apply = async () => {
    const actions: ReconcileAction[] = planned.map(({ t, d }) => (d.kind === 'link' ? { kind: 'link', txId: t.id, billId: d.billId }
      : d.kind === 'create' ? { kind: 'create', txId: t.id, categoryId: d.categoryId, folderId: null, description: d.description.trim(), relatedPerson: null }
        : { kind: 'ignore', txId: t.id }));
    if (!actions.length) return;
    setBusy(true);
    try {
      const r = await post<{ paid: number; linked: number; created: number; ignored: number }>(`/api/bank/accounts/${account.id}/reconcile`, { actions });
      toast.success(`Conciliado: ${[r.paid && plural(r.paid, 'baixa', 'baixas'), r.linked && plural(r.linked, 'conta já paga ligada', 'contas já pagas ligadas'), r.created && plural(r.created, 'conta criada', 'contas criadas'), r.ignored && plural(r.ignored, 'ignorado', 'ignorados')].filter(Boolean).join(' · ')}`);
      setOver({});
      qc.invalidateQueries({ queryKey: ['bills'] });
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const undo = async (t: BankTx) => {
    const body = t.status === 'ignored' ? 'O lançamento volta para os pendentes.'
      : t.action === 'paid' ? `A conta "${t.bill?.description ?? ''}" volta para pendente (a baixa foi dada pelo extrato).`
        : t.action === 'created' ? `A conta "${t.bill?.description ?? ''}" foi criada pelo extrato e será apagada.`
          : 'O lançamento é desligado da conta (que continua paga).';
    if (!(await confirm({ title: 'Desfazer a conciliação?', body, confirmLabel: 'Desfazer', tone: t.action === 'created' ? 'danger' : 'primary' }))) return;
    try { await post(`/api/bank/transactions/${t.id}/undo`); qc.invalidateQueries({ queryKey: ['bills'] }); toast.success('Conciliação desfeita'); } catch (e) { toast.error(errMsg(e)); }
  };
  /** Modo criar: marca todos os pendentes sem par para virar conta nesta categoria (por tipo). */
  const bulkCreate = (type: 'payable' | 'receivable', categoryId: string) => {
    if (!categoryId) return;
    const next = { ...over };
    for (const t of pending) {
      if ((t.amount.startsWith('-') ? 'payable' : 'receivable') !== type || decisionOf(t).kind !== 'none') continue;
      next[t.id] = { kind: 'create', description: txTitle(t), categoryId };
    }
    setOver(next);
  };

  // pendentes com sugestão primeiro (cada grupo do mais recente para o mais antigo)
  const shown = txs.filter((t) => filter === 'all' || t.status === filter)
    .sort((a, b) => (filter === 'pending' ? Number(suggestions.has(b.id)) - Number(suggestions.has(a.id)) : 0) || b.postedAt.localeCompare(a.postedAt));
  // mês com centenas de lançamentos: desenha os primeiros e completa conforme a pessoa rola
  const list = useProgressive(shown, `${account.id}|${ref}|${filter}|${mode}`);
  const filters: Array<{ value: typeof filter; label: string }> = [
    { value: 'pending', label: `Pendentes (${pending.length})` }, { value: 'linked', label: `Conciliados (${k.linked})` },
    { value: 'ignored', label: `Ignorados (${k.ignored})` }, { value: 'all', label: 'Todos' },
  ];
  const editable = mode !== 'check' && can('bank.import');
  const label = `${MONTHS_PT[+ref.slice(5) - 1]} ${ref.slice(0, 4)}`;

  return (
    <Card className="overflow-visible">
      <div className="flex flex-wrap items-center gap-3 border-b border-line p-3 sm:p-4 md:px-5">
        <div className="flex items-center gap-1 rounded-xl border border-line bg-surface-2/50 p-1">
          <Button size="sm" variant="ghost" aria-label="Mês anterior" onClick={() => onRef(addMonthsRef(ref, -1))}><ChevronLeft className="size-4" /></Button>
          <span className="min-w-28 text-center font-display font-semibold">{label}</span>
          <Button size="sm" variant="ghost" aria-label="Próximo mês" onClick={() => onRef(addMonthsRef(ref, 1))}><ChevronRight className="size-4" /></Button>
        </div>
        {q.isFetching && <Spinner className="size-4" />}
        <Segmented className="max-md:hidden md:ml-auto" value={mode} onChange={setMode} options={MODES} />
        <Select aria-label="Modo" className="order-last w-full md:hidden" value={mode} onChange={(e) => setMode(e.target.value as Mode)}>
          {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
        </Select>
        <Button size="sm" variant="ghost" icon={<FileClock className="size-4" />} onClick={() => setImportsOpen(true)}>Importações</Button>
      </div>

      <div className="grid grid-cols-2 border-b border-line md:grid-cols-4">
        <Kpi icon={ArrowDownLeft} label="Entradas" value={k.ins} sub="no extrato do mês" tone="ok" />
        <Kpi icon={ArrowUpRight} label="Saídas" value={k.outs} sub="no extrato do mês" tone="danger" />
        <Kpi icon={CheckCheck} label="Conciliados" text={`${k.linked} de ${txs.length}`} sub={k.ignored ? `${k.ignored} ignorado(s)` : 'ligados a contas'} />
        <Kpi icon={CircleDashed} label="Pendentes" text={`${pending.length}`} sub={pending.length ? `${suggestions.size} com sugestão` : 'tudo conferido'} />
      </div>

      {q.isLoading ? <div className="grid place-items-center py-16"><Spinner /></div> : !txs.length ? (
        <Empty icon={<FileClock className="size-5" />} title={`Sem lançamentos em ${label}`}>Importe o extrato deste mês ou mude o mês acima.</Empty>
      ) : mode === 'check' ? (
        <CheckView txs={txs} pending={pending} suggestions={suggestions} bills={bills} billMap={billMap} from={from} to={to} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2.5 sm:px-4 md:px-5">
            <Segmented className="max-sm:hidden" value={filter} onChange={setFilter} options={filters} />
            <Select aria-label="Mostrar" className="h-9 sm:hidden" value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
              {filters.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
            </Select>
            {mode === 'create' && filter === 'pending' && editable && <BulkCreate cats={categories} onApply={bulkCreate} />}
          </div>
          {!shown.length ? <p className="px-5 py-12 text-center text-sm text-muted">{filter === 'pending' ? 'Nada pendente neste mês. 🎉' : 'Nada neste filtro.'}</p> : (
            <div className="relative">
            <ul className="divide-y divide-line">
              {list.visible.map((t) => (
                <TxRow key={t.id} t={t} mode={mode} editable={editable} decision={decisionOf(t)} suggestion={suggestions.get(t.id) ?? null}
                  options={t.status === 'pending' ? candidatesFor({ id: t.id, date: t.postedAt, amount: t.amount, memo: t.memo, name: t.name }, sameAmountBills(t, byAmount).filter((b) => (chosen.get(b.id) ?? t.id) === t.id)) : []}
                  billMap={billMap} cats={catsFor(t.amount)} onDecide={(d) => setD(t, d)} onUndo={() => undo(t)} canUndo={can('bank.import')} />
              ))}
            </ul>
            {list.sentinel}
            {list.hidden > 0 && <p className="border-t border-line px-4 py-2 text-center text-xs text-faint" aria-live="polite">Carregando mais {list.hidden.toLocaleString('pt-BR')}…</p>}
            </div>
          )}
          {planned.length > 0 && (
            <div className="sticky bottom-0 z-10 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-b-2xl border-t border-line bg-surface/95 px-4 py-3 backdrop-blur safe-bottom md:px-5">
              <span className="min-w-0 flex-1 text-sm">
                <b>Ao aplicar:</b>{' '}
                {[counts.pay && `${plural(counts.pay, 'baixa', 'baixas')} na data do banco`, counts.match && `${plural(counts.match, 'conta já paga ligada', 'contas já pagas ligadas')}`, counts.create && plural(counts.create, 'conta nova', 'contas novas'), counts.ignore && plural(counts.ignore, 'ignorado', 'ignorados')].filter(Boolean).join(' · ')}
              </span>
              <Button variant="ghost" onClick={() => setOver(Object.fromEntries(pending.map((t) => [t.id, { kind: 'none' } as Decision])))}>Limpar</Button>
              <Button variant="primary" loading={busy} icon={<Check className="size-4" />} onClick={apply}>Aplicar {planned.length}</Button>
            </div>
          )}
        </>
      )}
      <ImportsDialog open={importsOpen} onClose={() => setImportsOpen(false)} account={account} />
    </Card>
  );
}

function Kpi({ icon: Icon, label, value, text, sub, tone }: { icon: typeof Check; label: string; value?: string; text?: string; sub: string; tone?: 'ok' | 'danger' }) {
  return (
    <div className="border-line p-3.5 sm:p-4 md:p-5 [&:nth-child(2n)]:border-l md:[&:nth-child(n+2)]:border-l max-md:[&:nth-child(n+3)]:border-t">
      <span className="flex items-center gap-2 text-[13px] text-muted"><Icon className={cn('size-4', tone === 'ok' ? 'text-ok' : tone === 'danger' ? 'text-danger' : 'text-faint')} />{label}</span>
      {value !== undefined ? <CountUp value={value} className="mt-2 block font-display text-[19px] sm:text-[22px] font-semibold leading-none whitespace-nowrap" />
        : <span className="mt-2 block font-display text-[19px] sm:text-[22px] font-semibold leading-none tnum">{text}</span>}
      <span className="mt-1.5 block truncate text-xs text-faint">{sub}</span>
    </div>
  );
}

function Amount({ v, className }: { v: string; className?: string }) {
  const neg = v.startsWith('-');
  return <span className={cn('font-medium tnum whitespace-nowrap', neg ? 'text-danger' : 'text-ok', className)}>{neg ? '−' : '+'}{formatBRL(v.replace('-', ''))}</span>;
}

const billLine = (b: Pick<Bill, 'description' | 'dueDate' | 'status' | 'paidAt'>) => `${b.description} · ${b.status === 'paid' ? `paga em ${formatDateBR(b.paidAt ?? b.dueDate).slice(0, 5)}` : `vence ${formatDateBR(b.dueDate).slice(0, 5)}`}`;

function TxRow({ t, mode, editable, decision, suggestion, options, billMap, cats, onDecide, onUndo, canUndo }: {
  t: BankTx; mode: Mode; editable: boolean; decision: Decision; suggestion: { billId: string; reason: string } | null;
  options: Array<MatchBill & { score: number; reason: string }>; billMap: Map<string, Bill>; cats: Array<{ id: string; label: string; isRestricted: boolean }>;
  onDecide: (d: Decision) => void; onUndo: () => void; canUndo: boolean;
}) {
  const title = txTitle(t), sub = txSub(t);
  const value = decision.kind === 'link' ? `link:${decision.billId}` : decision.kind;
  const linkedBill = decision.kind === 'link' ? billMap.get(decision.billId) : undefined;
  const onSelect = (v: string) => {
    if (v.startsWith('link:')) onDecide({ kind: 'link', billId: v.slice(5) });
    else if (v === 'create') onDecide({ kind: 'create', description: title, categoryId: '' });
    else onDecide({ kind: v as 'none' | 'ignore' });
  };
  return (
    <li className={cn('flex flex-col gap-2.5 px-4 py-3 md:flex-row md:items-center md:gap-4 md:px-5', t.status === 'ignored' && 'opacity-60')}>
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <span className="w-11 shrink-0 pt-0.5 text-xs font-medium text-muted tnum">{formatDateBR(t.postedAt).slice(0, 5)}</span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{title}</span>
          {sub && <span className="block truncate text-xs text-faint">{sub}</span>}
        </span>
        <Amount v={t.amount} className="text-sm" />
      </div>
      <div className="flex min-w-0 flex-col gap-1.5 md:w-[46%] md:max-w-xl md:shrink-0">
        {t.status === 'linked' ? (
          <div className="flex items-center gap-2">
            <span className="inline-flex min-w-0 flex-1 items-center gap-1.5 rounded-lg bg-ok/10 px-2.5 py-1.5 text-xs text-ok">
              <Link2 className="size-3.5 shrink-0" />
              <span className="truncate">{t.hiddenBill ? 'Ligado a uma conta que você não vê' : t.bill ? <><b className="font-medium">{t.bill.description}</b> · {t.action === 'paid' ? 'baixa pelo extrato' : t.action === 'created' ? 'criada pelo extrato' : 'já estava paga'}</> : 'Conta apagada'}</span>
            </span>
            {canUndo && <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={onUndo}>Desfazer</Button>}
          </div>
        ) : t.status === 'ignored' ? (
          <div className="flex items-center gap-2">
            <span className="inline-flex flex-1 items-center gap-1.5 rounded-lg bg-surface-2 px-2.5 py-1.5 text-xs text-muted"><EyeOff className="size-3.5" />Ignorado (tarifa, transferência entre contas…)</span>
            {canUndo && <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={onUndo}>Desfazer</Button>}
          </div>
        ) : !editable ? (
          suggestion && billMap.get(suggestion.billId) ? <span className="text-xs text-muted">Sugestão: {billLine(billMap.get(suggestion.billId)!)}</span> : <span className="text-xs text-faint">Sem conta parecida</span>
        ) : (
          <>
            <Select aria-label="Conta deste lançamento" className={cn('h-9 text-sm', decision.kind === 'link' && 'border-accent/60', decision.kind === 'create' && 'border-ok/60')} value={value} onChange={(e) => onSelect(e.target.value)}>
              <option value="none">{options.length ? 'Deixar para depois' : 'Sem conta parecida — deixar para depois'}</option>
              {options.length > 0 && <optgroup label={`Contas com o mesmo valor (${options.length})`}>
                {options.map((b) => <option key={b.id} value={`link:${b.id}`}>{billLine(b as unknown as Bill)}</option>)}
              </optgroup>}
              {mode === 'create' && <option value="create">+ Criar conta nova (já paga)</option>}
              <option value="ignore">Ignorar este lançamento</option>
            </Select>
            {decision.kind === 'link' && linkedBill && (
              <p className="text-xs text-muted">
                {suggestion?.billId === decision.billId && <Sparkles className="mr-1 inline size-3 text-accent" />}
                {linkedBill.status === 'paid' ? 'Já está paga: só liga ao extrato.' : `Dá baixa em ${formatDateBR(t.postedAt)}.`}
                {suggestion?.billId === decision.billId && <span className="text-faint"> ({suggestion.reason})</span>}
              </p>
            )}
            {decision.kind === 'create' && (
              <div className="grid gap-1.5 sm:grid-cols-[1fr_180px]">
                <Input aria-label="Descrição da conta nova" className="h-9 text-sm" maxLength={255} value={decision.description} onChange={(e) => onDecide({ ...decision, description: e.target.value })} />
                <Select aria-label="Categoria da conta nova" className={cn('h-9 text-sm', !decision.categoryId && 'border-warn/70')} value={decision.categoryId} onChange={(e) => onDecide({ ...decision, categoryId: e.target.value })}>
                  <option value="">Categoria…</option>
                  {cats.map((c) => <option key={c.id} value={c.id}>{c.label}{c.isRestricted ? ' 🔒' : ''}</option>)}
                </Select>
              </div>
            )}
          </>
        )}
      </div>
    </li>
  );
}

function BulkCreate({ cats, onApply }: { cats: Array<{ id: string; label: string; kind: string }>; onApply: (type: 'payable' | 'receivable', categoryId: string) => void }) {
  const [type, setType] = useState<'payable' | 'receivable'>('payable');
  const [cat, setCat] = useState('');
  const list = cats.filter((c) => c.kind === 'both' || c.kind === type);
  return (
    <div className="flex flex-wrap items-center gap-2 md:ml-auto">
      <span className="text-xs text-muted">Sem par →</span>
      <Select aria-label="Tipo" className="h-9 w-auto text-sm" value={type} onChange={(e) => { setType(e.target.value as 'payable' | 'receivable'); setCat(''); }}>
        <option value="payable">saídas</option><option value="receivable">entradas</option>
      </Select>
      <Select aria-label="Categoria" className="h-9 w-auto min-w-36 text-sm" value={cat} onChange={(e) => setCat(e.target.value)}>
        <option value="">criar em…</option>
        {list.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
      </Select>
      <Button size="sm" variant="secondary" disabled={!cat} onClick={() => onApply(type, cat)}>Marcar todos</Button>
    </div>
  );
}

/** Só conferir: o que bate, o que está só no extrato e o que está só no NoPaper. Não altera nada. */
function CheckView({ txs, pending, suggestions, bills, billMap, from, to }: {
  txs: BankTx[]; pending: BankTx[]; suggestions: Map<string, { billId: string; reason: string }>; bills: Bill[]; billMap: Map<string, Bill>; from: string; to: string;
}) {
  const both = [...txs.filter((t) => t.status === 'linked'), ...pending.filter((t) => suggestions.has(t.id))].sort((a, b) => b.postedAt.localeCompare(a.postedAt));
  const onlyBank = pending.filter((t) => !suggestions.has(t.id));
  const used = new Set([...suggestions.values()].map((s) => s.billId));
  const inMonth = (d: string | null) => !!d && d >= from && d <= to;
  const paidOutside = bills.filter((b) => b.status === 'paid' && inMonth(b.paidAt) && !used.has(b.id));
  const pendingDue = bills.filter((b) => b.status === 'pending' && inMonth(b.dueDate) && !used.has(b.id));
  const Section = ({ icon: Icon, title, hint, n, children, tone }: { icon: typeof Check; title: string; hint: string; n: number; children: React.ReactNode; tone: string }) => (
    <section className="border-b border-line last:border-b-0">
      <div className="flex items-start gap-3 px-4 pt-4 md:px-5">
        <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg', tone)}><Icon className="size-4" /></span>
        <div className="min-w-0"><h3 className="font-display font-semibold">{title} <span className="text-faint tnum">({n})</span></h3><p className="text-xs text-faint">{hint}</p></div>
      </div>
      {n ? <ul className="mt-2 divide-y divide-line/60 pb-2">{children}</ul> : <p className="px-5 pb-4 pt-2 text-sm text-muted">Nada aqui.</p>}
    </section>
  );
  const row = (key: string, date: string, title: string, right: React.ReactNode, sub?: React.ReactNode) => (
    <li key={key} className="flex items-start gap-3 px-4 py-2 md:px-5">
      <span className="w-11 shrink-0 pt-0.5 text-xs font-medium text-muted tnum">{formatDateBR(date).slice(0, 5)}</span>
      <span className="min-w-0 flex-1"><span className="block truncate text-sm">{title}</span>{sub && <span className="block truncate text-xs text-faint">{sub}</span>}</span>
      {right}
    </li>
  );
  return (
    <div>
      <p className="border-b border-line bg-surface-2/40 px-4 py-2.5 text-xs text-muted md:px-5">Modo só conferir: nada é alterado. Para dar baixa ou criar contas, mude para “Ligar às contas”.</p>
      <Section icon={CheckCheck} tone="bg-ok/10 text-ok" title="No extrato e no NoPaper" hint="Lançamentos já ligados a uma conta ou com uma conta de mesmo valor e data próxima." n={both.length}>
        {both.map((t) => {
          const b = t.bill ?? billMap.get(suggestions.get(t.id)?.billId ?? '');
          return row(t.id, t.postedAt, txTitle(t), <Amount v={t.amount} className="text-sm" />, b ? <>{t.status === 'linked' ? '✓ ' : 'sugestão: '}{billLine(b)}</> : t.hiddenBill ? 'ligado a uma conta restrita' : null);
        })}
      </Section>
      <Section icon={Landmark} tone="bg-warn/10 text-warn" title="Só no extrato" hint="Saíram ou entraram no banco, mas não há conta no NoPaper com o mesmo valor perto da data." n={onlyBank.length}>
        {onlyBank.map((t) => row(t.id, t.postedAt, txTitle(t), <Amount v={t.amount} className="text-sm" />, txSub(t)))}
      </Section>
      <Section icon={CircleDashed} tone="bg-accent-soft text-accent" title="Só no NoPaper" hint="Contas do mês sem lançamento neste extrato: pagas por outra conta ou em dinheiro, ou ainda pendentes." n={paidOutside.length + pendingDue.length}>
        {[...paidOutside, ...pendingDue].sort((a, b) => (a.paidAt ?? a.dueDate).localeCompare(b.paidAt ?? b.dueDate)).map((b) =>
          row(b.id, b.paidAt ?? b.dueDate, b.description, <Amount v={(b.type === 'payable' ? '-' : '') + (b.paidAmount ?? b.amount)} className="text-sm" />, b.status === 'paid' ? `paga em ${formatDateBR(b.paidAt!)}` : `pendente · vence ${formatDateBR(b.dueDate)}`))}
      </Section>
    </div>
  );
}
