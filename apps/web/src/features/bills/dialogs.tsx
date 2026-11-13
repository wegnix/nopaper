import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Archive, Download, Eye, FileSpreadsheet, Trash2 } from 'lucide-react';
import { MONTHS_PT, formatBRL, formatDateBR, sumMoney, todayISO, type AttachmentSlot, type BillType } from '@nopaper/shared';
import { Dialog } from '@/components/ui/dialog';
import { Button, Checkbox, Field, IconButton, Input, Segmented, Select } from '@/components/ui/base';
import { api, post, errMsg } from '@/lib/api';
import { useCategories, useFolders } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { cn, downloadBlob, plural } from '@/lib/utils';
import type { Bill } from '@/lib/types';
import { MoneyInput } from './MoneyInput';
import { DocDrop } from './DocDrop';
import { RecurrenceEditor, initialRec, recPayload, type RecState } from './RecurrenceEditor';
import { L } from './labels';
import { DatePicker } from '@/components/ui/date-picker';

const invalidate = (qc: ReturnType<typeof useQueryClient>) => qc.invalidateQueries({ queryKey: ['bills'] });

// ------------------------------------------------------------------ pagar / comprovante
export function PayDialog({ bill, proofOnly, onClose, onView }: { bill: Bill | null; proofOnly?: boolean; onClose: () => void; onView: (b: Bill, s: AttachmentSlot) => void }) {
  const qc = useQueryClient();
  const [paidAt, setPaidAt] = useState(todayISO());
  const [amount, setAmount] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (bill) { setPaidAt(todayISO()); setAmount(bill.amount); setFile(null); } }, [bill]);
  if (!bill) return <Dialog open={false} onClose={onClose} title="" />;
  const l = L[bill.type];

  const upload = async (billId: string) => {
    if (!file) return;
    const fd = new FormData(); fd.append('file', file);
    await api('POST', `/api/bills/${billId}/attachments?slot=payment_proof`, fd);
  };
  const submit = async () => {
    setBusy(true);
    try {
      if (!proofOnly) await post(`/api/bills/${bill.id}/pay`, { paidAt, paidAmount: amount || bill.amount });
      try { await upload(bill.id); } catch (e) { toast.error(`${proofOnly ? 'Falha ao enviar' : 'Pagamento registrado, mas o comprovante falhou'}: ${errMsg(e)}`); }
      toast.success(proofOnly ? 'Comprovante anexado' : `${bill.description}: ${l.paid.toLowerCase()}`);
      invalidate(qc); onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const removeProof = async () => {
    try { await api('DELETE', `/api/bills/${bill.id}/attachments/payment_proof`); invalidate(qc); onClose(); toast.success('Comprovante removido'); } catch (e) { toast.error(errMsg(e)); }
  };
  return (
    <Dialog open onClose={onClose} size="sm" title={proofOnly ? 'Comprovante' : l.markPaid} description={`${bill.description} · ${formatBRL(bill.amount)} · vence ${formatDateBR(bill.dueDate)}`}
      footer={<>
        <Button variant="ghost" onClick={onClose}>{proofOnly ? 'Fechar' : 'Cancelar'}</Button>
        {(!proofOnly || file) && <Button variant={proofOnly ? 'primary' : 'ok'} loading={busy} onClick={submit}>{proofOnly ? 'Enviar comprovante' : l.confirmPay}</Button>}
      </>}>
      <div className="flex flex-col gap-4">
        {!proofOnly && (
          <div className="grid grid-cols-2 gap-3">
            <Field label={l.paidAt}><DatePicker value={paidAt} onChange={setPaidAt} /></Field>
            <Field label={l.paidAmount}><MoneyInput value={amount} onChange={setAmount} /></Field>
            <p className="col-span-2 -mt-1 text-xs text-faint">Ajuste o valor se houve juros ou desconto.</p>
          </div>
        )}
        {proofOnly && bill.attachments.payment_proof && (
          <div className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm">
            <span className="flex-1 truncate">{bill.attachments.payment_proof.name}</span>
            <IconButton label="Visualizar" onClick={() => onView(bill, 'payment_proof')}><Eye className="size-4" /></IconButton>
            <IconButton label="Remover" tone="danger" onClick={removeProof}><Trash2 className="size-4" /></IconButton>
          </div>
        )}
        {file ? (
          <div className="flex items-center gap-2 rounded-lg border border-ok/40 bg-ok/5 px-3 py-2 text-sm">
            <span className="flex-1 truncate">{file.name}</span>
            <span className="text-xs text-faint">{Math.ceil(file.size / 1024)} KB</span>
            <IconButton label="Remover" onClick={() => setFile(null)}><Trash2 className="size-4" /></IconButton>
          </div>
        ) : <DocDrop compact onFile={setFile} label={proofOnly && bill.attachments.payment_proof ? 'Trocar comprovante' : 'Anexar comprovante (opcional)'} hint="PDF ou imagem" />}
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ apagar
export function DeleteDialog({ bill, onClose }: { bill: Bill | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'one' | 'forward' | 'series'>('one');
  const [busy, setBusy] = useState(false);
  useEffect(() => setMode('one'), [bill]);
  if (!bill) return <Dialog open={false} onClose={onClose} title="" />;
  const series = bill.parentId !== null || bill.recurrenceType !== 'once';
  const submit = async () => {
    setBusy(true);
    try {
      const r = await api<{ deleted: number; preservedPaid: number }>('DELETE', `/api/bills/${bill.id}?mode=${mode}`);
      toast.success(`${plural(r.deleted, 'lançamento apagado', 'lançamentos apagados')}${r.preservedPaid ? ` · ${r.preservedPaid} já pago(s) preservado(s)` : ''}`);
      invalidate(qc); onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const opt = (v: typeof mode, title: string, text: string) => (
    <label className={cn('flex gap-3 rounded-xl border p-3 cursor-pointer transition-colors', mode === v ? 'border-danger/50 bg-danger/5' : 'border-line hover:border-line-strong')}>
      <input type="radio" className="mt-1 accent-[var(--np-danger)]" checked={mode === v} onChange={() => setMode(v)} />
      <span><span className="block text-sm font-medium">{title}</span><span className="block text-xs text-faint mt-0.5">{text}</span></span>
    </label>
  );
  return (
    <Dialog open onClose={onClose} size="sm" title="Apagar conta?" description={`${bill.description} · ${formatBRL(bill.amount)} · vence ${formatDateBR(bill.dueDate)}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="danger" loading={busy} onClick={submit}>Apagar</Button></>}>
      <div className="flex flex-col gap-2">
        {series && <>
          {opt('one', 'Só esta', 'As outras ocorrências da série continuam.')}
          {opt('forward', 'Esta e as próximas', 'Remove as ocorrências futuras pendentes e para a repetição. As já pagas ficam no histórico.')}
          {opt('series', 'A série inteira', 'Remove todas as ocorrências, inclusive as pagas.')}
        </>}
        <p className="mt-1 text-xs text-faint">Os anexos das contas apagadas também são removidos. Não dá para desfazer.</p>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ pagamento em massa
export function BulkPayDialog({ type, bills, open, onClose, onDone }: { type: BillType; bills: Bill[]; open: boolean; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const [paidAt, setPaidAt] = useState(todayISO());
  const [busy, setBusy] = useState(false);
  const l = L[type];
  const submit = async () => {
    setBusy(true);
    try {
      const r = await post<{ updated: number }>('/api/bills/bulk-pay', { ids: bills.map((b) => b.id), paidAt });
      toast.success(`${plural(r.updated, 'conta', 'contas')} ${type === 'payable' ? 'paga(s)' : 'recebida(s)'}`);
      invalidate(qc); onDone(); onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} size="sm" title={`${l.payAction} ${plural(bills.length, 'conta', 'contas')}?`} description={`Total ${formatBRL(sumMoney(bills.map((b) => b.amount)))}`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="ok" loading={busy} onClick={submit}>{l.confirmPay}</Button></>}>
      <div className="flex flex-col gap-4">
        <ul className="max-h-48 overflow-y-auto divide-y divide-line rounded-lg border border-line text-sm">
          {bills.map((b) => <li key={b.id} className="flex justify-between gap-3 px-3 py-2"><span className="truncate">{b.description}</span><span className="tnum text-muted">{formatBRL(b.amount)}</span></li>)}
        </ul>
        <Field label={`${l.paidAt} (todas)`} hint="Cada conta recebe o próprio valor previsto. Para juros ou desconto, registre individualmente.">
          <DatePicker value={paidAt} onChange={setPaidAt} />
        </Field>
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ reestruturar recorrência
export function RestructureDialog({ bill, onClose, onDone }: { bill: Bill | null; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const [rec, setRec] = useState<RecState>(initialRec('monthly'));
  const [dueDate, setDueDate] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (bill) {
      const r = initialRec(bill.recurrenceType === 'once' ? 'monthly' : bill.recurrenceType, bill.isIndefinite);
      // parcelado: mantém a numeração atual (ex.: começa na 42 de 213)
      if (bill.installmentNumber && bill.totalInstallments) Object.assign(r, { first: bill.installmentNumber, count: bill.totalInstallments - bill.installmentNumber + 1 });
      setRec(r); setDueDate(bill.dueDate); setAmount(bill.amount);
    }
  }, [bill]);
  if (!bill) return <Dialog open={false} onClose={onClose} title="" />;
  const submit = async () => {
    setBusy(true);
    try {
      const r = await post<{ created: number; paidPreserved: number }>(`/api/bills/${bill.id}/restructure`, recPayload(rec, dueDate, amount));
      toast.success(`Repetição atualizada: ${plural(r.created + 1, 'lançamento', 'lançamentos')}${r.paidPreserved ? ` · ${r.paidPreserved} pago(s) preservado(s)` : ''}`);
      invalidate(qc); onDone(); onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} size="lg" title={bill.recurrenceType === 'once' ? 'Tornar recorrente' : 'Mudar repetição'}
      description={bill.recurrenceType === 'once' ? 'Esta conta vira a 1ª ocorrência e as próximas são criadas conforme a repetição escolhida.' : 'As ocorrências pendentes são recriadas com os novos parâmetros. As pagas ficam preservadas.'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} onClick={submit}>Aplicar repetição</Button></>}>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="1º vencimento"><DatePicker value={dueDate} onChange={setDueDate} /></Field>
          <Field label="Valor"><MoneyInput value={amount} onChange={setAmount} /></Field>
        </div>
        <RecurrenceEditor rec={rec} setRec={setRec} dueDate={dueDate} amount={amount} />
      </div>
    </Dialog>
  );
}

// ------------------------------------------------------------------ exportar ZIP
export interface ExportFilters { status: string; categoryId: string; folderId: string; search: string; days: string; count: number }

/** Exportar: a lista como planilha (Excel/CSV) ou o ZIP com anexos para a contabilidade. */
export function ExportDialog({ type, open, onClose, year: y0, month: m0, filters }: { type: BillType; open: boolean; onClose: () => void; year: number; month: number; filters: ExportFilters }) {
  const [kind, setKind] = useState<'sheet' | 'zip'>('sheet');
  useEffect(() => { if (open) setKind('sheet'); }, [open]);
  return (
    <Dialog open={open} onClose={onClose} size="sm" title="Exportar"
      description={kind === 'sheet' ? 'Baixe as contas numa planilha para abrir no Excel, Google Planilhas ou LibreOffice.' : 'Gera um ZIP com os anexos organizados por ano, mês e pasta.'}>
      <div className="flex flex-col gap-4">
        <Segmented value={kind} onChange={setKind} options={[
          { value: 'sheet', label: <span className="inline-flex items-center gap-1.5"><FileSpreadsheet className="size-3.5" />Planilha</span> },
          { value: 'zip', label: <span className="inline-flex items-center gap-1.5"><Archive className="size-3.5" />ZIP para contabilidade</span> },
        ]} />
        {kind === 'sheet'
          ? <SheetExport type={type} year={y0} month={m0} filters={filters} onDone={onClose} />
          : <ZipExport type={type} year={y0} month={m0} open={open} onDone={onClose} />}
      </div>
    </Dialog>
  );
}

function SheetExport({ type, year, month, filters, onDone }: { type: BillType; year: number; month: number; filters: ExportFilters; onDone: () => void }) {
  const [format, setFormat] = useState<'xlsx' | 'csv'>('xlsx');
  const [scope, setScope] = useState<'view' | 'month' | 'year'>('view');
  const [byMonth, setByMonth] = useState(true);
  const [busy, setBusy] = useState(false);
  const { data: cats = [] } = useCategories();
  // mais de um mês: o ano inteiro ou a lista de vencidas (de qualquer mês)
  const multiMonth = scope === 'year' || (scope === 'view' && filters.status === 'overdue');
  const { data: folders = [] } = useFolders();
  const l = L[type];
  const statusText: Record<string, string> = { pending: 'pendentes', paid: l.paidPl.toLowerCase(), overdue: `${l.overduePl.toLowerCase()} (todos os meses)`, due_soon: 'próximos 7 dias' };
  const viewParts = [
    filters.status === 'overdue' ? null : `${MONTHS_PT[month - 1]} de ${year}`,
    filters.status ? statusText[filters.status] : 'todas as situações',
    filters.categoryId ? cats.find((c) => c.id === filters.categoryId)?.label : null,
    filters.folderId === 'none' ? 'sem pasta' : filters.folderId ? folders.find((f) => f.id === filters.folderId)?.label : null,
    filters.search ? `“${filters.search}”` : null,
    filters.days ? `dia${filters.days.includes(',') ? 's' : ''} ${filters.days.split(',').join(', ')}` : null,
  ].filter(Boolean) as string[];
  const download = async () => {
    setBusy(true);
    try {
      const p: Record<string, string | number> = { type, format, byMonth: byMonth ? 1 : 0 };
      if (scope === 'view') {
        if (filters.status !== 'overdue') { p.year = year; p.month = month; }
        for (const k of ['status', 'categoryId', 'folderId', 'search', 'days'] as const) if (filters[k]) p[k] = filters[k];
      } else { p.year = year; if (scope === 'month') p.month = month; }
      const res = await api<Response>('GET', `/api/export/sheet?${new URLSearchParams(Object.entries(p).map(([k, v]) => [k, String(v)]))}`, undefined, { raw: true });
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `contas.${format}`;
      downloadBlob(await res.blob(), name);
      toast.success('Planilha gerada');
      onDone();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const opt = (v: typeof scope, title: string, sub: string) => (
    <button type="button" onClick={() => setScope(v)}
      className={cn('flex flex-col rounded-xl border px-3 py-2.5 text-left transition-colors', scope === v ? 'border-accent bg-accent-soft/50' : 'border-line hover:border-line-strong')}>
      <span className={cn('text-sm font-medium', scope === v && 'text-accent')}>{title}</span>
      <span className="text-xs text-muted">{sub}</span>
    </button>
  );
  return (
    <>
      <Field label="O que exportar">
        <div className="flex flex-col gap-2">
          {opt('view', 'A lista como está na tela', `${viewParts.join(' · ')} — ${plural(filters.count, 'conta', 'contas')}`)}
          {opt('month', `${MONTHS_PT[month - 1]} de ${year} inteiro`, 'Todas as situações, sem filtros')}
          {opt('year', `Ano de ${year} inteiro`, 'Todas as contas do ano, sem filtros')}
        </div>
      </Field>
      <Field label="Formato">
        <Segmented value={format} onChange={setFormat} options={[{ value: 'xlsx', label: 'Excel (.xlsx)' }, { value: 'csv', label: 'CSV' }]} />
      </Field>
      {format === 'xlsx' && multiMonth && (
        <Checkbox checked={byMonth} onChange={setByMonth} label={<span className="flex flex-col"><span className="text-sm">Uma aba para cada mês</span><span className="text-xs text-faint">Mais uma aba “Resumo” com os totais de cada mês e uma “Todas” com a lista completa.</span></span>} />
      )}
      <p className="text-xs text-faint">{format === 'xlsx' ? 'Com título, valores em R$, filtros nas colunas e linha de total.' : `Separado por ponto e vírgula, abre direto no Excel em português.${multiMonth ? ' CSV não tem abas: sai tudo numa lista só.' : ''}`}</p>
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onDone}>Cancelar</Button>
        <Button variant="primary" loading={busy} disabled={scope === 'view' && !filters.count} icon={<Download className="size-4" />} onClick={download}>Baixar planilha</Button>
      </div>
    </>
  );
}

function ZipExport({ type, year: y0, month: m0, open, onDone }: { type: BillType; year: number; month: number; open: boolean; onDone: () => void }) {
  const [year, setYear] = useState(y0);
  const [month, setMonth] = useState(m0);
  const [scope, setScope] = useState<'month' | 'year'>('month');
  const [sheet, setSheet] = useState(true);
  const [busy, setBusy] = useState(false);
  const { data: folders = [] } = useFolders();
  useEffect(() => { if (open) { setYear(y0); setMonth(m0); } }, [open, y0, m0]);
  const mm = String(month).padStart(2, '0');
  const submit = async () => {
    setBusy(true);
    try {
      // sem limite de tempo: um ano inteiro pode levar minutos numa conexão lenta
      const r = await api<Response>('POST', '/api/export/zip', { type, year, month: scope === 'month' ? month : null, includeSpreadsheet: sheet }, { raw: true });
      const name = `${type === 'payable' ? 'contas-pagar' : 'contas-receber'}-${year}${scope === 'month' ? '-' + mm : ''}.zip`;
      downloadBlob(await r.blob(), name);
      toast.success('ZIP gerado');
      onDone();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <>
      <Segmented value={scope} onChange={setScope} options={[{ value: 'month', label: 'Um mês' }, { value: 'year', label: 'Ano inteiro' }]} />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Ano"><Input type="number" min={2000} max={2200} value={year} onChange={(e) => setYear(Number(e.target.value) || y0)} /></Field>
        {scope === 'month' && <Field label="Mês"><Select value={month} onChange={(e) => setMonth(Number(e.target.value))}>{MONTHS_PT.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}</Select></Field>}
      </div>
      <Checkbox checked={sheet} onChange={setSheet} label="Incluir planilha (.xlsx) com todas as contas do período" />
      <pre className="rounded-lg bg-surface-2 border border-line p-3 text-[11.5px] leading-relaxed text-muted overflow-x-auto font-mono">{`${year}/
  ${scope === 'month' ? `${mm} - ${MONTHS_PT[month - 1].toUpperCase()} DE ${year}` : 'MM - MÊS DE ANO'}/
    ${folders[0]?.name ?? 'Sem pasta'}/
      Boleto - Descrição - Pago dd-mm-aaaa.pdf
      Nota Fiscal - Descrição - Pendente.pdf${sheet ? `\n  Relatório … .xlsx` : ''}`}</pre>
      {!folders.length && <p className="text-xs text-warn">Nenhuma pasta criada: tudo vai para “Sem pasta”.</p>}
      <div className="flex justify-end gap-2 pt-1">
        <Button variant="ghost" onClick={onDone}>Cancelar</Button>
        <Button variant="primary" loading={busy} icon={<Download className="size-4" />} onClick={submit}>Baixar ZIP</Button>
      </div>
    </>
  );
}
