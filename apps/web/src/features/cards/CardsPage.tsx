import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DropdownMenu } from 'radix-ui';
import { toast } from 'sonner';
import { ArrowLeftRight, Check, ChevronLeft, ChevronRight, CreditCard, FileUp, Tags, X, MoreHorizontal, Pencil, Plus, Receipt, RotateCcw, Trash2, Wallet } from 'lucide-react';
import { COLOR_PRESETS, MONTHS_PT, addMonthsRef, formatBRL, formatDateBR, isColorKey, toCents, type AttachmentSlot } from '@nopaper/shared';
import { Button, Card, Empty, PageHeader, Spinner } from '@/components/ui/base';
import { CategoryChip, StatusChip } from '@/components/ui/chips';
import { useConfirm } from '@/components/ui/dialog';
import { api, get, post, errMsg } from '@/lib/api';
import { useCardCategories } from '@/lib/queries';
import { useBillNames, useCan, useSession } from '@/lib/session';
import { cn, isTouch } from '@/lib/utils';
import type { Bill, Card as CardT, CardTx, StatementView } from '@/lib/types';
import { CountUp } from '@/features/bills/KpiRibbon';
import { PayDialog } from '@/features/bills/dialogs';
import { FileViewer, type FileViewerTarget } from '@/features/bills/FileViewer';
import { CardVisual } from './CardVisual';
import { CardFormDialog, TxFormDialog, refLabel } from './CardForms';
import { CardOfxDialog } from './CardImport';
import { CardCategoryManager } from './CardCategories';

const STATUS = { open: { status: 'pending' as const, label: 'Aberta' }, closed: { status: 'today' as const, label: 'Fechada · a pagar' }, paid: { status: 'paid' as const, label: 'Paga' } };

