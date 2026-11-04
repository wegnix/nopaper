import { useEffect, useMemo, useState } from 'react';
import { useSearchParams, Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { Archive, ChevronLeft, ChevronRight, Folder, FolderOpen, Plus, RefreshCw, Search, Tag, Wallet, X, FileSpreadsheet } from 'lucide-react';
import { MONTHS_PT, formatBRL, sumMoney, todayISO, type AttachmentSlot, type BillType } from '@nopaper/shared';
import { Button, Card, Empty, Input, PageHeader, Segmented, Select, Spinner } from '@/components/ui/base';
import { ColorChip } from '@/components/ui/chips';
import { useConfirm } from '@/components/ui/dialog';
import { get, post, qs, errMsg } from '@/lib/api';
import { useCategories, useFolders } from '@/lib/queries';
import { useCan, useSession, useBillPerms } from '@/lib/session';
import { cn, plural } from '@/lib/utils';
import type { Bill, Summary } from '@/lib/types';
import { KpiRibbon } from './KpiRibbon';
import { BillsTable } from './BillsTable';
import { BillForm } from './BillForm';
import { BulkPayDialog, DeleteDialog, ExportDialog, PayDialog, RestructureDialog } from './dialogs';
import { CategoryManager, FolderManager } from './Catalog';
import { FileViewer, type FileViewerTarget } from './FileViewer';
import { L } from './labels';

type Status = '' | 'pending' | 'paid' | 'overdue' | 'due_soon';

export function BillsPage({ type }: { type: BillType }) {
  const l = L[type];
  const can = useCan();
  const perm = useBillPerms(type);
  const orgId = useSession((s) => s.orgId);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [sp, setSp] = useSearchParams();
  const now = todayISO();

  // filtros na URL (dá para compartilhar/voltar)
  const year = Number(sp.get('ano')) || Number(now.slice(0, 4));
  const month = Number(sp.get('mes')) || Number(now.slice(5, 7));
  const status = (sp.has('situacao') ? sp.get('situacao') : 'pending') as Status;
  const categoryId = sp.get('categoria') ?? '';
  const folderId = sp.get('pasta') ?? '';
  const search = sp.get('busca') ?? '';
  const setParam = (patch: Record<string, string | number | null>) => {
    const n = new URLSearchParams(sp);
    for (const [k, v] of Object.entries(patch)) { if (v === null) n.delete(k); else n.set(k, String(v)); }
    setSp(n, { replace: true });
  };
  const [searchText, setSearchText] = useState(search);
  useEffect(() => setSearchText(search), [search]);
  useEffect(() => {
    const t = setTimeout(() => { if (searchText !== search) setParam({ busca: searchText || null }); }, 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchText]);

  const { data: categories = [] } = useCategories();
  const { data: folders = [] } = useFolders();
  const catMap = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  const folderMap = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const typeCats = categories.filter((c) => c.kind === 'both' || c.kind === type);

  const listQ = useQuery({
    queryKey: ['bills', orgId, type, year, month, status, categoryId, folderId, search],
    queryFn: () => get<{ items: Bill[] }>(`/api/bills?${qs({ type, year, month, status, categoryId, folderId, search })}`).then((r) => r.items),
    placeholderData: (prev) => prev,
  });
  const sumQ = useQuery({
    queryKey: ['bills', orgId, 'summary', type, year, month],
    queryFn: () => get<Summary>(`/api/bills/summary?${qs({ type, year, month })}`),
    placeholderData: (prev) => prev,
  });
  const bills = listQ.data ?? [];
  const today = sumQ.data?.today ?? now;

  // seleção
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    const vis = new Set(bills.filter((b) => b.status === 'pending').map((b) => b.id));
    setSelected((s) => { const n = new Set([...s].filter((id) => vis.has(id))); return n.size === s.size ? s : n; });
  }, [bills]);
  const selectedBills = bills.filter((b) => selected.has(b.id));

  // diálogos
  const [form, setForm] = useState<{ open: boolean; bill: Bill | null }>({ open: false, bill: null });
  const [pay, setPay] = useState<{ bill: Bill; proofOnly: boolean } | null>(null);
  const [delBill, setDelBill] = useState<Bill | null>(null);
  const [restructure, setRestructure] = useState<Bill | null>(null);
  const [bulk, setBulk] = useState(false);
  const [mgr, setMgr] = useState<'cat' | 'folder' | 'export' | null>(null);
  const [viewer, setViewer] = useState<FileViewerTarget | null>(null);

  useEffect(() => {
    if (sp.get('nova') === '1' && perm.create) { setForm({ open: true, bill: null }); setParam({ nova: null }); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sp]);

  const shiftMonth = (d: number) => {
    let m = month + d, y = year;
    if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
    setParam({ ano: y, mes: m });
  };
  const unpay = async (b: Bill) => {
    if (!(await confirm({ title: `${l.unpay}?`, body: <>“{b.description}” volta para <b>Pendente</b>. A data e o valor {type === 'payable' ? 'pagos' : 'recebidos'} são limpos; os anexos continuam.</>, confirmLabel: 'Reverter' }))) return;
    try { await post(`/api/bills/${b.id}/unpay`); qc.invalidateQueries({ queryKey: ['bills'] }); toast.success('Revertido para pendente'); } catch (e) { toast.error(errMsg(e)); }
  };
  const stopRecurrence = async (b: Bill) => {
    if (!(await confirm({ title: 'Parar a série?', body: 'As ocorrências futuras pendentes (a partir de hoje) serão apagadas. As passadas e as pagas ficam no histórico.', confirmLabel: 'Parar série', tone: 'danger' }))) return;
    try {
      const r = await post<{ deleted: number }>(`/api/bills/${b.id}/recurrence/stop`);
      qc.invalidateQueries({ queryKey: ['bills'] });
      toast.success(`Série encerrada · ${plural(r.deleted, 'ocorrência futura apagada', 'ocorrências futuras apagadas')}`);
      setForm({ open: false, bill: null });
    } catch (e) { toast.error(errMsg(e)); }
  };
  const view = (b: Bill, slot: AttachmentSlot) => {
    const a = b.attachments[slot];
    if (a) setViewer({ attachmentId: a.id, slot, title: b.description });
  };

  const activeFilters = !!(categoryId || folderId || search);

  return (
    <div className="flex flex-col gap-5">
      <PageHeader
        title={l.title}
        actions={<>
          {can('bills.folders') && <Button size="sm" variant="ghost" icon={<FolderOpen className="size-4" />} onClick={() => setMgr('folder')}>Pastas</Button>}
          {can('bills.categories') && <Button size="sm" variant="ghost" icon={<Tag className="size-4" />} onClick={() => setMgr('cat')}>Categorias</Button>}
          {can('bills.import') && perm.create && <Link to={type === 'receivable' ? '/importar?tipo=receber' : '/importar'} className="inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-lg px-3 text-[13px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-ink"><FileSpreadsheet className="size-4" />Importar</Link>}
          {can('bills.export') && <Button size="sm" variant="ghost" icon={<Archive className="size-4" />} onClick={() => setMgr('export')}>Exportar</Button>}
          {perm.create && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setForm({ open: true, bill: null })}>{l.new}</Button>}
        </>}
      />

      <KpiRibbon type={type} s={sumQ.data} active={status} onFilter={(s) => setParam({ situacao: s })} />

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-line p-3 md:p-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className={cn('flex items-center rounded-lg border border-line bg-surface-2', status === 'overdue' && 'opacity-50')}>
              <button className="grid size-10 place-items-center text-muted hover:text-ink" onClick={() => shiftMonth(-1)} aria-label="Mês anterior"><ChevronLeft className="size-4" /></button>
              <Select aria-label="Mês" className="h-10 w-[130px] border-0 bg-transparent hover:border-0 focus:ring-0 font-medium" value={month} onChange={(e) => setParam({ mes: e.target.value })}>
                {MONTHS_PT.map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
              </Select>
              <Input aria-label="Ano" type="number" className="h-10 w-[76px] border-0 bg-transparent px-1 focus:ring-0 font-medium tnum" value={year} onChange={(e) => setParam({ ano: Number(e.target.value) || year })} />
              <button className="grid size-10 place-items-center text-muted hover:text-ink" onClick={() => shiftMonth(1)} aria-label="Próximo mês"><ChevronRight className="size-4" /></button>
            </div>
            <Segmented<Status> value={status} onChange={(s) => setParam({ situacao: s })} options={[
              { value: '', label: 'Todas' }, { value: 'pending', label: 'Pendentes' }, { value: 'overdue', label: l.overduePl }, { value: 'paid', label: l.paidPl },
            ]} />
            <div className="relative flex-1 min-w-[200px]">
              <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
              <Input className="pl-9" placeholder="Buscar por descrição, pessoa, observação…" value={searchText} onChange={(e) => setSearchText(e.target.value)} />
            </div>
            <Button variant="ghost" size="sm" className="size-10 p-0" aria-label="Atualizar" onClick={() => qc.invalidateQueries({ queryKey: ['bills'] })}>
              <RefreshCw className={cn('size-4', (listQ.isFetching || sumQ.isFetching) && 'animate-spin')} />
            </Button>
          </div>
          {status === 'overdue' && <p className="text-xs text-danger">Mostrando tudo o que está em atraso, de qualquer mês.</p>}

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="mr-1 inline-flex items-center gap-1 text-xs text-faint"><Folder className="size-3.5" /> Pasta</span>
            <ChipToggle active={!folderId} onClick={() => setParam({ pasta: null })}>Todas</ChipToggle>
            <ChipToggle active={folderId === 'none'} dashed onClick={() => setParam({ pasta: folderId === 'none' ? null : 'none' })}>Sem pasta</ChipToggle>
            {folders.map((f) => (
              <ColorChip key={f.id} color={folderId === f.id ? f.color : 'slate'} active={folderId === f.id} title={f.name} onClick={() => setParam({ pasta: folderId === f.id ? null : f.id })} className={cn(folderId !== f.id && 'opacity-70')}>{f.label}</ColorChip>
            ))}
            <span className="mx-2 h-5 w-px bg-line" />
            <span className="mr-1 inline-flex items-center gap-1 text-xs text-faint"><Tag className="size-3.5" /> Categoria</span>
            <ChipToggle active={!categoryId} onClick={() => setParam({ categoria: null })}>Todas</ChipToggle>
            {typeCats.map((c) => (
              <ColorChip key={c.id} color={c.color} active={categoryId === c.id} onClick={() => setParam({ categoria: categoryId === c.id ? null : c.id })} className={cn(categoryId && categoryId !== c.id && 'opacity-45')}>
                {c.label}{c.isRestricted ? ' 🔒' : ''}
              </ColorChip>
            ))}
            {activeFilters && <button className="ml-2 inline-flex items-center gap-1 text-xs text-muted hover:text-ink" onClick={() => setParam({ pasta: null, categoria: null, busca: null })}><X className="size-3.5" /> limpar filtros</button>}
          </div>
        </div>

        {listQ.isLoading ? <div className="grid place-items-center py-20"><Spinner /></div>
          : bills.length === 0 ? (
            <Empty icon={<Wallet className="size-5" />} title={activeFilters || status ? 'Nenhuma conta com estes filtros' : `Nenhuma conta em ${MONTHS_PT[month - 1].toLowerCase()}`}
              action={perm.create && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setForm({ open: true, bill: null })}>{l.new}</Button>}>
              {status === 'pending' ? 'Tudo em dia neste mês. Troque o filtro para “Todas” para ver as já quitadas.' : 'Ajuste o mês ou os filtros acima.'}
            </Empty>
          ) : (
            <>
              <BillsTable
                type={type} bills={bills} today={today} categories={catMap} folders={folderMap} perm={perm}
                selected={selected} setSelected={setSelected}
                actions={{
                  onEdit: (b) => setForm({ open: true, bill: b }), onPay: (b) => setPay({ bill: b, proofOnly: false }),
                  onProof: (b) => setPay({ bill: b, proofOnly: true }), onUnpay: unpay, onDelete: setDelBill, onView: view,
                }}
              />
              <div className="flex justify-between gap-4 border-t border-line px-4 py-3 text-xs text-muted">
                <span>{plural(bills.length, 'conta', 'contas')}</span>
                <span className="tnum">Soma da lista: <b className="text-ink">{formatBRL(sumMoney(bills.map((b) => b.amount)))}</b></span>
              </div>
            </>
          )}
      </Card>

      <AnimatePresence>
        {selected.size > 0 && (
          <motion.div
            initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }} transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            className="fixed bottom-5 left-1/2 z-[4000] -translate-x-1/2 flex items-center gap-4 rounded-2xl border border-line bg-raised px-4 py-3 shadow-2xl max-w-[95vw]"
          >
            <span className="text-sm"><b>{selected.size}</b> selecionada(s) · <span className="tnum">{formatBRL(sumMoney(selectedBills.map((b) => b.amount)))}</span></span>
            <Button size="sm" variant="ok" onClick={() => setBulk(true)}>{l.bulk}</Button>
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Limpar</Button>
          </motion.div>
        )}
      </AnimatePresence>

      <BillForm
        type={type} open={form.open} bill={form.bill} onClose={() => setForm({ open: false, bill: null })}
        onRestructure={(b) => setRestructure(b)} onStopRecurrence={stopRecurrence} onView={view}
      />
      {pay && <PayDialog bill={pay.bill} proofOnly={pay.proofOnly} onClose={() => setPay(null)} onView={view} />}
      {delBill && <DeleteDialog bill={delBill} onClose={() => setDelBill(null)} />}
      {restructure && <RestructureDialog bill={restructure} onClose={() => setRestructure(null)} onDone={() => setForm({ open: false, bill: null })} />}
      <BulkPayDialog type={type} bills={selectedBills} open={bulk} onClose={() => setBulk(false)} onDone={() => setSelected(new Set())} />
      <CategoryManager open={mgr === 'cat'} onClose={() => setMgr(null)} />
      <FolderManager open={mgr === 'folder'} onClose={() => setMgr(null)} />
      <ExportDialog type={type} open={mgr === 'export'} onClose={() => setMgr(null)} year={year} month={month} filters={{ status, categoryId, folderId, search, count: bills.length }} />
      <FileViewer target={viewer} onClose={() => setViewer(null)} />
    </div>
  );
}

function ChipToggle({ active, onClick, children, dashed }: { active: boolean; onClick: () => void; children: React.ReactNode; dashed?: boolean }) {
  return (
    <button type="button" onClick={onClick}
      className={cn('rounded-md border px-2 py-0.5 text-xs font-medium transition-colors', dashed && 'border-dashed',
        active ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-ink')}>
      {children}
    </button>
  );
}
