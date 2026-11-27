import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Banknote, Link2, Unlink, CalendarDays, Check, FileText, Ghost, Gift, HandCoins, Landmark, Lock, MoreHorizontal, Plus, Receipt, RotateCcw, Trash2, Upload, UserRound, Wallet } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import {
  THIRTEENTH_INSTALLMENTS, THIRTEENTH_LABEL, formatBRL, fromCents, formatDateBR, payslipEmployeeFor, refLabelPT, sumMoney, thirteenthClash, thirteenthDefaultPayDate,
  thirteenthInstallmentOf, thirteenthYearFor, titleCaseName, toCents, todayISO,
  type Payslip, type PayslipReport, type SpaceCheck, type ThirteenthInstallment,
} from '@nopaper/shared';
import { Button, Checkbox, Empty, Field, Select, Spinner, Textarea } from '@/components/ui/base';
import { KPI_STRIP, Kpi } from './Kpi';
import { StatusChip } from '@/components/ui/chips';
import { Dialog, SaveFooter, useConfirm, useFormState } from '@/components/ui/dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { MoneyInput } from '@/features/bills/MoneyInput';
import { api, errMsg, post, put } from '@/lib/api';
import { useCan } from '@/lib/session';
import { cn, plural } from '@/lib/utils';
import type { Bill } from '@/lib/types';
import { WrongSpaceAlert, WrongSpaceNote, useSpaceGuard } from '@/components/WrongSpace';
import { AccountantPayslipDocs } from './AccountantDocs';
import type { Employee, Period, Thirteenth } from './data';

const label = (i: string) => THIRTEENTH_LABEL[i as ThirteenthInstallment] ?? i;

export type ThirteenthEdit = { open: boolean; item: Thirteenth | null };

/** Linha da tela: um pagamento, ou a 1ª + 2ª parcela juntas (com a soma; `pair` = a 2ª). */
type Row = Thirteenth & { pair?: Thirteenth };
const instLabel = (t: Row) => (t.pair ? '1ª + 2ª parcela' : label(t.installment));
function mergeJoined(items: Thirteenth[]): Row[] {
  const out: Row[] = [];
  for (const t of items) {
    if (t.joined && t.installment === 'second' && items.some((x) => x.joined && x.installment === 'first' && x.employeeId === t.employeeId && x.year === t.year)) continue;
    const pair = t.joined && t.installment === 'first' ? items.find((x) => x.joined && x.installment === 'second' && x.employeeId === t.employeeId && x.year === t.year) : undefined;
    out.push(pair ? {
      ...t, pair, net: sumMoney([t.net, pair.net]), amount: sumMoney([t.amount, pair.amount]),
      fgts: t.fgts || pair.fgts ? sumMoney([t.fgts ?? '0', pair.fgts ?? '0']) : null,
    } : t);
  }
  return out;
}

/** Linhas da tela (parcelas juntas contam uma). */
export const thirteenthLines = (items: Thirteenth[]) => mergeJoined(items).length;

/** Funcionários com a 1ª e a 2ª parcela neste mês, separadas e sem pagamento: dá para juntar. */
export function joinableThirteenth(items: Thirteenth[]) {
  return items.filter((f) => f.installment === 'first' && !f.joined && f.bill?.status !== 'paid')
    .map((f) => ({ first: f, second: items.find((x) => x.installment === 'second' && !x.joined && x.employeeId === f.employeeId && x.year === f.year && x.bill?.status !== 'paid') }))
    .filter((x): x is { first: Thirteenth; second: Thirteenth } => !!x.second);
}

