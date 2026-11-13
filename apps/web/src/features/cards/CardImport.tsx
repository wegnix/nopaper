import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, FileText, Info, Layers, RotateCcw, Upload } from 'lucide-react';
import {
  addMonthsRef, cycleForRef, formatBRL, formatDateBR, fromCents, matchExistingCardTx, suggestCardRef, toCents, type CardOfxLine, type SpaceCheck,
} from '@nopaper/shared';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { Button, Checkbox, Field, Input, Select, Spinner, Switch } from '@/components/ui/base';
import { api, del, get, post, errMsg } from '@/lib/api';
import { WrongSpaceAlert, WrongSpaceNote, useSpaceGuard } from '@/components/WrongSpace';
import { useCardCategories } from '@/lib/queries';
import { useSession } from '@/lib/session';
import { cn, plural } from '@/lib/utils';
import type { Card, StatementView } from '@/lib/types';
import { refLabel } from './CardForms';

type Line = CardOfxLine & { suggestedCategoryId: string | null; suggestedFrom: 'shop' | 'rule' | null };
interface ReadResult { fileName: string; bank: string | null; accountId: string | null; balance: string | null; balanceDate: string | null; warnings: string[]; lines: Line[]; knownCard?: { id: string; name: string } | null; spaceCheck?: SpaceCheck | null }
interface RowState { checked: boolean; description: string; categoryId: string }
interface CardImportRow { id: string; fileName: string; rowCount: number; totalAmount: string; createdAt: string; createdBy: string | null; parcels: number; refs: string[]; paidRefs: string[] }

function useCardImports(cardId: string | undefined, enabled: boolean) {
  const orgId = useSession((s) => s.orgId);
  return useQuery({
    enabled: enabled && !!cardId, queryKey: ['bills', orgId, 'card-imports', cardId],
    queryFn: () => get<{ items: CardImportRow[] }>(`/api/cards/${cardId}/imports`).then((r) => r.items),
  });
}

/**
 * Importar a fatura do cartão (OFX): lê o arquivo, sugere a fatura e as categorias (pelo histórico),
 * reconhece o que já está lançado e cria as compras — parcelas seguintes vão para as próximas faturas.
 */
