import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Link } from 'react-router';
import { Check, CreditCard, ChevronDown, ChevronUp, ChevronsUpDown, Infinity as InfinityIcon, Pencil, Receipt, RotateCcw, StickyNote, Trash2, Users } from 'lucide-react';
import { copyDescriptionText, formatBRL, formatDateBR, toCents, type AttachmentSlot, type BillType } from '@nopaper/shared';
import { Button, Checkbox, IconButton } from '@/components/ui/base';
import { CategoryChip, FolderChip, StatusChip } from '@/components/ui/chips';
import { cn } from '@/lib/utils';
import type { BillPerms } from '@/lib/session';
import type { Bill, Category, Folder } from '@/lib/types';
import { AttachmentChips, CopyButton, attachmentCount } from './attachments';
import { L, displayStatus } from './labels';

/** Ordem alfabética em português: ignora maiúsculas e acentos, e números em ordem natural (2 antes de 10). */
const alpha = new Intl.Collator('pt-BR', { sensitivity: 'base', numeric: true });

type SortKey = 'dueDate' | 'description' | 'folder' | 'category' | 'amount' | 'status' | 'attachments' | 'paidAt';

export interface RowActions {
  onEdit(b: Bill): void; onPay(b: Bill): void; onProof(b: Bill): void; onUnpay(b: Bill): void; onDelete(b: Bill): void; onView(b: Bill, s: AttachmentSlot): void;
}

const statusRank = (b: Bill, today: string) => (b.status === 'paid' ? 3 : b.dueDate < today ? 1 : 2);

