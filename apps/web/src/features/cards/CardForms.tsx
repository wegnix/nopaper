import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, CalendarCheck, Trash2 } from 'lucide-react';
import {
  CARD_BRANDS, CARD_BRAND_LABEL, CARD_COLOR_KEYS, CARD_COLOR_PRESETS, MONTHS_PT_SHORT, addMonthsRef, classifySpending, cycleForPurchase, formatBRL, formatDateBR, parseMoneyInput,
  splitInstallments, todayISO, type CardBrand, type CardColorKey,
} from '@nopaper/shared';
import { Dialog, SaveFooter, useFormState } from '@/components/ui/dialog';
import { DayPicker } from '@/components/ui/day-picker';
import { Button, Field, Input, Select, Spinner, Switch, Textarea } from '@/components/ui/base';
import { del, get, post, put, errMsg } from '@/lib/api';
import { useCardCategories, useCategories, useFolders } from '@/lib/queries';
import type { Card, CardTx } from '@/lib/types';
import { ColorPicker } from '@/features/bills/Catalog';
import { MoneyInput } from '@/features/bills/MoneyInput';

export const refLabel = (ref: string) => `${MONTHS_PT_SHORT[Number(ref.slice(5, 7)) - 1]}/${ref.slice(0, 4)}`;

export function CardFormDialog({ card, open, onClose, onSaved, onDeleted }: { card: Card | null; open: boolean; onClose: () => void; onSaved?: (c: Card) => void; onDeleted?: () => void }) {
  const qc = useQueryClient();
  const { data: cats = [] } = useCategories();
  const { data: folders = [] } = useFolders();
  const payCats = cats.filter((c) => c.kind !== 'receivable');
  const [f, setF, form] = useFormState({ name: '', brand: 'mastercard' as CardBrand, last4: '', color: 'indigo' as CardColorKey, limitAmount: '', closingDay: 1, dueDay: 10, billCategoryId: '', billFolderId: '', holder: '', active: true });
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  useEffect(() => {
    if (!open) return;
    if (card) form.load({ name: card.name, brand: card.brand as CardBrand, last4: card.last4 ?? '', color: card.color as CardColorKey, limitAmount: card.limitAmount ?? '', closingDay: card.closingDay, dueDay: card.dueDay, billCategoryId: card.billCategoryId, billFolderId: card.billFolderId ?? '', holder: card.holder ?? '', active: card.active });
    else form.load({ ...f, name: '', last4: '', limitAmount: '', holder: '', billFolderId: '', active: true, billCategoryId: payCats.find((c) => /cart/i.test(c.label))?.id ?? payCats[0]?.id ?? '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, card?.id]);
  const save = async () => {
    setBusy(true);
    try {
      const body = { ...f, limitAmount: f.limitAmount || null, billFolderId: f.billFolderId || null, last4: f.last4 || null, holder: f.holder || null };
      const r = card ? await put<Card>(`/api/cards/${card.id}`, body) : await post<Card>('/api/cards', body);
      qc.invalidateQueries({ queryKey: ['bills'] });
      toast.success(card ? 'Cartão salvo' : 'Cartão cadastrado');
      form.markSaved(f); onSaved?.(r);
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const cycle = cycleForPurchase(todayISO(), f.closingDay, f.dueDay);
  return (
    <Dialog open={open} onClose={onClose} dirty={form.dirty} title={card ? 'Editar cartão' : 'Novo cartão'} description="Nunca guardamos o número completo do cartão — só os 4 últimos dígitos para você reconhecê-lo."
      footer={<SaveFooter dirty={form.dirty} isNew={!card} saving={busy} canSave={!!f.name.trim() && !!f.billCategoryId} onSave={save} onClose={onClose} saveLabel="Salvar cartão"
        left={card && <Button variant="ghost" className="mr-auto text-danger hover:text-danger" icon={<Trash2 className="size-4" />} onClick={() => setDeleting(true)}>Apagar cartão</Button>} />}>
      <div className="flex flex-col gap-4">
        <div className="grid sm:grid-cols-[1fr_140px] gap-4">
          <Field label="Nome" required><Input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Ex.: BTG Black, Nubank" /></Field>
          <Field label="4 últimos dígitos"><Input inputMode="numeric" maxLength={4} value={f.last4} onChange={(e) => setF({ ...f, last4: e.target.value.replace(/\D/g, '') })} /></Field>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <Field label="Bandeira" className="col-span-2 sm:col-span-1"><Select value={f.brand} onChange={(e) => setF({ ...f, brand: e.target.value as CardBrand })}>{CARD_BRANDS.map((b) => <option key={b} value={b}>{CARD_BRAND_LABEL[b]}</option>)}</Select></Field>
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[13px] font-medium text-muted">Fecha no dia</span>
            <DayPicker aria-label="Dia do fechamento" value={f.closingDay} onChange={(closingDay) => setF({ ...f, closingDay })} />
          </div>
          <div className="flex min-w-0 flex-col gap-1.5">
            <span className="text-[13px] font-medium text-muted">Vence no dia</span>
            <DayPicker aria-label="Dia do vencimento" value={f.dueDay} onChange={(dueDay) => setF({ ...f, dueDay })} />
          </div>
        </div>
        <div className="-mt-1 flex items-start gap-3 rounded-lg bg-accent-soft/50 px-3.5 py-3">
          <CalendarCheck className="mt-0.5 size-4 shrink-0 text-accent" />
          <p className="text-sm">
            A fatura fecha no dia {f.closingDay} e vence no dia {f.dueDay}{f.dueDay > f.closingDay ? ' do mesmo mês' : ' do mês seguinte'}. Compras feitas no dia do fechamento ou depois já entram na próxima fatura.
            <span className="mt-0.5 block text-xs text-muted">Hoje, uma compra cairia na fatura que fecha em {formatDateBR(cycle.closingDate)} e vence em {formatDateBR(cycle.dueDate)}.</span>
          </p>
        </div>
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Limite"><MoneyInput value={f.limitAmount} onChange={(limitAmount) => setF({ ...f, limitAmount })} /></Field>
          <Field label="Titular"><Input value={f.holder} onChange={(e) => setF({ ...f, holder: e.target.value })} /></Field>
          <Field label="Categoria da fatura" hint="Usada na conta a pagar criada para cada fatura."><Select value={f.billCategoryId} onChange={(e) => setF({ ...f, billCategoryId: e.target.value })}>{payCats.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select></Field>
          <Field label="Pasta da fatura"><Select value={f.billFolderId} onChange={(e) => setF({ ...f, billFolderId: e.target.value })}><option value="">Sem pasta</option>{folders.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}</Select></Field>
        </div>
        <Field label="Cor"><ColorPicker value={f.color} onChange={(color) => setF({ ...f, color })} keys={CARD_COLOR_KEYS} presets={CARD_COLOR_PRESETS} /></Field>
        {card && <Switch checked={f.active} onChange={(active) => setF({ ...f, active })} label="Cartão ativo" hint="Cartões desativados somem da lista de lançamento, mas o histórico fica." />}
      </div>
      {card && <DeleteCardDialog card={card} open={deleting} onClose={() => setDeleting(false)} onDeleted={() => { setDeleting(false); onClose(); onDeleted?.(); }} />}
    </Dialog>
  );
}

interface DeleteImpact { transactions: number; purchases: number; paidStatements: number; statementBills: number; attachments: number; canDeleteBills: boolean }

/** Confirmação de exclusão: mostra o que sai junto e, com lançamentos, pede o nome do cartão. */
function DeleteCardDialog({ card, open, onClose, onDeleted }: { card: Card; open: boolean; onClose: () => void; onDeleted: () => void }) {
  const qc = useQueryClient();
  const [impact, setImpact] = useState<DeleteImpact | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setImpact(null); setTyped('');
    get<DeleteImpact>(`/api/cards/${card.id}/delete-impact`).then(setImpact).catch((e) => { toast.error(errMsg(e)); onClose(); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, card.id]);
  const blocked = !!impact && (impact.paidStatements > 0 || (impact.statementBills > 0 && !impact.canDeleteBills));
  const needsName = !!impact && impact.transactions > 0;
  const nameOk = !needsName || typed.trim().toLowerCase() === card.name.trim().toLowerCase();
  const remove = async () => {
    setBusy(true);
    try {
      await del(`/api/cards/${card.id}${needsName ? `?confirmName=${encodeURIComponent(typed.trim())}` : ''}`);
      qc.invalidateQueries({ queryKey: ['bills'] });
      toast.success(`Cartão ${card.name} apagado`);
      onDeleted();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} title={`Apagar o cartão ${card.name}?`}
      footer={<><Button variant="ghost" onClick={onClose}>{blocked ? 'Fechar' : 'Cancelar'}</Button>{!blocked && <Button variant="danger" loading={busy} disabled={!impact || !nameOk} onClick={remove}>Apagar definitivamente</Button>}</>}>
      {!impact ? <div className="grid place-items-center py-8"><Spinner /></div> : blocked ? (
        <div className="flex flex-col gap-3 text-sm">
          <p className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn/10 p-3 text-ink"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
            {impact.paidStatements > 0
              ? <span>Este cartão tem <b>{impact.paidStatements} fatura(s) já paga(s)</b>. Elas fazem parte do histórico financeiro e não podem ser apagadas junto com o cartão.</span>
              : <span>Apagar o cartão remove as contas a pagar das faturas dele, e o seu grupo não tem permissão para apagar contas a pagar.</span>}
          </p>
          <p className="text-muted">Para tirá-lo de uso, desligue <b>Cartão ativo</b> na edição: ele some da lista de lançamentos e o histórico fica guardado.{impact.paidStatements > 0 && ' Se as faturas foram pagas por engano, reverta os pagamentos em Contas a pagar e tente de novo.'}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-4 text-sm">
          {impact.transactions === 0 ? <p className="text-muted">O cartão não tem lançamentos. Esta ação não pode ser desfeita.</p> : (
            <>
              <div>
                <p className="mb-2 text-muted">Junto com o cartão, serão apagados:</p>
                <ul className="flex flex-col gap-1 rounded-lg border border-line bg-surface-2/60 p-3">
                  <li><b className="tnum">{impact.purchases}</b> compra(s) ({impact.transactions} parcela(s) nas faturas)</li>
                  {impact.statementBills > 0 && <li><b className="tnum">{impact.statementBills}</b> fatura(s) em aberto e a conta a pagar de cada uma</li>}
                  {impact.attachments > 0 && <li><b className="tnum">{impact.attachments}</b> anexo(s) dessas contas</li>}
                </ul>
                <p className="mt-2 text-xs text-faint">Esta ação não pode ser desfeita. Se quiser só parar de usar o cartão, desligue "Cartão ativo" na edição.</p>
              </div>
              <Field label={<span>Digite <b className="text-ink">{card.name}</b> para confirmar</span>}>
                <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus autoComplete="off" />
              </Field>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}

export function TxFormDialog({ card, tx, open, onClose }: { card: Card; tx: CardTx | null; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: expCats = [] } = useCardCategories();
  const [f, setF, form] = useFormState({ description: '', categoryId: '', amount: '', purchaseDate: todayISO(), installments: 1, notes: '', refund: false, applyToShop: true });
  const fallbackCat = () => expCats.find((c) => c.ruleKey === 'other')?.id ?? expCats[0]?.id ?? '';
  const blankTx = () => ({ description: '', categoryId: fallbackCat(), amount: '', purchaseDate: todayISO(), installments: 1, notes: '', refund: false, applyToShop: true });
  // compra nova: a categoria segue o nome da loja até a pessoa escolher uma
  const [catTouched, setCatTouched] = useState(false);
  const setDescription = (description: string) => {
    if (tx || catTouched) return setF({ ...f, description });
    const rule = expCats.find((c) => c.ruleKey === classifySpending(description));
    setF({ ...f, description, categoryId: rule?.id ?? fallbackCat() });
  };
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setCatTouched(false);
    if (tx) form.load({ description: tx.description, categoryId: tx.categoryId ?? '', amount: tx.totalAmount.replace('-', ''), purchaseDate: tx.purchaseDate, installments: tx.totalInstallments, notes: tx.notes ?? '', refund: tx.totalAmount.startsWith('-'), applyToShop: true });
    else form.load(blankTx());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tx?.id]);
  const preview = useMemo(() => {
    const a = parseMoneyInput(f.amount);
    if (!a || !f.purchaseDate) return null;
    const first = cycleForPurchase(f.purchaseDate, card.closingDay, card.dueDay);
    const parts = splitInstallments(a, f.installments);
    return { first, parts, last: addMonthsRef(first.ref, f.installments - 1) };
  }, [f.amount, f.purchaseDate, f.installments, card.closingDay, card.dueDay]);
  const save = async () => {
    setBusy(true);
    const amount = (f.refund ? '-' : '') + (parseMoneyInput(f.amount) ?? '0');
    try {
      const catChanged = !!tx && f.categoryId !== tx.categoryId;
      if (tx) await put(`/api/card-transactions/${tx.id}`, { description: f.description, categoryId: f.categoryId, notes: f.notes || null, amount, purchaseDate: f.purchaseDate, installments: f.installments, scope: 'group', applyToShop: catChanged && f.applyToShop });
      else await post('/api/card-transactions', { cardId: card.id, description: f.description, categoryId: f.categoryId, amount, purchaseDate: f.purchaseDate, installments: f.installments, notes: f.notes || null });
      qc.invalidateQueries({ queryKey: ['bills'] });
      if (tx) { toast.success('Lançamento salvo'); form.markSaved(f); }
      else {
        // compra lançada: a janela fica pronta para a próxima (mesma data e categoria)
        toast.success(`“${f.description}” lançado. Pode lançar a próxima compra.`);
        form.load({ ...blankTx(), purchaseDate: f.purchaseDate }); setCatTouched(false);
      }
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} dirty={form.dirty} title={tx ? 'Editar lançamento' : `Lançar no ${card.name}`}
      description={tx && tx.totalInstallments > 1 ? 'Mudar valor, data ou parcelas recalcula todas as parcelas desta compra.' : undefined}
      footer={<SaveFooter dirty={form.dirty} isNew={!tx} saving={busy} canSave={!!f.description.trim() && !!f.categoryId && !!parseMoneyInput(f.amount)} onSave={save} onClose={onClose} saveLabel={tx ? 'Salvar' : 'Lançar'} />}>
      <div className="flex flex-col gap-4">
        <Field label="Descrição" required><Input autoFocus value={f.description} onChange={(e) => setDescription(e.target.value)} placeholder="Ex.: Mercado, Farmácia, Passagem" /></Field>
        <div className="grid sm:grid-cols-3 gap-4">
          <Field label={f.installments > 1 ? 'Valor total da compra' : 'Valor'} required><MoneyInput value={f.amount} onChange={(amount) => setF({ ...f, amount })} /></Field>
          <Field label="Data da compra" required><Input type="date" value={f.purchaseDate} onChange={(e) => setF({ ...f, purchaseDate: e.target.value })} /></Field>
          <Field label="Parcelas"><Select value={f.installments} onChange={(e) => setF({ ...f, installments: Number(e.target.value) })}>{Array.from({ length: 24 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n === 1 ? 'À vista' : `${n}x`}</option>)}</Select></Field>
        </div>
        <Field label="Categoria" required hint={!tx && !catTouched ? 'Sugerida pelo nome da loja.' : undefined}>
          <Select value={f.categoryId} onChange={(e) => { setCatTouched(true); setF({ ...f, categoryId: e.target.value }); }}>{expCats.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select>
        </Field>
        {tx && f.categoryId !== tx.categoryId && (
          <label className="-mt-2 flex items-center gap-2 text-sm text-muted"><input type="checkbox" className="accent-[var(--np-accent)]" checked={f.applyToShop} onChange={(e) => setF({ ...f, applyToShop: e.target.checked })} /> Mudar também as outras compras de “{f.description.split('*')[0].trim() || f.description}”</label>
        )}
        <Field label="Observações"><Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        <label className="flex items-center gap-2 text-sm text-muted"><input type="checkbox" className="accent-[var(--np-accent)]" checked={f.refund} onChange={(e) => setF({ ...f, refund: e.target.checked })} /> É um estorno ou crédito (abate da fatura)</label>
        {preview && (
          <div className="rounded-xl bg-accent-soft/60 border border-accent/25 px-4 py-3 text-sm">
            {f.installments > 1
              ? <>{f.installments}x de <b className="tnum">{formatBRL(preview.parts[1])}</b>{preview.parts[0] !== preview.parts[1] && <> (1ª de {formatBRL(preview.parts[0])})</>} — da fatura de <b>{refLabel(preview.first.ref)}</b> até <b>{refLabel(preview.last)}</b>.</>
              : <>Entra na fatura de <b>{refLabel(preview.first.ref)}</b>, que fecha em {formatDateBR(preview.first.closingDate)} e vence em {formatDateBR(preview.first.dueDate)}.</>}
          </div>
        )}
      </div>
    </Dialog>
  );
}