export function CardOfxDialog({ open, onClose, cards, cardId: initialCardId, onDone }: {
  open: boolean; onClose: () => void; cards: Card[]; cardId: string; onDone: (cardId: string, ref: string) => void;
}) {
  const qc = useQueryClient();
  const orgId = useSession((s) => s.orgId);
  const { data: payCats = [] } = useCardCategories(open);
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<ReadResult | null>(null);
  const guard = useSpaceGuard(file?.spaceCheck);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cardId, setCardId] = useState(initialCardId);
  const [ref, setRef] = useState('');
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [defaultCat, setDefaultCat] = useState('');
  const [future, setFuture] = useState(true);
  const activeCards = cards.filter((c) => c.active);
  const card = cards.find((c) => c.id === cardId);

  useEffect(() => { if (open) { setFile(null); setCardId(initialCardId); setFuture(true); } }, [open, initialCardId]);
  // fatura sugerida pelas datas das compras e o ciclo do cartão escolhido
  useEffect(() => {
    if (!file || !card) return;
    setRef(suggestCardRef(file.lines, card.closingDay, card.dueDay) ?? card.currentRef);
    setDefaultCat((c) => (c && payCats.some((p) => p.id === c) ? c : payCats.find((p) => p.ruleKey === 'other')?.id ?? payCats[0]?.id ?? ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file, cardId]);

  const stQ = useQuery({
    enabled: open && !!file && !!card && !!ref, queryKey: ['bills', orgId, 'statement', cardId, ref],
    queryFn: () => get<StatementView>(`/api/cards/${cardId}/statement?ref=${ref}`),
  });
  const st = stQ.data;
  const dup = useMemo(() => (file && st ? matchExistingCardTx(file.lines, st.items) : new Map<string, string>()), [file, st]);
  const usedExisting = new Set(dup.values());
  const otherExisting = (st?.items ?? []).filter((t) => !usedExisting.has(t.id));

  const pick = async (f: File) => {
    setReading(true);
    try {
      const fd = new FormData(); fd.append('file', f);
      const r = await api<ReadResult>('POST', '/api/cards/ofx/read', fd);
      setRows(Object.fromEntries(r.lines.map((l) => [l.fitId, {
        checked: l.kind !== 'payment', description: l.description,
        categoryId: l.suggestedCategoryId && payCats.some((c) => c.id === l.suggestedCategoryId) ? l.suggestedCategoryId : '',
      }])));
      // fatura de um cartão já conhecido (pelas importações anteriores): troca para ele
      if (r.knownCard && cards.some((c) => c.id === r.knownCard!.id && c.active)) setCardId(r.knownCard.id);
      setFile(r);
    } catch (e) { toast.error(errMsg(e)); } finally { setReading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const importable = (l: Line) => l.kind !== 'payment' && !dup.has(l.fitId);
  const selected = (file?.lines ?? []).filter((l) => importable(l) && rows[l.fitId]?.checked);
  const total = selected.reduce((a, l) => a + toCents(l.amount), 0);
  const maxInst = Math.max(0, ...selected.filter((l) => l.installment && l.installments! > l.installment).map((l) => l.installments!));
  const futureParcels = selected.reduce((a, l) => a + (l.installment ? l.installments! - l.installment : 0), 0);
  const paid = st?.status === 'paid';
  const missingCat = selected.some((l) => !(rows[l.fitId].categoryId || defaultCat));
  const missingDesc = selected.some((l) => !rows[l.fitId].description.trim());
  // a conta do arquivo já é de outro cartão deste espaço, ou este cartão sempre recebeu faturas de outra conta
  const otherCard = file?.knownCard && file.knownCard.id !== cardId ? file.knownCard : null;
  const otherAccount = !otherCard && !!file?.accountId && !!card?.ofxAccount && card.ofxAccount !== file.accountId;
  const [cardSure, setCardSure] = useState(false);
  useEffect(() => { setCardSure(false); }, [file, cardId]);
  const cardDoubt = !!otherCard || otherAccount;
  const ok = !guard.blocked && (!cardDoubt || cardSure) && !!card && !!ref && !!st && !paid && selected.length > 0 && !missingCat && !missingDesc;
  const importableCount = (file?.lines ?? []).filter(importable).length;
  const allChecked = importableCount > 0 && selected.length === importableCount;
  const setRow = (id: string, patch: Partial<RowState>) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));
  const toggleAll = (v: boolean) => setRows((r) => Object.fromEntries(Object.entries(r).map(([id, s]) => [id, { ...s, checked: v }])));

  const run = async () => {
    if (!file || !card) return;
    setBusy(true);
    try {
      const r = await post<{ created: number; skipped: number; total: string; parcels?: number }>(`/api/cards/${card.id}/ofx/import`, {
        fileName: file.fileName, ref, futureInstallments: future, accountId: file.accountId,
        items: selected.map((l) => ({
          fitId: l.fitId, date: l.date, description: rows[l.fitId].description.trim(), amount: l.amount, categoryId: rows[l.fitId].categoryId || defaultCat,
          installment: l.installment, installments: l.installments, notes: l.memo && l.memo !== rows[l.fitId].description.trim() ? l.memo.slice(0, 1000) : null,
        })),
      });
      qc.invalidateQueries({ queryKey: ['bills'] });
      if (!r.created) toast.info('Nada novo: tudo já estava na fatura.');
      else toast.success(`${plural(r.created, 'lançamento importado', 'lançamentos importados')} na fatura de ${refLabel(ref)} (${formatBRL(r.total)})${r.skipped ? ` · ${r.skipped} já estava(m) lá` : ''}`);
      onDone(card.id, ref);
      onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  const refOptions = useMemo(() => {
    if (!card || !ref) return [];
    const base = suggestCardRef(file?.lines ?? [], card.closingDay, card.dueDay) ?? ref;
    const set = new Set([...Array.from({ length: 7 }, (_, i) => addMonthsRef(base, i - 3)), ref]);
    return [...set].sort().map((r) => cycleForRef(r, card.closingDay, card.dueDay));
  }, [card, ref, file]);

  return (
    <Dialog open={open} onClose={onClose} size={file ? 'xl' : 'md'} title="Importar fatura do cartão (OFX)"
      description={file ? 'Confira a fatura, as descrições e as categorias. O que já está lançado é reconhecido e não entra de novo.' : 'Traga as compras da fatura direto do arquivo do banco, sem digitar uma por uma.'}
      footer={file && !guard.blocked ? <>
        <Button variant="ghost" className="mr-auto" onClick={() => setFile(null)}>Trocar arquivo</Button>
        <span className="hidden sm:block text-sm text-muted">{plural(selected.length, 'marcado', 'marcados')} · <b className="tnum text-ink">{formatBRL(fromCents(total))}</b></span>
        <Button variant="ghost" onClick={onClose}>Fechar</Button>
        <Button variant="primary" loading={busy} disabled={!ok} onClick={run}>Importar {selected.length || ''}</Button>
      </> : <Button variant="ghost" onClick={onClose}>Fechar</Button>}>
      <input ref={fileRef} type="file" accept=".ofx,.OFX,application/x-ofx,application/ofx" className="hidden" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
      {!file ? (
        <div className="flex flex-col gap-4">
          <button type="button" onClick={() => fileRef.current?.click()} disabled={reading}
            className="flex w-full flex-col items-center gap-3 rounded-xl border-2 border-dashed border-line px-6 py-12 text-center transition hover:border-accent hover:bg-accent-soft/30">
            {reading ? <Spinner className="size-6" /> : <span className="grid size-12 place-items-center rounded-2xl bg-accent-soft text-accent"><Upload className="size-5" /></span>}
            <span className="font-medium">{reading ? 'Lendo a fatura…' : 'Escolher a fatura (.ofx)'}</span>
            <span className="text-xs text-faint">Exportada no app ou no internet banking do cartão.</span>
          </button>
          <div className="rounded-xl bg-surface-2/60 px-4 py-3 text-sm text-muted">
            <p className="font-medium text-ink">Como funciona</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              <li>Compra parcelada (ex.: <b>02/12</b>) entra nesta fatura e as parcelas seguintes já vão para as próximas.</li>
              <li>Estornos abatem da fatura; o pagamento da fatura anterior fica de fora (ele é a baixa da conta a pagar).</li>
              <li>A categoria do cartão é sugerida pelo que você usou antes na mesma loja ou pelo nome dela (mercado, posto, farmácia…).</li>
            </ul>
          </div>
          <ImportHistory cardId={initialCardId} cardName={cards.find((c) => c.id === initialCardId)?.name ?? ''} open={open} />
        </div>
      ) : guard.blocked ? (
        <WrongSpaceAlert check={guard.check!} subject="Esta fatura" risk="as compras desta fatura entram num cartão deste espaço e mudam o valor da conta a pagar da fatura."
          onOtherFile={() => setFile(null)} onContinue={guard.accept} />
      ) : (
        <div className="flex flex-col gap-4">
          {guard.accepted && <WrongSpaceNote check={guard.check!} />}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
            <span className="flex min-w-0 items-center gap-1.5"><FileText className="size-4 shrink-0 text-faint" /><span className="truncate">{file.fileName}</span></span>
            {file.bank && <span>{file.bank}</span>}
            <span>{plural(file.lines.length, 'lançamento', 'lançamentos')} no arquivo</span>
            {file.balance && <span>Saldo informado pelo banco{file.balanceDate ? ` em ${formatDateBR(file.balanceDate)}` : ''}: <b className="tnum text-ink">{formatBRL(fromCents(Math.abs(toCents(file.balance))))}</b></span>}
          </div>
          {file.warnings.map((w) => <p key={w} className="flex items-start gap-2 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{w}</p>)}

          {cardDoubt && (
            <div role="alert" className="flex flex-col gap-3 rounded-xl border-2 border-danger bg-danger/10 p-4">
              <p className="flex items-start gap-2.5 text-sm">
                <AlertTriangle className="mt-0.5 size-5 shrink-0 text-danger" />
                <span>
                  <b className="block font-display text-base">Esta fatura parece ser de outro cartão</b>
                  {otherCard
                    ? <>As faturas desta conta (final {file.accountId?.slice(-4)}) sempre foram importadas no cartão <b>{otherCard.name}</b>, e você escolheu <b>{card?.name}</b>.</>
                    : <>O cartão <b>{card?.name}</b> sempre recebeu faturas da conta final {card?.ofxAccount?.slice(-4)}, e este arquivo é da conta final {file.accountId?.slice(-4)}.</>}
                </span>
              </p>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                {otherCard && <Button size="sm" variant="primary" onClick={() => setCardId(otherCard.id)}>Usar o cartão {otherCard.name}</Button>}
                <Checkbox checked={cardSure} onChange={setCardSure} label={<>Conferi: quero importar em <b>{card?.name}</b> mesmo assim.</>} />
              </div>
            </div>
          )}
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Cartão">
              <Select value={cardId} onChange={(e) => setCardId(e.target.value)}>
                {activeCards.map((c) => <option key={c.id} value={c.id}>{c.name}{c.last4 ? ` ·· ${c.last4}` : ''}</option>)}
              </Select>
            </Field>
            <Field label="Fatura" hint={card && ref ? `Fecha em ${formatDateBR(cycleForRef(ref, card.closingDay, card.dueDay).closingDate)} e vence em ${formatDateBR(cycleForRef(ref, card.closingDay, card.dueDay).dueDate)}.` : undefined}>
              <Select value={ref} onChange={(e) => setRef(e.target.value)}>
                {refOptions.map((o) => <option key={o.ref} value={o.ref}>{refLabel(o.ref)} · vence {formatDateBR(o.dueDate)}</option>)}
              </Select>
            </Field>
            <Field label="Categoria padrão" hint="Para os lançamentos sem categoria própria.">
              <Select value={defaultCat} onChange={(e) => setDefaultCat(e.target.value)}>
                {payCats.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </Select>
            </Field>
          </div>

          {stQ.isLoading ? <div className="grid place-items-center py-4"><Spinner /></div> : paid ? (
            <p className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
              <span>A fatura de <b>{refLabel(ref)}</b> já está paga. Reverta o pagamento na tela do cartão antes de importar, ou escolha outra fatura.</span></p>
          ) : otherExisting.length > 0 && (
            <p className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm"><Info className="mt-0.5 size-4 shrink-0 text-warn" />
              <span>A fatura de {refLabel(ref)} já tem {plural(otherExisting.length, 'lançamento', 'lançamentos')} que não {otherExisting.length === 1 ? 'está' : 'estão'} no arquivo ({formatBRL(fromCents(otherExisting.reduce((a, t) => a + toCents(t.amount), 0)))}): {otherExisting.slice(0, 3).map((t) => `“${t.description}”`).join(', ')}{otherExisting.length > 3 && '…'}. Se for o total da fatura lançado à mão, apague-o depois para não contar duas vezes.</span></p>
          )}

          {maxInst > 0 && (
            <Switch checked={future} onChange={setFuture} label="Lançar também as próximas parcelas"
              hint={future ? `${plural(futureParcels, 'parcela futura vai', 'parcelas futuras vão')} para as faturas seguintes (até ${refLabel(addMonthsRef(ref, Math.max(...selected.filter((l) => l.installment).map((l) => l.installments! - l.installment!))))}). Nas próximas importações elas são reconhecidas.` : 'Só a parcela desta fatura entra; as seguintes vêm nas próximas importações.'} />
          )}

          <div className="overflow-hidden rounded-xl border border-line">
            <div className="flex items-center gap-3 border-b border-line bg-surface-2/60 px-3 py-2 text-xs text-muted">
              <Checkbox checked={allChecked} indeterminate={!allChecked && selected.length > 0} onChange={toggleAll} disabled={!importableCount} />
              <span className="flex-1">{plural(selected.length, 'marcado', 'marcados')} de {importableCount}</span>
              <span className="tnum sm:hidden font-medium text-ink">{formatBRL(fromCents(total))}</span>
            </div>
            <ul className="divide-y divide-line">
              {file.lines.map((l) => {
                const s = rows[l.fitId];
                const isDup = dup.has(l.fitId);
                const off = l.kind === 'payment' || isDup;
                return (
                  <li key={l.fitId} className={cn('flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2.5 md:flex-nowrap', off && 'bg-surface-2/40', !off && !s.checked && 'opacity-60')}>
                    <Checkbox checked={!off && s.checked} disabled={off} onChange={(v) => setRow(l.fitId, { checked: v })} />
                    <span className="w-11 shrink-0 text-xs text-faint tnum">{formatDateBR(l.date).slice(0, 5)}</span>
                    <div className="min-w-0 flex-1 basis-40 max-sm:order-1 max-sm:basis-full">
                      {off ? <p className="truncate text-sm text-muted">{l.description}</p> : (
                        <Input value={s.description} onChange={(e) => setRow(l.fitId, { description: e.target.value })} className="h-9" aria-label="Descrição" />
                      )}
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-faint">
                        {l.kind === 'payment' && <span className="text-muted">Pagamento da fatura anterior · não entra</span>}
                        {isDup && <span className="flex items-center gap-1 text-ok"><CheckCircle2 className="size-3.5" />Já está na fatura</span>}
                        {l.kind === 'refund' && !isDup && <span className="text-ok">Estorno · abate da fatura</span>}
                        {!off && s.categoryId && s.categoryId === l.suggestedCategoryId && l.suggestedFrom && <span className="text-muted">{l.suggestedFrom === 'shop' ? 'categoria usada antes nesta loja' : 'categoria pelo nome da loja'}</span>}
                        {l.installment && <span className="flex items-center gap-1"><Layers className="size-3.5" />parcela {l.installment}/{l.installments}{!off && future && l.installment < l.installments! && ` · cria até ${l.installments}/${l.installments}`}</span>}
                        {l.memo !== l.description && <span className="truncate" title={l.memo}>{l.memo}</span>}
                      </p>
                    </div>
                    {!off && (
                      <div className="w-full pl-[5.25rem] max-sm:pl-0 md:w-48 md:shrink-0 md:pl-0 lg:w-56 max-md:order-last">
                        <Select value={s.categoryId} onChange={(e) => setRow(l.fitId, { categoryId: e.target.value })} aria-label="Categoria" className="h-9">
                          <option value="">Padrão{defaultCat ? ` (${payCats.find((c) => c.id === defaultCat)?.label ?? ''})` : ''}</option>
                          {payCats.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                        </Select>
                      </div>
                    )}
                    <span className={cn('ml-auto shrink-0 text-right text-sm font-medium tnum sm:w-28', l.amount.startsWith('-') && 'text-ok', off && 'font-normal text-faint line-through decoration-faint/50')}>{formatBRL(l.amount)}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </div>
      )}
    </Dialog>
  );
}

function ImportHistory({ cardId, cardName, open }: { cardId: string; cardName: string; open: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useCardImports(cardId, open);
  if (!q.data?.length) return null;
  const undo = async (b: CardImportRow) => {
    if (!(await confirm({ title: `Desfazer a importação de "${b.fileName}"?`, tone: 'danger', confirmLabel: 'Desfazer', body: `Apaga os ${b.parcels} lançamento(s) que ela criou no ${cardName}, inclusive as parcelas futuras. Compras lançadas à mão não são afetadas.` }))) return;
    try { const r = await del<{ removed: number }>(`/api/cards/imports/${b.id}`); qc.invalidateQueries({ queryKey: ['bills'] }); toast.success(`Importação desfeita (${plural(r.removed, 'lançamento', 'lançamentos')})`); } catch (e) { toast.error(errMsg(e)); }
  };
  return (
    <div>
      <p className="mb-2 text-sm font-medium">Importações no {cardName}</p>
      <ul className="divide-y divide-line rounded-xl border border-line">
        {q.data.map((b) => (
          <li key={b.id} className="flex items-center gap-3 px-3 py-2.5">
            <FileText className="size-4 shrink-0 text-faint" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{b.fileName}</span>
              <span className="block text-xs text-faint">
                {plural(b.rowCount, 'lançamento', 'lançamentos')} · {formatBRL(b.totalAmount)} · fatura {refLabel(b.refs[0])}{b.refs.length > 1 && ` (+ parcelas até ${refLabel(b.refs.at(-1)!)})`} · {formatDateBR(b.createdAt.slice(0, 10))}{b.createdBy ? ` por ${b.createdBy}` : ''}
              </span>
              {b.paidRefs.length > 0 && (
                <span className="mt-1 flex items-start gap-1.5 text-xs text-warn"><AlertTriangle className="mt-px size-3.5 shrink-0" />
                  <span>Para desfazer, reverta antes o pagamento da fatura de {b.paidRefs.map(refLabel).join(', ')} (tem parcelas desta importação).</span></span>
              )}
            </span>
            <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} disabled={b.paidRefs.length > 0} onClick={() => undo(b)}>Desfazer</Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