export function BillsTable({ type, bills, today, categories, folders, perm, selected, setSelected, actions }: {
  type: BillType; bills: Bill[]; today: string; categories: Map<string, Category>; folders: Map<string, Folder>;
  perm: BillPerms; selected: Set<string>; setSelected: (s: Set<string>) => void; actions: RowActions;
}) {
  const l = L[type];
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'dueDate', dir: 1 });
  const sorted = useMemo(() => {
    const val = (b: Bill): string | number | null => {
      switch (sort.key) {
        case 'dueDate': return b.dueDate;
        case 'description': return b.description.toLowerCase();
        case 'folder': return b.folderId ? folders.get(b.folderId)?.label.toLowerCase() ?? '' : null;
        case 'category': return categories.get(b.categoryId)?.label.toLowerCase() ?? '';
        case 'amount': return toCents(b.amount);
        case 'status': return statusRank(b, today);
        case 'attachments': return attachmentCount(b);
        case 'paidAt': return b.paidAt;
      }
    };
    // desempate: vencimento, depois descrição em ordem alfabética (sem diferenciar maiúsculas/acentos)
    const tie = (a: Bill, b: Bill) =>
      (a.dueDate < b.dueDate ? -1 : a.dueDate > b.dueDate ? 1 : 0)
      || alpha.compare(a.description, b.description)
      || (a.id < b.id ? -1 : 1);
    return [...bills].sort((a, b) => {
      const va = val(a), vb = val(b);
      if (va === null && vb === null) return tie(a, b);
      if (va === null) return 1;
      if (vb === null) return -1;
      const c = typeof va === 'string' && typeof vb === 'string' ? alpha.compare(va, vb) : va < vb ? -1 : va > vb ? 1 : 0;
      return c ? c * sort.dir : tie(a, b);
    });
  }, [bills, sort, categories, folders, today]);

  const pendingIds = bills.filter((b) => b.status === 'pending').map((b) => b.id);
  const allSel = pendingIds.length > 0 && pendingIds.every((id) => selected.has(id));
  const someSel = pendingIds.some((id) => selected.has(id));
  const toggle = (id: string) => { const s = new Set(selected); if (s.has(id)) s.delete(id); else s.add(id); setSelected(s); };

  const Th = ({ k, children, className }: { k: SortKey; children: React.ReactNode; className?: string }) => {
    const active = sort.key === k;
    return (
      <th className={cn('px-3 py-2.5 font-medium', className)}>
        <button type="button" onClick={() => setSort({ key: k, dir: active ? (sort.dir === 1 ? -1 : 1) : 1 })} className={cn('inline-flex items-center gap-1 hover:text-ink', active && 'text-ink')}>
          {children}
          {active ? (sort.dir === 1 ? <ChevronUp className="size-3.5 text-accent" /> : <ChevronDown className="size-3.5 text-accent" />) : <ChevronsUpDown className="size-3.5 opacity-30" />}
        </button>
      </th>
    );
  };

  const canSelect = perm.pay;
  const rowActions = (b: Bill) => (perm.pay || perm.edit || perm.delete || b.statementId || b.payrollEntryId) && (
    <div className="flex items-center justify-end gap-0.5">
      {perm.pay && (b.status === 'pending'
        ? <Button size="sm" variant="ok" className="h-7 px-2.5" icon={<Check className="size-3.5" />} onClick={() => actions.onPay(b)}>{l.payAction}</Button>
        : <>
          <IconButton label={b.attachments.payment_proof ? 'Trocar comprovante' : 'Anexar comprovante'} tone="ok" onClick={() => actions.onProof(b)}><Receipt className="size-4" /></IconButton>
          <IconButton label={l.unpay} onClick={() => actions.onUnpay(b)}><RotateCcw className="size-4" /></IconButton>
        </>)}
      {perm.edit && <IconButton label="Editar" onClick={() => actions.onEdit(b)}><Pencil className="size-4" /></IconButton>}
      {b.statementId
        ? <Link to={`/cartoes?cartao=${b.cardId}`} aria-label="Abrir fatura do cartão" title="Abrir fatura do cartão" className="grid size-8 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink"><CreditCard className="size-4" /></Link>
        : b.payrollEntryId
          ? <Link to={`/folha?lancamento=${b.payrollEntryId}`} aria-label="Abrir na folha de pagamento" title="Abrir na folha de pagamento" className="grid size-8 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink"><Users className="size-4" /></Link>
          : perm.delete && <IconButton label="Apagar" tone="danger" onClick={() => actions.onDelete(b)}><Trash2 className="size-4" /></IconButton>}
    </div>
  );

  const notesLine = (b: Bill, wrap = false) => b.notes?.trim() && (
    <p className={cn('mt-0.5 flex items-start gap-1 text-xs italic text-muted', !wrap && 'max-w-[230px] 2xl:max-w-[340px]')} title={b.notes}>
      <StickyNote className="mt-px size-3 shrink-0 text-accent/70" aria-label="Observação" />
      <span className={wrap ? 'line-clamp-2' : 'truncate'}>{b.notes.trim()}</span>
    </p>
  );

  const descCell = (b: Bill) => (
    <div className="min-w-0">
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => perm.edit && actions.onEdit(b)} className="truncate max-w-[200px] 2xl:max-w-[300px] text-left font-medium hover:text-accent" title={b.description}>{b.description}</button>
        {b.isIndefinite && <span title="Repete sem data para acabar" className="grid size-5 place-items-center rounded bg-accent-soft text-accent"><InfinityIcon className="size-3.5" /></span>}
        <CopyButton text={copyDescriptionText(b.description, b.amount)} label="Copiar descrição + valor (para transferência)" className="opacity-0 group-hover:opacity-100 focus:opacity-100" />
      </div>
      {(b.installmentNumber || b.relatedPerson || b.paymentMethod) && (
        <p className="mt-0.5 text-xs text-faint truncate">
          {[b.installmentNumber && `parcela ${b.installmentNumber}/${b.totalInstallments}`, b.relatedPerson, b.paymentMethod].filter(Boolean).join(' · ')}
        </p>
      )}
      {notesLine(b)}
    </div>
  );

  return (
    <>
      {/* desktop (telas largas): tabela */}
      <div className="hidden xl:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted border-b border-line">
            <tr>
              {canSelect && <th className="w-10 pl-4 pr-1"><Checkbox checked={allSel} indeterminate={!allSel && someSel} disabled={!pendingIds.length} onChange={(v) => setSelected(v ? new Set(pendingIds) : new Set())} /></th>}
              <Th k="dueDate">Vencimento</Th>
              <Th k="description">Descrição</Th>
              <Th k="folder" className="hidden 2xl:table-cell">Pasta</Th>
              <Th k="category">Categoria</Th>
              <Th k="amount" className="text-right">Valor</Th>
              <Th k="status">Situação</Th>
              <Th k="attachments">Anexos</Th>
              <Th k="paidAt" className="hidden 2xl:table-cell">{l.paidAt}</Th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            <AnimatePresence initial={false}>
              {sorted.map((b) => {
                const st = displayStatus(b, today);
                const sel = selected.has(b.id);
                return (
                  <motion.tr
                    key={b.id} layout="position" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.18 }}
                    className={cn('group border-b border-line/70 last:border-0 transition-colors hover:bg-surface-2/60', st.status === 'overdue' && 'bg-danger/[.04]', sel && 'bg-accent-soft/60')}
                  >
                    {canSelect && <td className="pl-4 pr-1"><Checkbox checked={sel} disabled={b.status === 'paid'} onChange={() => toggle(b.id)} /></td>}
                    <td className={cn('px-3 py-3 tnum whitespace-nowrap text-[13px]', st.status === 'overdue' && 'text-danger font-medium')}>{formatDateBR(b.dueDate)}</td>
                    <td className="px-3 py-3 max-w-[250px] 2xl:max-w-[360px]">
                      {descCell(b)}
                      {/* sem a coluna Pasta (telas menores que 2xl), a pasta aparece aqui */}
                      {b.folderId && <div className="mt-1 2xl:hidden"><FolderChip folder={folders.get(b.folderId)} /></div>}
                    </td>
                    <td className="hidden 2xl:table-cell px-3 py-3"><FolderChip folder={b.folderId ? folders.get(b.folderId) : null} /></td>
                    <td className="px-3 py-3"><CategoryChip category={categories.get(b.categoryId)} /></td>
                    <td className="px-3 py-3 text-right whitespace-nowrap">
                      <span className="tnum font-medium">{formatBRL(b.amount)}</span>
                      {b.paidAmount && b.paidAmount !== b.amount && <span className="block text-[11px] text-faint tnum">{type === 'payable' ? 'pago' : 'recebido'} {formatBRL(b.paidAmount)}</span>}
                    </td>
                    <td className="px-3 py-3">
                      <StatusChip {...st} />
                      {b.paidAt && <span className="mt-1 block 2xl:hidden text-[11px] text-faint tnum whitespace-nowrap">em {formatDateBR(b.paidAt)}</span>}
                    </td>
                    <td className="px-3 py-3"><AttachmentChips bill={b} onOpen={(s) => actions.onView(b, s)} /></td>
                    <td className="hidden 2xl:table-cell px-3 py-3 tnum text-[13px] text-muted whitespace-nowrap">{b.paidAt ? formatDateBR(b.paidAt) : '—'}</td>
                    <td className="px-3 py-3 pr-4">{rowActions(b)}</td>
                  </motion.tr>
                );
              })}
            </AnimatePresence>
          </tbody>
        </table>
      </div>

      {/* celular e tablet: cartões (1 coluna no celular, 2 no tablet) */}
      <div className="xl:hidden">
        <div className="flex items-center gap-3 border-b border-line px-4 py-2 text-xs text-muted">
          {canSelect && <Checkbox checked={allSel} indeterminate={!allSel && someSel} disabled={!pendingIds.length} onChange={(v) => setSelected(v ? new Set(pendingIds) : new Set())} label={<span className="text-xs text-muted">Pendentes</span>} className="items-center" />}
          <label className="ml-auto flex items-center gap-1.5">
            <span>Ordenar</span>
            <select
              aria-label="Ordenar por" className="h-8 rounded-md border border-line bg-surface-2 px-2 text-xs text-ink pointer-coarse:h-9"
              value={`${sort.key}:${sort.dir}`} onChange={(e) => { const [k, d] = e.target.value.split(':'); setSort({ key: k as SortKey, dir: Number(d) as 1 | -1 }); }}
            >
              <option value="dueDate:1">Vencimento ↑</option>
              <option value="dueDate:-1">Vencimento ↓</option>
              <option value="description:1">Descrição A–Z</option>
              <option value="amount:-1">Maior valor</option>
              <option value="amount:1">Menor valor</option>
              <option value="status:1">Situação</option>
              <option value="category:1">Categoria</option>
              <option value="folder:1">Pasta</option>
            </select>
          </label>
        </div>
        <ul className="grid md:grid-cols-2 [&>li]:border-line [&>li]:border-b md:[&>li:nth-child(odd)]:border-r">
          {sorted.map((b) => {
            const st = displayStatus(b, today);
            const hasAtt = attachmentCount(b) > 0;
            return (
              <li key={b.id} className={cn('flex min-w-0 gap-3 px-4 py-3', st.status === 'overdue' && 'bg-danger/[.04]', selected.has(b.id) && 'bg-accent-soft/60')}>
                {canSelect && <div className="pt-0.5"><Checkbox checked={selected.has(b.id)} disabled={b.status === 'paid'} onChange={() => toggle(b.id)} /></div>}
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex items-start justify-between gap-3">
                    <button type="button" onClick={() => perm.edit && actions.onEdit(b)} className="min-w-0 break-words text-left font-medium leading-snug">
                      {b.description}
                      {b.isIndefinite && <InfinityIcon className="ml-1 inline size-3.5 -translate-y-px text-accent" aria-label="Repete sem data para acabar" />}
                    </button>
                    <span className="text-right">
                      <span className="block tnum font-semibold whitespace-nowrap">{formatBRL(b.amount)}</span>
                      {b.paidAmount && b.paidAmount !== b.amount && <span className="block text-[11px] text-faint tnum whitespace-nowrap">{type === 'payable' ? 'pago' : 'recebido'} {formatBRL(b.paidAmount)}</span>}
                    </span>
                  </div>
                  {(b.installmentNumber || b.relatedPerson || b.paymentMethod) && (
                    <p className="mt-0.5 text-xs text-faint">
                      {[b.installmentNumber && `parcela ${b.installmentNumber}/${b.totalInstallments}`, b.relatedPerson, b.paymentMethod].filter(Boolean).join(' · ')}
                    </p>
                  )}
                  {notesLine(b, true)}
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs">
                    <span className={cn('tnum', st.status === 'overdue' ? 'text-danger font-medium' : 'text-muted')}>{formatDateBR(b.dueDate)}</span>
                    <StatusChip {...st} />
                    <CategoryChip category={categories.get(b.categoryId)} />
                    {b.folderId && <FolderChip folder={folders.get(b.folderId)} />}
                  </div>
                  <div className="mt-auto flex items-center justify-between gap-2 pt-2">
                    <div className="min-w-0">{hasAtt && <AttachmentChips bill={b} onOpen={(s) => actions.onView(b, s)} />}</div>
                    <div className="flex items-center gap-0.5">
                      <CopyButton text={copyDescriptionText(b.description, b.amount)} label="Copiar descrição + valor (para transferência)" toastMsg="Descrição e valor copiados" className="size-8 pointer-coarse:size-10 rounded-md" />
                      {rowActions(b)}
                    </div>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </>
  );
}