export function CardsPage() {
  const can = useCan();
  const payName = useBillNames()('payable');
  const canEdit = can('cards.edit');
  const canManage = can('cards.manage');
  const canPay = can('payable.pay');
  const orgId = useSession((s) => s.orgId);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [sp, setSp] = useSearchParams();
  const { data: cats = [] } = useCardCategories();
  const catMap = useMemo(() => new Map(cats.map((c) => [c.id, c])), [cats]);

  const cardsQ = useQuery({ queryKey: ['bills', orgId, 'cards'], queryFn: () => get<{ items: CardT[] }>('/api/cards').then((r) => r.items) });
  const cards = cardsQ.data ?? [];
  const selId = sp.get('cartao') && cards.some((c) => c.id === sp.get('cartao')) ? sp.get('cartao')! : cards.find((c) => c.active)?.id ?? cards[0]?.id;
  const card = cards.find((c) => c.id === selId);
  const ref = sp.get('fatura') ?? card?.currentRef;
  const set = (patch: Record<string, string | null>) => { const n = new URLSearchParams(sp); for (const [k, v] of Object.entries(patch)) v === null ? n.delete(k) : n.set(k, v); setSp(n, { replace: true }); };

  const stQ = useQuery({
    enabled: !!card && !!ref, queryKey: ['bills', orgId, 'statement', card?.id, ref],
    queryFn: () => get<StatementView>(`/api/cards/${card!.id}/statement?ref=${ref}`), placeholderData: (p) => p,
  });
  const st = stQ.data;

  const [cardForm, setCardForm] = useState<{ open: boolean; card: CardT | null }>({ open: false, card: null });
  const [txForm, setTxForm] = useState<{ open: boolean; tx: CardTx | null }>({ open: false, tx: null });
  const [pay, setPay] = useState<{ bill: Bill; proofOnly: boolean } | null>(null);
  const [ofxOpen, setOfxOpen] = useState(false);
  const [viewer, setViewer] = useState<FileViewerTarget | null>(null);

  const [catsOpen, setCatsOpen] = useState(false);
  const [catFilter, setCatFilter] = useState<string | null>(null);
  useEffect(() => { setCatFilter(null); }, [card?.id, ref]);
  const shownItems = useMemo(() => (catFilter ? (st?.items ?? []).filter((t) => t.categoryId === catFilter) : st?.items ?? []), [st, catFilter]);
  // gasto por categoria do cartão: estorno abate na própria categoria; % sobre as categorias com saldo positivo
  const byCat = useMemo(() => {
    const m = new Map<string, number>();
    for (const t of st?.items ?? []) m.set(t.categoryId ?? '', (m.get(t.categoryId ?? '') ?? 0) + toCents(t.amount));
    const rows = [...m.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    return { rows, total: rows.reduce((a, [, v]) => a + v, 0) };
  }, [st]);

  const unpay = async (b: Bill) => {
    if (!(await confirm({ title: 'Reverter o pagamento da fatura?', body: <>A fatura volta para <b>Pendente</b> aqui e em {payName.title}. A data e o valor pagos são limpos; o comprovante continua anexado.</>, confirmLabel: 'Reverter' }))) return;
    try { await post(`/api/bills/${b.id}/unpay`); qc.invalidateQueries({ queryKey: ['bills'] }); toast.success('Pagamento revertido'); } catch (e) { toast.error(errMsg(e)); }
  };
  const removeTx = async (t: CardTx) => {
    const multi = t.totalInstallments > 1;
    const ok = await confirm({
      title: `Apagar "${t.description}"?`, tone: 'danger', confirmLabel: multi ? 'Apagar todas as parcelas' : 'Apagar',
      body: multi ? `Esta compra tem ${t.totalInstallments} parcelas. Todas serão removidas das faturas (as faturas já pagas são recalculadas).` : 'O lançamento sai da fatura.',
    });
    if (!ok) return;
    try { await api('DELETE', `/api/card-transactions/${t.id}?scope=group`); qc.invalidateQueries({ queryKey: ['bills'] }); toast.success('Lançamento apagado'); } catch (e) { toast.error(errMsg(e)); }
  };
  const moveTx = async (t: CardTx, to: string) => {
    try { await post(`/api/card-transactions/${t.id}/move`, { ref: to }); qc.invalidateQueries({ queryKey: ['bills'] }); toast.success(`Movido para a fatura de ${refLabel(to)}`); } catch (e) { toast.error(errMsg(e)); }
  };
  const view = (b: Bill, slot: AttachmentSlot) => { const a = b.attachments[slot]; if (a) setViewer({ attachmentId: a.id, slot, title: b.description }); };

  if (cardsQ.isLoading) return <div className="grid place-items-center py-24"><Spinner /></div>;

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <PageHeader title="Cartões de crédito" description={`Lance as compras no cartão; cada fatura vira uma ${payName.one} automaticamente.`}
        actions={<>
          <Button variant="ghost" icon={<Tags className="size-4" />} onClick={() => setCatsOpen(true)}>Categorias</Button>
          {canManage && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setCardForm({ open: true, card: null })}>Novo cartão</Button>}
        </>} />

      {!cards.length ? (
        <Card><Empty icon={<CreditCard className="size-5" />} title="Nenhum cartão cadastrado" action={canManage && <Button variant="primary" onClick={() => setCardForm({ open: true, card: null })}>Cadastrar cartão</Button>}>
          Informe o dia de fechamento e de vencimento para o NoPaper saber em qual fatura cada compra cai.
        </Empty></Card>
      ) : (
        <>
          <div className="-mx-3 sm:-mx-4 md:-mx-5 lg:-mx-6 overflow-x-auto no-scrollbar snap-x snap-mandatory scroll-px-3 sm:scroll-px-4 px-3 sm:px-4 md:px-5 lg:px-6 pb-3 pt-3">
            <div className="flex gap-4 sm:gap-6 [&>*]:snap-start">
              {/* clique num cartão o seleciona; no já selecionado, abre a edição */}
              {cards.map((c) => <CardVisual key={c.id} card={c} selected={c.id === selId} editable={canManage}
                onClick={() => (c.id === selId && canManage ? setCardForm({ open: true, card: c }) : set({ cartao: c.id, fatura: null }))} />)}
            </div>
          </div>

          {card && ref && (
            <Card className="overflow-hidden">
              <div className="flex flex-wrap items-center gap-3 sm:gap-4 border-b border-line p-3 sm:p-4 md:p-5">
                <div className="flex items-center rounded-lg border border-line bg-surface-2">
                  <button className="grid size-10 place-items-center text-muted hover:text-ink" onClick={() => set({ fatura: addMonthsRef(ref, -1) })} aria-label="Fatura anterior"><ChevronLeft className="size-4" /></button>
                  <span className="min-w-[110px] text-center font-display font-semibold">{refLabel(ref)}</span>
                  <button className="grid size-10 place-items-center text-muted hover:text-ink" onClick={() => set({ fatura: addMonthsRef(ref, 1) })} aria-label="Próxima fatura"><ChevronRight className="size-4" /></button>
                </div>
                {ref !== card.currentRef && <button className="text-xs text-accent hover:underline" onClick={() => set({ fatura: null })}>ir para a fatura atual</button>}
                {st && <StatusChip {...STATUS[st.status]} />}
                <div className="ml-auto flex flex-wrap gap-2 max-sm:ml-0 max-sm:w-full max-sm:[&>button]:flex-1">
                  {canManage && <Button variant="ghost" icon={<Pencil className="size-4" />} onClick={() => setCardForm({ open: true, card })}>Editar cartão</Button>}
                  {st?.bill && st.bill.status === 'pending' && canPay && <Button variant="ok" icon={<Check className="size-4" />} onClick={() => setPay({ bill: st.bill!, proofOnly: false })}>Pagar fatura</Button>}
                  {st?.bill && st.bill.status === 'paid' && canPay && <Button variant="ghost" icon={<RotateCcw className="size-4" />} onClick={() => unpay(st.bill!)}>Reverter pagamento</Button>}
                  {st?.bill && st.bill.status === 'paid' && canPay && <Button variant="ghost" icon={<Receipt className="size-4" />} onClick={() => setPay({ bill: st.bill!, proofOnly: true })}>Comprovante</Button>}
                  {canEdit && card.active && <Button variant="ghost" icon={<FileUp className="size-4" />} onClick={() => setOfxOpen(true)}>Importar fatura</Button>}
                  {canEdit && card.active && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setTxForm({ open: true, tx: null })}>Lançar compra</Button>}
                </div>
              </div>

              <div className="grid lg:grid-cols-[1fr_300px]">
                <div className="min-w-0">
                  <div className="grid grid-cols-2 sm:grid-cols-3 border-b border-line">
                    <div className="p-3.5 sm:p-4 md:p-5 max-sm:col-span-2 max-sm:border-b max-sm:border-line"><p className="text-xs text-muted">Total da fatura</p><CountUp value={st?.total ?? '0'} className="mt-1 block font-display text-2xl font-semibold" /></div>
                    <div className="sm:border-l border-line p-3.5 sm:p-4 md:p-5"><p className="text-xs text-muted">Fecha em</p><p className="mt-1 font-display text-lg font-semibold tnum">{st ? formatDateBR(st.statement.closingDate) : '—'}</p></div>
                    <div className="border-l border-line p-3.5 sm:p-4 md:p-5"><p className="text-xs text-muted">Vence em</p><p className="mt-1 font-display text-lg font-semibold tnum">{st ? formatDateBR(st.statement.dueDate) : '—'}</p></div>
                  </div>
                  {st && (
                    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line bg-surface-2/40 px-4 py-2.5 text-xs text-muted md:px-5">
                      <Wallet className="size-3.5 text-accent" />
                      {st.bill ? (
                        <>
                          <span>Esta fatura é uma {payName.one} de <b className="text-ink">{MONTHS_PT[Number(st.bill.dueDate.slice(5, 7)) - 1]} de {st.bill.dueDate.slice(0, 4)}</b> ({st.bill.status === 'paid' ? 'paga' : 'pendente'}).</span>
                          <Link to={`/pagar?ano=${st.bill.dueDate.slice(0, 4)}&mes=${Number(st.bill.dueDate.slice(5, 7))}&situacao=`} className="font-medium text-accent hover:underline">Ver em {payName.title}</Link>
                        </>
                      ) : <span>A {payName.one} desta fatura é criada no primeiro lançamento e entra em {payName.title} no mês do vencimento.</span>}
                    </p>
                  )}
                  {catFilter && (
                    <div className="flex items-center gap-2 border-b border-line bg-accent-soft/40 px-4 py-2 text-xs md:px-5">
                      <span>Mostrando só <b>{catMap.get(catFilter)?.label ?? 'Sem categoria'}</b> · {shownItems.length} lançamento(s)</span>
                      <button className="ml-auto inline-flex items-center gap-1 font-medium text-accent hover:underline" onClick={() => setCatFilter(null)}><X className="size-3.5" />Mostrar todos</button>
                    </div>
                  )}
                  {stQ.isLoading ? <div className="grid place-items-center py-16"><Spinner /></div> : !st?.items.length ? (
                    <p className="px-5 py-14 text-center text-sm text-muted">Nenhum lançamento nesta fatura.</p>
                  ) : (
                    <ul className="divide-y divide-line">
                      {shownItems.map((t) => (
                        <li key={t.id} className="group flex items-center gap-3 px-4 md:px-5 py-3">
                          <span className="w-12 shrink-0 text-xs text-faint tnum">{formatDateBR(t.purchaseDate).slice(0, 5)}</span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">{t.description}</p>
                            <p className="text-xs text-faint max-sm:line-clamp-2">
                              {t.totalInstallments > 1 ? `parcela ${t.installmentNumber}/${t.totalInstallments} · total ${formatBRL(t.totalAmount)}` : 'à vista'}
                              {t.notes && ` · ${t.notes}`}
                            </p>
                          </div>
                          <CategoryChip category={t.categoryId ? catMap.get(t.categoryId) : undefined} className="hidden sm:inline-flex" />
                          <span className={cn('shrink-0 text-right tnum text-sm font-medium sm:w-28', t.amount.startsWith('-') && 'text-ok')}>{formatBRL(t.amount)}</span>
                          {canEdit && (
                            <DropdownMenu.Root>
                              <DropdownMenu.Trigger className="grid size-8 pointer-coarse:size-10 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink" aria-label="Ações"><MoreHorizontal className="size-4" /></DropdownMenu.Trigger>
                              <DropdownMenu.Portal>
                                <DropdownMenu.Content align="end" sideOffset={4} className="z-[6000] w-60 rounded-xl border border-line bg-raised p-1.5 shadow-2xl text-sm">
                                  <DropdownMenu.Item onSelect={() => setTxForm({ open: true, tx: t })} className="flex items-center gap-2 rounded-lg px-2 py-2 outline-none data-[highlighted]:bg-surface-2 cursor-pointer"><Pencil className="size-4 text-faint" /> Editar</DropdownMenu.Item>
                                  <DropdownMenu.Item onSelect={() => moveTx(t, addMonthsRef(ref, 1))} className="flex items-center gap-2 rounded-lg px-2 py-2 outline-none data-[highlighted]:bg-surface-2 cursor-pointer"><ArrowLeftRight className="size-4 text-faint" /> Mover para {refLabel(addMonthsRef(ref, 1))}</DropdownMenu.Item>
                                  <DropdownMenu.Item onSelect={() => moveTx(t, addMonthsRef(ref, -1))} className="flex items-center gap-2 rounded-lg px-2 py-2 outline-none data-[highlighted]:bg-surface-2 cursor-pointer"><ArrowLeftRight className="size-4 text-faint" /> Mover para {refLabel(addMonthsRef(ref, -1))}</DropdownMenu.Item>
                                  <DropdownMenu.Separator className="my-1 h-px bg-line" />
                                  <DropdownMenu.Item onSelect={() => removeTx(t)} className="flex items-center gap-2 rounded-lg px-2 py-2 text-danger outline-none data-[highlighted]:bg-surface-2 cursor-pointer"><Trash2 className="size-4" /> Apagar</DropdownMenu.Item>
                                </DropdownMenu.Content>
                              </DropdownMenu.Portal>
                            </DropdownMenu.Root>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                <aside className="min-w-0 border-t lg:border-t-0 lg:border-l border-line p-4 sm:p-5">
                  <div className="flex items-center justify-between gap-2">
                    <h3 className="font-display font-semibold">Gastos por categoria</h3>
                    <button className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline" onClick={() => setCatsOpen(true)}><Tags className="size-3.5" />Categorias</button>
                  </div>
                  <ul className="mt-3 -mx-2 flex flex-col gap-0.5">
                    {byCat.rows.map(([id, cents]) => {
                      const c = catMap.get(id);
                      const color = COLOR_PRESETS[c && isColorKey(c.color) ? c.color : 'slate'].base;
                      return (
                        <li key={id || 'none'}>
                          <button type="button" onClick={() => setCatFilter(catFilter === id ? null : id)}
                            className={cn('w-full rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-surface-2', catFilter === id && 'bg-accent-soft/60 hover:bg-accent-soft/60')}>
                            <div className="flex items-baseline justify-between gap-2 text-sm">
                              <span className="flex min-w-0 items-center gap-2"><span className="size-2 shrink-0 rounded-full" style={{ background: color }} /><span className="truncate">{c?.label ?? 'Sem categoria'}</span></span>
                              <span className="shrink-0 tnum text-muted">{formatBRL(cents / 100)}</span>
                            </div>
                            <div className="mt-1.5 flex items-center gap-2">
                              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-accent transition-[width] duration-700" style={{ width: `${(cents / byCat.rows[0][1]) * 100}%` }} /></div>
                              <span className="w-12 shrink-0 text-right text-xs tnum text-faint">{(Math.round((cents / byCat.total) * 10000) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}%</span>
                            </div>
                          </button>
                        </li>
                      );
                    })}
                    {!byCat.rows.length && <li className="px-2 text-sm text-faint">Sem gastos nesta fatura.</li>}
                  </ul>
                  {byCat.rows.length > 0 && <p className="mt-3 flex justify-between border-t border-line pt-3 text-sm"><span className="text-muted">Total consumido</span><b className="tnum">{formatBRL(byCat.total / 100)}</b></p>}
                  {byCat.rows.length > 1 && <p className="mt-2 text-xs text-faint">{isTouch() ? 'Toque' : 'Clique'} numa categoria para ver só as compras dela.</p>}
                  {st?.bill && <p className="mt-6 text-xs text-faint">{payName.one[0].toUpperCase() + payName.one.slice(1)} vinculada: “{st.bill.description}”, {st.bill.status === 'paid' ? `paga em ${formatDateBR(st.bill.paidAt)}` : 'pendente'}.</p>}
                </aside>
              </div>
            </Card>
          )}
        </>
      )}

      <CardFormDialog open={cardForm.open} card={cardForm.card} onClose={() => setCardForm({ open: false, card: null })} onSaved={(c) => { setCardForm({ open: true, card: c }); if (c.id !== selId) set({ cartao: c.id, fatura: null }); }} onDeleted={() => set({ cartao: null, fatura: null })} />
      <CardCategoryManager open={catsOpen} onClose={() => setCatsOpen(false)} canManage={canManage} />
      {card && canEdit && <CardOfxDialog open={ofxOpen} onClose={() => setOfxOpen(false)} cards={cards} cardId={card.id} onDone={(cartao, fatura) => set({ cartao, fatura })} />}
      {card && <TxFormDialog card={card} open={txForm.open} tx={txForm.tx} onClose={() => setTxForm({ open: false, tx: null })} />}
      {pay && <PayDialog bill={pay.bill} proofOnly={pay.proofOnly} onClose={() => setPay(null)} onView={view} />}
      <FileViewer target={viewer} onClose={() => setViewer(null)} />
    </div>
  );
}