/** Junta a 1ª e a 2ª parcela de cada funcionário numa conta a pagar só, com um vencimento. */
export function ThirteenthJoinDialog({ open, period, items, employees, onClose }: {
  open: boolean; period: Period; items: Thirteenth[]; employees: Employee[]; onClose: () => void;
}) {
  const qc = useQueryClient();
  const empMap = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const pairs = useMemo(() => joinableThirteenth(items).sort((a, b) => (empMap.get(a.first.employeeId)?.name ?? '').localeCompare(empMap.get(b.first.employeeId)?.name ?? '', 'pt-BR')), [items, empMap]);
  const [sel, setSel] = useState<string[]>([]);
  const [payDate, setPayDate] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setSel(pairs.map((p) => p.first.employeeId));
    // sugestão: o vencimento da 2ª parcela (o prazo do 13º inteiro)
    const dates = pairs.map((p) => p.second.payDate).sort();
    setPayDate(dates.at(-1) ?? period.payDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const chosen = pairs.filter((p) => sel.includes(p.first.employeeId));
  const total = sumMoney(chosen.flatMap((p) => [p.first.amount, p.second.amount]));
  const save = async () => {
    setBusy(true);
    try {
      await post(`/api/payroll/periods/${period.id}/thirteenth/join`, { employeeIds: chosen.map((p) => p.first.employeeId), payDate });
      qc.invalidateQueries({ queryKey: ['bills'] });
      toast.success(`${plural(chosen.length, 'conta', 'contas')} do 13º com as duas parcelas juntas`);
      onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} size="md" title="Juntar 1ª e 2ª parcela"
      description="Para pagar o 13º de uma vez: cada funcionário fica com uma conta a pagar só, com a soma das duas parcelas. Os recibos continuam separados e dá para separar de novo depois."
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" icon={<Link2 className="size-4" />} loading={busy} disabled={!chosen.length || !payDate} onClick={save}>Juntar {chosen.length ? `(${chosen.length})` : ''}</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Vencimento da conta" hint="Vale para as contas juntadas. Prazo legal do 13º inteiro: até 20/12.">
          <DatePicker value={payDate} onChange={setPayDate} />
        </Field>
        <div className="rounded-xl border border-line">
          <div className="flex items-center gap-3 border-b border-line px-3 py-2 text-[13px] font-medium text-muted">
            <Checkbox checked={chosen.length === pairs.length && pairs.length > 0} onChange={(on) => setSel(on ? pairs.map((p) => p.first.employeeId) : [])} label="Todos" />
            <span className="ml-auto tnum text-ink">{formatBRL(total)}</span>
          </div>
          <ul className="max-h-[45vh] divide-y divide-line overflow-y-auto">
            {pairs.map(({ first, second }) => (
              <li key={first.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <Checkbox checked={sel.includes(first.employeeId)} onChange={(on) => setSel((p) => (on ? [...p, first.employeeId] : p.filter((x) => x !== first.employeeId)))}
                  label={<span className="line-clamp-2 break-words">{empMap.get(first.employeeId)?.name ?? '—'}</span>} />
                <span className="ml-auto shrink-0 text-right text-xs text-muted tnum">
                  {formatBRL(first.amount)} + {formatBRL(second.amount)}
                  <span className="block text-sm font-semibold text-ink">{formatBRL(sumMoney([first.amount, second.amount]))}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </Dialog>
  );
}

/**
 * Aba "13º salário" do mês da folha: números, tabela (computador) ou cartões (celular/tablet), no
 * mesmo padrão dos salários. Cada pagamento tem vencimento e conta a pagar próprios.
 */
export function ThirteenthView({ period, items, employees, canEdit, onPay, onUnpay, onImport, onEdit }: {
  period: Period; items: Thirteenth[]; employees: Employee[]; canEdit: boolean;
  onPay: (b: Bill, proofOnly: boolean) => void; onUnpay: (b: Bill) => void;
  /** Abre a importação (com o documento do contador, se vier um). */
  onImport: (docId: string | null) => void; onEdit: (item: Thirteenth | null) => void;
}) {
  const can = useCan();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const canPay = can('payable.pay');
  const today = todayISO();
  const empMap = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);

  // 1ª e 2ª parcela juntas aparecem numa linha só, com a soma (como a conta a pagar)
  const sorted = useMemo(() => mergeJoined(items).sort((a, b) => (empMap.get(a.employeeId)?.name ?? '').localeCompare(empMap.get(b.employeeId)?.name ?? '', 'pt-BR') || a.installment.localeCompare(b.installment)), [items, empMap]);
  const original = (t: Row) => items.find((x) => x.id === t.id) ?? t;
  /** Quem recebe pela empresa (totais) e quem é só holerite (no fim, sem conta). */
  const rows = sorted.filter((t) => !empMap.get(t.employeeId)?.payslipOnly);
  const ghosts = sorted.filter((t) => empMap.get(t.employeeId)?.payslipOnly);
  const off = (t: Row) => fromCents(toCents(t.amount) - toCents(t.net));
  const dates = [...new Set(rows.map((t) => t.payDate))].sort();
  const people = new Set(rows.map((t) => t.employeeId)).size;
  const k = {
    total: sumMoney(rows.map((t) => t.amount)), net: sumMoney(rows.map((t) => t.net)), off: sumMoney(rows.map(off)),
    paid: sumMoney(rows.filter((t) => t.bill?.status === 'paid').map((t) => t.amount)),
    open: sumMoney(rows.filter((t) => t.bill && t.bill.status !== 'paid').map((t) => t.amount)),
    fgts: sumMoney(rows.map((t) => t.fgts ?? '0')),
    paidN: rows.filter((t) => t.bill?.status === 'paid').length, bills: rows.filter((t) => t.bill).length,
  };
  const parts = THIRTEENTH_INSTALLMENTS.filter((i) => items.some((t) => t.installment === i && !empMap.get(t.employeeId)?.payslipOnly)).map(label).join(' e ');

  const status = (t: Thirteenth) => {
    if (!period.billsEnabled) return <StatusChip status="pending" label="Histórico" />;
    if (!t.bill) return <span className="text-xs text-faint">sem conta</span>;
    if (t.bill.status === 'paid') return <StatusChip status="paid" label={`Pago ${formatDateBR(t.bill.paidAt).slice(0, 5)}`} />;
    if (t.bill.dueDate < today) return <StatusChip status="overdue" label="Atrasado" />;
    if (t.bill.dueDate === today) return <StatusChip status="today" label="Vence hoje" />;
    return <StatusChip status="pending" label="Pendente" />;
  };
  const ghostChip = <span className="inline-flex shrink-0 items-center gap-1 rounded-full bg-surface-2 px-2 py-0.5 text-[11px] font-medium text-muted"><Ghost className="size-3" />só holerite</span>;
  const remove = async (t: Row) => {
    const name = empMap.get(t.employeeId)?.name ?? '';
    if (!(await confirm({ title: `Apagar o 13º de ${name}?`, tone: 'danger', confirmLabel: 'Apagar', body: `${instLabel(t)} de ${t.year}. A conta a pagar pendente também é apagada.` }))) return;
    try {
      for (const id of [t.id, ...(t.pair ? [t.pair.id] : [])]) await api('DELETE', `/api/payroll/thirteenth/${id}`);
      toast.success('13º apagado');
    } catch (e) { toast.error(errMsg(e)); } finally { qc.invalidateQueries({ queryKey: ['bills'] }); }
  };
  const split = async (t: Row) => {
    if (!(await confirm({ title: 'Separar as parcelas?', confirmLabel: 'Separar', body: `A 1ª e a 2ª parcela de ${empMap.get(t.employeeId)?.name ?? ''} voltam a ter uma conta a pagar cada uma (a 2ª com o vencimento sugerido).` }))) return;
    try { await post(`/api/payroll/thirteenth/${t.id}/split`); qc.invalidateQueries({ queryKey: ['bills'] }); toast.success('Parcelas separadas'); } catch (e) { toast.error(errMsg(e)); }
  };
  const menu = (t: Row) => {
    const b = t.bill;
    const list = [
      t.pair && { label: 'Ver a 1ª parcela', icon: FileText, on: () => onEdit(original(t)) },
      t.pair && { label: 'Ver a 2ª parcela', icon: FileText, on: () => onEdit(t.pair!) },
      t.pair && canEdit && b?.status !== 'paid' && { label: 'Separar as parcelas', icon: Unlink, on: () => split(t) },
      b && b.status === 'paid' && canPay && { label: 'Comprovante', icon: Receipt, on: () => onPay(b, true) },
      b && b.status === 'paid' && canPay && { label: 'Reverter pagamento', icon: RotateCcw, on: () => onUnpay(b) },
      b && { label: 'Ver em Contas a pagar', icon: Wallet, href: `/pagar?ano=${b.dueDate.slice(0, 4)}&mes=${Number(b.dueDate.slice(5, 7))}&situacao=` },
      canEdit && b?.status !== 'paid' && { label: 'Apagar', icon: Trash2, on: () => remove(t), danger: true },
    ].filter(Boolean) as Array<{ label: string; icon: typeof Receipt; on?: () => void; href?: string; danger?: boolean }>;
    if (!list.length) return null;
    return (
      <DropdownMenu.Root>
        <DropdownMenu.Trigger onClick={(ev) => ev.stopPropagation()} className="grid size-8 pointer-coarse:size-10 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink" aria-label="Mais ações"><MoreHorizontal className="size-4" /></DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={4} onClick={(ev) => ev.stopPropagation()} className="z-[6000] w-56 rounded-xl border border-line bg-raised p-1.5 shadow-2xl text-sm">
            {list.map((i) => i.href
              ? <DropdownMenu.Item key={i.label} asChild><Link to={i.href} className="flex items-center gap-2 rounded-lg px-2 py-2 outline-none data-[highlighted]:bg-surface-2 cursor-pointer"><i.icon className="size-4 text-faint" /> {i.label}</Link></DropdownMenu.Item>
              : <DropdownMenu.Item key={i.label} onSelect={i.on} className={cn('flex items-center gap-2 rounded-lg px-2 py-2 outline-none data-[highlighted]:bg-surface-2 cursor-pointer', i.danger && 'text-danger')}><i.icon className={cn('size-4', i.danger ? 'text-danger' : 'text-faint')} /> {i.label}</DropdownMenu.Item>)}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    );
  };
  const payBtn = (t: Row) => t.bill?.status === 'pending' && canPay && (
    <Button size="sm" variant="ok" className="h-7 px-2.5" icon={<Check className="size-3.5" />} onClick={(ev) => { ev.stopPropagation(); onPay(t.bill!, false); }}>Pagar</Button>
  );
  const sub = (t: Row) => `${instLabel(t)} de ${t.year}${t.pair ? ' · uma conta só' : t.source === 'pdf' ? ' · recibo do contador' : ' · lançado à mão'}`;
  const offCell = (t: Row) => { const c = toCents(off(t)); return c ? `${c > 0 ? '' : '− '}${formatBRL(Math.abs(c) / 100)}` : '—'; };

  if (!sorted.length) {
    return (
      <Empty icon={<Gift className="size-5" />} title={`Nenhum 13º lançado em ${refLabelPT(period.ref)}`}
        action={canEdit && (
          <div className="flex w-full max-w-md flex-col items-stretch gap-4">
            <div className="flex flex-wrap justify-center gap-2 max-sm:flex-col">
              <Button variant="primary" icon={<FileText className="size-4" />} onClick={() => onImport(null)}>Importar 13º do contador</Button>
              <Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => onEdit(null)}>Lançar à mão</Button>
            </div>
            <div className="text-left"><AccountantPayslipDocs enabled kinds={['thirteenth']} sameMonth folhaRef={period.ref} action="Usar este" onPick={(d) => onImport(d.id)} /></div>
          </div>
        )}>
        Importe o PDF do 13º que o contador manda ou lance à mão. Cada pagamento vira uma conta a pagar com vencimento próprio, separada do salário.
      </Empty>
    );
  }
  return (
    <>
      <div className={KPI_STRIP}>
        <Kpi icon={HandCoins} label="A pagar" value={k.total} sub={`${plural(people, 'funcionário', 'funcionários')}${parts ? ` · ${parts.toLowerCase()}` : ''}`} tone="accent" first />
        <Kpi icon={Landmark} label="Líquido dos recibos" value={k.net} sub="soma dos recibos" />
        <Kpi icon={Banknote} label="Por fora" value={k.off} sub="combinado além do recibo" />
        <Kpi icon={CalendarDays} label="Falta pagar" value={k.open} sub={dates.length === 1 ? `vence ${formatDateBR(dates[0]!)}` : dates.length ? `de ${formatDateBR(dates[0]!).slice(0, 5)} a ${formatDateBR(dates[dates.length - 1]!).slice(0, 5)}` : '—'} />
        <Kpi icon={Check} label="Pago" value={k.paid} sub={period.billsEnabled ? `${k.paidN}/${k.bills} pagos` : 'histórico'} />
        <Kpi icon={Receipt} label="FGTS do 13º" value={k.fgts} sub="dos recibos · guia à parte" />
      </div>
      {/* computador: tabela */}
      <table className="hidden w-full text-sm lg:table">
        <thead className="text-xs text-muted">
          <tr className="border-b border-line">
            <th className="px-5 py-2.5 text-left font-medium">Funcionário</th>
            <th className="px-3 py-2.5 text-left font-medium">Vencimento</th>
            <th className="px-3 py-2.5 text-right font-medium">Recibo</th>
            <th className="px-3 py-2.5 text-right font-medium">A pagar</th>
            <th className="px-3 py-2.5 text-right font-medium">Por fora</th>
            <th className="px-3 py-2.5 text-left font-medium">Situação</th>
            <th className="w-[130px] px-5 py-2.5" />
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((t) => (
            <tr key={t.id} className="cursor-pointer hover:bg-surface-2/50" onClick={() => onEdit(original(t))}>
              <td className="px-5 py-3">
                <p className="font-medium">{empMap.get(t.employeeId)?.name ?? '—'}</p>
                <p className="text-xs text-faint">{sub(t)}</p>
              </td>
              <td className="px-3 py-3 tnum">{formatDateBR(t.payDate)}</td>
              <td className="px-3 py-3 text-right tnum">{formatBRL(t.net)}</td>
              <td className="px-3 py-3 text-right font-semibold tnum">{formatBRL(t.amount)}</td>
              <td className="px-3 py-3 text-right tnum text-accent">{offCell(t)}</td>
              <td className="px-3 py-3">{status(t)}</td>
              <td className="px-5 py-3"><div className="flex items-center justify-end gap-1">{payBtn(t)}{menu(t)}</div></td>
            </tr>
          ))}
          {ghosts.map((t) => (
            <tr key={t.id} className="cursor-pointer text-muted hover:bg-surface-2/50" onClick={() => onEdit(original(t))}>
              <td className="px-5 py-3">
                <p className="flex items-center gap-2 font-medium">{empMap.get(t.employeeId)?.name ?? '—'}{ghostChip}</p>
                <p className="text-xs text-faint">{sub(t)}</p>
              </td>
              <td className="px-3 py-3 tnum">{formatDateBR(t.payDate)}</td>
              <td className="px-3 py-3 text-right tnum">{formatBRL(t.net)}</td>
              <td className="px-3 py-3 text-right">—</td>
              <td className="px-3 py-3 text-right">—</td>
              <td className="px-3 py-3 text-xs text-faint">não recebe pela empresa</td>
              <td className="px-5 py-3"><div className="flex items-center justify-end gap-1">{menu(t)}</div></td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t border-line-strong text-sm font-semibold">
          <tr>
            <td className="px-5 py-3">Total</td>
            <td />
            <td className="px-3 py-3 text-right tnum">{formatBRL(k.net)}</td>
            <td className="px-3 py-3 text-right tnum">{formatBRL(k.total)}</td>
            <td className="px-3 py-3 text-right tnum text-accent">{formatBRL(k.off)}</td>
            <td colSpan={2} />
          </tr>
        </tfoot>
      </table>
      {/* celular/tablet: cartões */}
      <ul className="grid gap-3 p-3 sm:grid-cols-2 sm:p-4 lg:hidden">
        {[...rows, ...ghosts].map((t) => {
          const ghost = !!empMap.get(t.employeeId)?.payslipOnly;
          return (
            <li key={t.id}>
              <button type="button" onClick={() => onEdit(original(t))} className={cn('flex w-full min-w-0 flex-col gap-2 rounded-xl border p-3.5 text-left', ghost ? 'border-dashed border-line text-muted' : 'border-line bg-surface-2/40')}>
                <span className="flex items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block line-clamp-2 break-words font-medium leading-snug">{empMap.get(t.employeeId)?.name ?? '—'}</span>
                    <span className="block text-xs text-faint">{instLabel(t)} · vence {formatDateBR(t.payDate)}</span>
                  </span>
                  <span className="shrink-0">{ghost ? ghostChip : status(t)}</span>
                </span>
                <span className="flex items-end justify-between gap-2">
                  <span className="text-xs text-muted tnum">Recibo {formatBRL(t.net)}</span>
                  {ghost ? <span className="text-xs text-faint">não recebe pela empresa</span> : (
                    <span className="text-right">
                      <span className="block font-display text-lg font-semibold tnum">{formatBRL(t.amount)}</span>
                      {toCents(off(t)) !== 0 && <span className="block text-xs text-accent tnum">por fora {offCell(t)}</span>}
                    </span>
                  )}
                </span>
              </button>
              {(payBtn(t) || menu(t)) && <div className="mt-1.5 flex items-center justify-end gap-1">{payBtn(t)}{menu(t)}</div>}
            </li>
          );
        })}
      </ul>
    </>
  );
}

// ------------------------------------------------------------------ importar do recibo do contador
interface ReadResult { fileName: string; report: PayslipReport; spaceCheck?: SpaceCheck | null }

/** Lê o PDF do 13º (arquivo ou documento do contador) e lança cada recibo no mês da folha. */
export function ThirteenthImportDialog({ open, docId, period, employees, existing, onClose }: {
  open: boolean; docId: string | null; period: Period; employees: Employee[]; existing: Thirteenth[]; onClose: () => void;
}) {
  const can = useCan();
  const qc = useQueryClient();
  const canManage = can('payroll.manage');
  const fileRef = useRef<HTMLInputElement>(null);
  const [doc, setDoc] = useState<string | null>(null);
  const [file, setFile] = useState<ReadResult | null>(null);
  const guard = useSpaceGuard(file?.spaceCheck);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [inst, setInst] = useState<ThirteenthInstallment>('first');
  const [payDate, setPayDate] = useState('');
  const autoLoaded = useRef<string | null>(null);

  const pick = async (f: File | null, fromDoc: string | null = null) => {
    setReading(true); setDoc(fromDoc);
    try {
      const fd = new FormData(); if (f) fd.append('file', f);
      const r = f ? await api<ReadResult>('POST', '/api/payroll/thirteenth/read', fd) : await post<ReadResult>(`/api/accounting/documents/${fromDoc}/thirteenth`);
      setLinks({}); setAmounts({});
      const i = thirteenthInstallmentOf(r.report.slips[0]?.title) ?? 'single';
      setInst(i);
      setPayDate(thirteenthDefaultPayDate(i, yearOf(r.report.ref), period.ref, period.payDate));
      setFile(r);
    } catch (e) { toast.error(errMsg(e)); } finally { setReading(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  useEffect(() => { if (open) { setFile(null); setDoc(null); setLinks({}); setAmounts({}); } }, [open]);
  useEffect(() => {
    if (!open) { autoLoaded.current = null; return; }
    if (docId && autoLoaded.current !== docId) { autoLoaded.current = docId; void pick(null, docId); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, docId]);

  const yearOf = (ref: string | null) => (ref ? Number(ref.slice(0, 4)) : thirteenthYearFor(period.ref));
  const year = yearOf(file?.report.ref ?? null);
  const slips = file?.report.slips ?? [];
  const suggested = useMemo(() => {
    const m = new Map<string, { id: string; by: 'code' | 'name' }>();
    for (const s of slips) {
      const g = payslipEmployeeFor(s, employees.filter((e) => e.active || e.payslipCode === s.code));
      if (g && (g.by === 'code' || canManage)) m.set(s.code, { id: g.employee.id, by: g.by });
    }
    for (const [code, g] of m) if (g.by === 'name' && [...m].some(([c, o]) => c !== code && o.id === g.id)) m.delete(code);
    return m;
  }, [slips, employees, canManage]);
  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const rows = slips.map((s: Payslip) => {
    const empId = s.code in links ? links[s.code] : suggested.get(s.code)?.id ?? '';
    const emp = empId ? empById.get(empId) ?? null : null;
    const mine = emp ? existing.filter((x) => x.employeeId === emp.id && x.year === year) : [];
    const same = mine.find((x) => x.installment === inst) ?? null;
    const clash = emp ? thirteenthClash(inst, mine.filter((x) => x !== same).map((x) => x.installment)) : null;
    const paid = same?.bill?.status === 'paid';
    const amount = amounts[s.code] ?? (same && toCents(same.net) === toCents(s.net) ? same.amount : s.net);
    const gross = s.totalEarnings;
    return { s, emp, same, clash, paid, amount, gross, by: !(s.code in links) ? suggested.get(s.code)?.by ?? null : null };
  });
  const toApply = rows.filter((r) => r.emp && !r.clash && !r.paid);
  const usedBy = (empId: string, code: string) => rows.some((r) => r.s.code !== code && r.emp?.id === empId);
  const blocked = guard.blocked || !toApply.length || !payDate || rows.some((r) => r.emp && r.clash);

  const run = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const r = await post<{ applied: unknown[]; skipped: Array<{ employee: string; reason: string }>; linked: string[] }>(`/api/payroll/periods/${period.id}/thirteenth`, {
        fileName: file.fileName, docId: doc,
        items: toApply.map((x) => ({
          employeeId: x.emp!.id, code: x.s.code, installment: inst, year, payDate, net: x.s.net, amount: x.amount || '0', gross: x.gross, fgts: x.s.fgts,
          lines: x.s.items.map((i) => ({ name: i.name.slice(0, 80), kind: i.kind, amount: i.amount })),
        })),
      });
      if (doc) await put(`/api/accounting/documents/${doc}`, { status: 'done' }).then(() => qc.invalidateQueries({ queryKey: ['accounting'] })).catch(() => undefined);
      qc.invalidateQueries({ queryKey: ['bills'] });
      toast.success(`13º lançado: ${plural(r.applied.length, 'funcionário', 'funcionários')}`);
      if (r.skipped.length) toast.warning(`Ficaram de fora: ${r.skipped.map((s) => `${s.employee} (${s.reason})`).join(', ')}`);
      onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} size="xl" title={`Importar 13º salário · folha de ${refLabelPT(period.ref)}`}
      description="Use o PDF do 13º que o contador manda. Cada recibo vira um pagamento com o vencimento do 13º e a sua conta a pagar, separada do salário do mês."
      footer={file && !guard.blocked ? <>
        <Button variant="ghost" className="mr-auto" onClick={() => setFile(null)}>Trocar arquivo</Button>
        <Button variant="ghost" onClick={onClose}>Fechar</Button>
        <Button variant="primary" loading={busy} disabled={blocked} onClick={run}>{toApply.length ? `Lançar ${plural(toApply.length, 'pagamento', 'pagamentos')}` : 'Nada para lançar'}</Button>
      </> : <Button variant="ghost" onClick={onClose}>Fechar</Button>}>
      <input ref={fileRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
      {!file ? (
        <div className="flex flex-col gap-4">
          <AccountantPayslipDocs enabled={open && !docId} folhaRef={period.ref} sameMonth kinds={['thirteenth', 'payslip']} busy={reading ? doc ?? 'x' : null} action="Usar este" onPick={(d) => pick(null, d.id)} />
          <button type="button" onClick={() => fileRef.current?.click()} disabled={reading}
            className="flex w-full flex-col items-center gap-3 rounded-xl border-2 border-dashed border-line px-6 py-10 text-center transition hover:border-accent hover:bg-accent-soft/30">
            {reading ? <Spinner className="size-6" /> : <span className="grid size-12 place-items-center rounded-2xl bg-accent-soft text-accent"><Upload className="size-5" /></span>}
            <span className="font-medium">{reading ? 'Lendo os recibos…' : 'Escolher o PDF do 13º no computador'}</span>
            <span className="text-xs text-faint">Um arquivo com os recibos do 13º de todos (1ª parcela, 2ª parcela ou parcela única).</span>
          </button>
        </div>
      ) : guard.blocked ? (
        <WrongSpaceAlert check={guard.check!} subject="Estes recibos" risk="o 13º destes recibos entra na folha deste espaço e vira contas a pagar."
          onOtherFile={() => setFile(null)} onContinue={guard.accept} />
      ) : (
        <div className="flex flex-col gap-4">
          {guard.accepted && <WrongSpaceNote check={guard.check!} />}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-surface-2/60 px-3.5 py-2.5 text-sm">
            <span className="inline-flex min-w-0 items-center gap-1.5"><FileText className="size-4 shrink-0 text-faint" /><span className="truncate">{file.fileName}</span></span>
            {file.report.company && <span className="min-w-0 truncate text-muted">{file.report.company}</span>}
            <span className="text-muted">13º de <b className="text-ink">{year}</b></span>
            <span className="text-muted">{plural(slips.length, 'recibo', 'recibos')}</span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Parcela" hint="Lida do recibo. Troque se o contador usou outro nome.">
              <Select value={inst} onChange={(e) => { const v = e.target.value as ThirteenthInstallment; setInst(v); setPayDate(thirteenthDefaultPayDate(v, year, period.ref, period.payDate)); }}>
                {THIRTEENTH_INSTALLMENTS.map((i) => <option key={i} value={i}>{THIRTEENTH_LABEL[i]}</option>)}
              </Select>
            </Field>
            <Field label="Vencimento" hint={`Prazo legal: ${inst === 'first' ? 'até 30/11' : 'até 20/12'}. Vale para todos os recibos.`}>
              <DatePicker value={payDate} onChange={setPayDate} />
            </Field>
          </div>
          {payDate && payDate.slice(0, 7) !== period.ref && <Warn>O vencimento ({formatDateBR(payDate)}) não é de {refLabelPT(period.ref)}. A folha leva o nome do mês do pagamento: confira se é a folha certa.</Warn>}
          {file.report.warnings.map((w) => <Warn key={w}>{w}</Warn>)}
          <div className="grid gap-3 lg:grid-cols-2">
            {rows.map((r) => (
              <div key={r.s.code} className={cn('flex min-w-0 flex-col gap-2.5 rounded-xl border border-line bg-surface p-3.5 shadow-card', (!r.emp || r.paid || r.clash) && 'bg-surface-2/40')}>
                <div className="flex items-start gap-3">
                  <span className={cn('grid size-9 shrink-0 place-items-center rounded-full', r.emp ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-faint')}><UserRound className="size-4" /></span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium leading-snug sm:truncate">{titleCaseName(r.s.name)}</p>
                    <p className="truncate text-xs text-faint">Matrícula {r.s.code} · {r.s.title}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-display text-lg font-semibold tnum">{formatBRL(r.s.net)}</p>
                    <p className="text-xs text-faint">líquido</p>
                  </div>
                </div>
                <Select aria-label={`Funcionário do recibo de ${r.s.name}`} className="h-9" disabled={!canManage && !!r.emp && r.by === 'code'} value={r.emp?.id ?? ''} onChange={(e) => setLinks({ ...links, [r.s.code]: e.target.value })}>
                  <option value="">Não lançar este recibo</option>
                  {employees.filter((e) => (e.active || e.id === r.emp?.id) && !usedBy(e.id, r.s.code)).map((e) => <option key={e.id} value={e.id}>{e.name}{e.payslipOnly ? ' (só holerite)' : ''}</option>)}
                </Select>
                {r.by === 'name' && <p className="text-xs text-warn">Sugerido pelo nome — confira. A matrícula fica salva no cadastro ao lançar.</p>}
                <ul className="flex flex-col gap-1 border-t border-line/70 pt-2 text-sm">
                  {r.s.items.map((i, n) => (
                    <li key={n} className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate">{i.name}</span>
                      <span className={cn('tnum shrink-0', i.kind === 'deduction' && 'text-danger')}>{i.kind === 'deduction' ? '− ' : ''}{formatBRL(i.amount)}</span>
                    </li>
                  ))}
                </ul>
                {r.s.warnings.map((w) => <p key={w} className="flex items-start gap-1.5 text-xs text-danger"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{w}</p>)}
                {r.emp && (r.paid ? <p className="flex items-center gap-1 text-xs text-warn"><Lock className="size-3.5" />Esta parcela já foi paga: não muda.</p>
                  : r.clash ? <p className="flex items-start gap-1 text-xs text-danger"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{r.emp.name} já tem o 13º de {year} lançado como {label(r.clash).toLowerCase()}. Apague esse lançamento antes (ou troque a parcela acima).</p>
                    : r.emp.payslipOnly ? <p className="text-xs text-muted">Só holerite: fica registrado, sem conta a pagar.</p>
                      : (
                        <div className="grid grid-cols-[1fr_140px] items-center gap-3 rounded-lg bg-surface-2/60 px-3 py-2">
                          <span className="min-w-0 text-sm">
                            <span className="font-medium">A pagar</span>
                            <span className="block text-xs text-faint">{r.same ? `Substitui o lançado (${formatBRL(r.same.amount)}).` : 'Normalmente igual ao líquido do recibo.'}</span>
                          </span>
                          <MoneyInput aria-label={`Valor a pagar a ${r.s.name}`} value={r.amount} onChange={(v) => setAmounts({ ...amounts, [r.s.code]: v })} />
                        </div>
                      ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </Dialog>
  );
}

// ------------------------------------------------------------------ lançar à mão / editar
export function ThirteenthDialog({ open, item, period, employees, existing, canEdit, onClose, onSwitch }: {
  open: boolean; item: Thirteenth | null; period: Period; employees: Employee[]; existing: Thirteenth[]; canEdit: boolean; onClose: () => void;
  /** Abre a outra parcela (quando as duas estão juntas). */
  onSwitch?: (item: Thirteenth) => void;
}) {
  const qc = useQueryClient();
  const empty = () => {
    const year = thirteenthYearFor(period.ref);
    const installment: ThirteenthInstallment = period.ref.endsWith('-11') ? 'first' : period.ref.endsWith('-12') ? 'second' : 'single';
    return { employeeId: '', installment, year: String(year), payDate: thirteenthDefaultPayDate(installment, year, period.ref, period.payDate), net: '', amount: '', notes: '' };
  };
  const [f, setF, form] = useFormState(empty);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    form.load(item ? { employeeId: item.employeeId, installment: item.installment, year: String(item.year), payDate: item.payDate, net: item.net, amount: item.amount, notes: item.notes ?? '' } : empty());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item?.id]);
  const paid = item?.bill?.status === 'paid';
  const readOnly = !canEdit || paid;
  const fromPdf = item?.source === 'pdf';
  const year = Number(f.year) || thirteenthYearFor(period.ref);
  const clash = !item && f.employeeId ? thirteenthClash(f.installment, existing.filter((x) => x.employeeId === f.employeeId && x.year === year).map((x) => x.installment)) : null;
  const emp = employees.find((e) => e.id === (item?.employeeId ?? f.employeeId));
  const canSave = !!f.employeeId && !!f.payDate && toCents(f.net || '0') > 0 && !clash;
  const partner = item?.joined ? existing.find((x) => x.joined && x.id !== item.id && x.employeeId === item.employeeId && x.year === item.year) ?? null : null;

  const save = async () => {
    setBusy(true);
    const amount = f.amount || f.net;
    try {
      if (item) await put(`/api/payroll/thirteenth/${item.id}`, { payDate: f.payDate, net: f.net, amount, notes: f.notes });
      else await post(`/api/payroll/periods/${period.id}/thirteenth`, { items: [{ employeeId: f.employeeId, installment: f.installment, year, payDate: f.payDate, net: f.net, amount, notes: f.notes }] });
      form.markSaved({ ...f, amount });
      qc.invalidateQueries({ queryKey: ['bills'] });
      toast.success('13º salvo');
      if (!item) onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} dirty={form.dirty} size="md" title={item ? `13º de ${emp?.name ?? ''}` : 'Lançar 13º salário'}
      description={item ? `${label(item.installment)} de ${item.year} · folha de ${refLabelPT(period.ref)}` : `Na folha de ${refLabelPT(period.ref)}, com vencimento e conta a pagar próprios.`}
      footer={<SaveFooter dirty={form.dirty} saving={busy} canSave={canSave} onSave={save} onClose={onClose} readOnly={readOnly} isNew={!item} saveLabel={item ? 'Salvar' : 'Lançar'} />}>
      <div className="flex flex-col gap-4">
        {paid && <p className="flex items-center gap-2 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn"><Lock className="size-4 shrink-0" />Já foi pago. Para mudar, reverta o pagamento antes.</p>}
        {partner && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-accent-soft/40 px-3 py-2.5 text-sm">
            <Link2 className="size-4 shrink-0 text-accent" />
            <span className="min-w-0 flex-1">Junto com a {label(partner.installment).toLowerCase()} ({formatBRL(partner.amount)}): a conta a pagar é a soma, <b className="tnum">{formatBRL(sumMoney([toCents(f.amount || '0') ? f.amount : item!.amount, partner.amount]))}</b>, com o vencimento abaixo.</span>
            {onSwitch && <Button size="sm" variant="secondary" disabled={form.dirty} onClick={() => onSwitch(partner)}>Ver a {label(partner.installment).toLowerCase()}</Button>}
          </div>
        )}
        {!item && (
          <Field label="Funcionário">
            <Select value={f.employeeId} onChange={(e) => setF((p) => ({ ...p, employeeId: e.target.value }))}>
              <option value="">Escolha…</option>
              {employees.filter((e) => e.active).map((e) => <option key={e.id} value={e.id}>{e.name}{e.payslipOnly ? ' (só holerite)' : ''}</option>)}
            </Select>
          </Field>
        )}
        <div className="grid gap-3 sm:grid-cols-[1fr_120px]">
          <Field label="Parcela">
            <Select value={f.installment} disabled={!!item} onChange={(e) => { const v = e.target.value as ThirteenthInstallment; setF((p) => ({ ...p, installment: v, payDate: thirteenthDefaultPayDate(v, year, period.ref, period.payDate) })); }}>
              {THIRTEENTH_INSTALLMENTS.map((i) => <option key={i} value={i}>{THIRTEENTH_LABEL[i]}</option>)}
            </Select>
          </Field>
          <Field label="Ano">
            <Select value={f.year} disabled={!!item} onChange={(e) => setF((p) => ({ ...p, year: e.target.value }))}>
              {[year - 1, year, year + 1].map((y) => <option key={y} value={String(y)}>{y}</option>)}
            </Select>
          </Field>
        </div>
        {clash && <Warn>{emp?.name} já tem o 13º de {year} lançado como {label(clash).toLowerCase()}. Parcela única não convive com 1ª/2ª parcela.</Warn>}
        <Field label="Vencimento" hint={partner ? 'Vale para as duas parcelas (uma conta só). Prazo legal do 13º inteiro: até 20/12.' : f.installment === 'first' ? 'Prazo legal: até 30/11.' : 'Prazo legal: até 20/12.'}>
          <DatePicker value={f.payDate} disabled={readOnly} onChange={(payDate) => setF((p) => ({ ...p, payDate }))} />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Líquido do recibo" hint={fromPdf ? 'Vem do recibo do contador.' : undefined}>
            <MoneyInput value={f.net} disabled={readOnly || fromPdf} onChange={(net) => setF((p) => ({ ...p, net, amount: !p.amount || p.amount === p.net ? net : p.amount }))} />
          </Field>
          <Field label="A pagar" hint="Diferente do líquido = combinado; a diferença fica por fora.">
            <MoneyInput value={f.amount} disabled={readOnly} onChange={(amount) => setF((p) => ({ ...p, amount }))} />
          </Field>
        </div>
        {emp?.payslipOnly && <p className="text-xs text-muted">{emp.name} é “só holerite”: o 13º fica registrado, sem conta a pagar.</p>}
        <Field label="Observações"><Textarea maxLength={1000} value={f.notes} disabled={readOnly} onChange={(e) => setF((p) => ({ ...p, notes: e.target.value }))} /></Field>
        {item && item.lines.length > 0 && (
          <div className="rounded-xl border border-line p-3">
            <p className="mb-1.5 text-[13px] font-medium text-muted">Recibo{item.fileName ? ` · ${item.fileName}` : ''}</p>
            <ul className="flex flex-col gap-1 text-sm">
              {item.lines.map((i, n) => (
                <li key={n} className="flex items-baseline gap-2">
                  <span className="min-w-0 flex-1 truncate">{i.name}</span>
                  <span className={cn('tnum shrink-0', i.kind === 'deduction' && 'text-danger')}>{i.kind === 'deduction' ? '− ' : ''}{formatBRL(i.amount)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Dialog>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return <p className="flex items-start gap-2 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{children}</p>;
}
