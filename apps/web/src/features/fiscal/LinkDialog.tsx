import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Car, Check, Link2, Search } from 'lucide-react';
import {
  MATCH_REASON_LABELS, formatBRL, formatDateBR, fromCents, notesAfterLink, toCents,
  type FiscalCandidate, type FiscalDocumentRow,
} from '@nopaper/shared';
import { Button, Empty, Input, Spinner, Switch } from '@/components/ui/base';
import { Dialog } from '@/components/ui/dialog';
import { errMsg, get, post } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn, plural } from '@/lib/utils';

type Candidates = { items: FiscalCandidate[]; noteLine: string };

/**
 * Vincular a nota a contas a pagar já lançadas. Nada é escolhido sozinho: as sugestões só vêm ordenadas
 * (encontradas × podem ser) e a pessoa marca. Opcionalmente acrescenta a nota nas observações das contas,
 * mostrando antes → depois.
 */
export function LinkDialog({ doc, onClose, onDone }: { doc: FiscalDocumentRow | null; onClose: () => void; onDone: () => void }) {
  const orgId = useSession((s) => s.orgId);
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Map<string, FiscalCandidate>>(new Map());
  const [updateNotes, setUpdateNotes] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setText(''); setQ(''); setPicked(new Map()); setUpdateNotes(true); }, [doc?.id]);
  useEffect(() => { const t = setTimeout(() => setQ(text.trim()), 300); return () => clearTimeout(t); }, [text]);

  const cq = useQuery({
    queryKey: ['fiscal', orgId, 'candidates', doc?.id, q],
    queryFn: () => get<Candidates>(`/api/fiscal/documents/${doc!.id}/candidates${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    enabled: !!doc,
    placeholderData: (p) => p,
  });
  const items = cq.data?.items ?? [];
  const noteLine = cq.data?.noteLine ?? '';
  const canEdit = items[0]?.canEdit ?? [...picked.values()][0]?.canEdit ?? false;
  const notesOn = updateNotes && canEdit;

  const toggle = (c: FiscalCandidate) => setPicked((m) => {
    const n = new Map(m);
    if (n.has(c.id)) n.delete(c.id); else n.set(c.id, c);
    return n;
  });
  const chosen = [...picked.values()];
  const sum = useMemo(() => fromCents(chosen.reduce((s, c) => s + toCents(c.amount), 0)), [chosen]);

  async function submit() {
    if (!doc || !chosen.length) return;
    setSaving(true);
    try {
      await post(`/api/fiscal/documents/${doc.id}/link`, { billIds: chosen.map((c) => c.id), updateNotes: notesOn });
      toast.success(chosen.length > 1 ? `Nota vinculada a ${chosen.length} contas` : 'Nota vinculada à conta');
      onDone(); onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setSaving(false); }
  }

  const found = q ? [] : items.filter((c) => c.level === 'found');
  const maybe = q ? [] : items.filter((c) => c.level === 'maybe');
  const v = doc?.details?.vehicle;
  const firstDue = doc?.duplicates[0]?.dueDate;

  return (
    <Dialog open={!!doc} onClose={onClose} size="xl" title="Vincular a uma conta já lançada"
      description={doc ? `${doc.emitterName ?? 'Fornecedor'} · NF ${doc.number ?? '—'} · ${doc.total ? formatBRL(doc.total) : ''}${firstDue ? ` · vence ${formatDateBR(firstDue)}` : ''}${doc.duplicates.length > 1 ? ` (${doc.duplicates.length} duplicatas)` : ''}` : undefined}
      footer={<>
        {chosen.length > 0 && <span className="mr-auto text-sm text-muted">{plural(chosen.length, 'conta marcada', 'contas marcadas')} · {formatBRL(sum)}{doc?.total ? ` · nota ${formatBRL(doc.total)}` : ''}</span>}
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button variant="primary" icon={<Link2 className="size-4" />} loading={saving} disabled={!chosen.length} onClick={submit}>
          {chosen.length > 1 ? `Vincular ${chosen.length} contas` : 'Vincular'}
        </Button>
      </>}>
      {doc && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted">
            Marque a conta (ou as parcelas) que é desta nota. Nada é vinculado sozinho; a conta não muda de valor nem de vencimento.
            {v && <> Veículo da nota: <span className="inline-flex items-center gap-1 font-medium text-accent"><Car className="size-3.5" />{v.plate}{v.model ? ` · ${v.model}` : ''}</span>.</>}
          </p>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
            <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Buscar outra conta: descrição, pessoa ou observação" className="pl-9" aria-label="Buscar outra conta" />
          </div>

          {cq.isLoading ? <div className="grid place-items-center py-10"><Spinner /></div> : q ? (
            <Section title={`Resultado da busca${items.length ? ` (${items.length})` : ''}`} items={items} picked={picked} onToggle={toggle}
              empty="Nenhuma conta a pagar com esse texto." />
          ) : !found.length && !maybe.length ? (
            <Empty icon={<Link2 className="size-5" />} title="Nenhuma conta parecida com esta nota">
              Nenhuma conta com vencimento perto desta nota casa com o valor, o nome, a placa ou o número da NF. Busque acima pelo nome que vocês usam para este fornecedor, ou lance a conta pela nota.
            </Empty>
          ) : (
            <>
              {found.length > 0 && <Section key={`f${doc.id}`} title="Encontradas" hint="casam com a nota" items={found} picked={picked} onToggle={toggle} max={6} />}
              {maybe.length > 0 && <Section key={`m${doc.id}`} title="Podem ser" hint="casam só em parte: confira antes de marcar" items={maybe} picked={picked} onToggle={toggle} max={found.length ? 3 : 6} />}
            </>
          )}

          {chosen.length > 0 && (
            <div className="flex flex-col gap-3 rounded-xl border border-line p-3">
              <Switch checked={notesOn} onChange={setUpdateNotes} disabled={!canEdit}
                label="Acrescentar a nota nas observações da conta"
                hint={canEdit ? 'Assim a busca em Contas a pagar encontra a conta pelo número ou pela chave da nota.' : 'Você não tem permissão para editar contas a pagar: a nota será vinculada sem mexer nas observações.'} />
              {notesOn && chosen.map((c) => <NotesPreview key={c.id} c={c} line={noteLine} noteKey={doc.key} />)}
            </div>
          )}
        </div>
      )}
    </Dialog>
  );
}

function Section({ title, hint, items, picked, onToggle, empty, max }: {
  title: string; hint?: string; items: FiscalCandidate[]; picked: Map<string, FiscalCandidate>; onToggle: (c: FiscalCandidate) => void; empty?: string; max?: number;
}) {
  const [all, setAll] = useState(false);
  // as marcadas continuam à vista mesmo recolhida
  const shown = !max || all || items.length <= max ? items : items.filter((c, i) => i < max || picked.has(c.id));
  return (
    <div className="flex flex-col gap-2">
      <div className="text-sm font-medium">{title}{hint && <span className="ml-2 text-xs font-normal text-faint">{hint}</span>}</div>
      {!items.length ? <p className="text-sm text-muted">{empty}</p> : (
        <div className="flex flex-col gap-1.5">
          {shown.map((c) => <CandidateRow key={c.id} c={c} on={picked.has(c.id)} onToggle={onToggle} />)}
          {shown.length < items.length && (
            <button type="button" className="self-start text-sm font-medium text-accent hover:underline" onClick={() => setAll(true)}>Ver mais {items.length - shown.length}</button>
          )}
        </div>
      )}
    </div>
  );
}

function CandidateRow({ c, on, onToggle }: { c: FiscalCandidate; on: boolean; onToggle: (c: FiscalCandidate) => void }) {
  const othersSum = c.otherNotes.reduce((s, o) => s + (o.total ? toCents(o.total) : 0), 0);
  return (
    <button type="button" disabled={c.linked} onClick={() => onToggle(c)} aria-pressed={on}
      className={cn('flex w-full items-start gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors',
        on ? 'border-accent bg-accent-soft/60' : 'border-line hover:bg-surface-2/60', c.linked && 'cursor-default opacity-60 hover:bg-transparent')}>
      <span className={cn('mt-0.5 grid size-5 shrink-0 place-items-center rounded-md border', on || c.linked ? 'border-accent bg-accent text-white' : 'border-line-strong')}>
        {(on || c.linked) && <Check className="size-3.5" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className="min-w-0 flex-1 font-medium leading-snug">{c.description}{c.installment && <span className="ml-1.5 text-xs font-normal text-muted">{c.installment}</span>}</span>
          <span className="whitespace-nowrap font-semibold tabular-nums">{formatBRL(c.amount)}</span>
        </span>
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span className="tabular-nums">vence {formatDateBR(c.dueDate)}</span>
          <span className={cn('rounded-full px-1.5 py-0.5', c.status === 'paid' ? 'bg-ok/15 text-ok' : 'bg-surface-2')}>{c.status === 'paid' ? 'Paga' : 'Pendente'}</span>
          {c.categoryLabel && <span>· {c.categoryLabel}</span>}
          {c.reasons.map((r) => <span key={r} className="rounded-full bg-accent-soft px-1.5 py-0.5 text-accent">{MATCH_REASON_LABELS[r]}</span>)}
          {c.linked && <span className="font-medium text-accent">Já vinculada a esta nota</span>}
        </span>
        {c.otherNotes.length > 0 && (
          <span className="text-xs text-faint">
            Já tem {plural(c.otherNotes.length, 'nota', 'notas')}: {c.otherNotes.map((o) => `NF ${o.number ?? '—'}`).join(', ')} · {formatBRL(fromCents(othersSum))} de {formatBRL(c.amount)}
          </span>
        )}
      </span>
    </button>
  );
}

/** Observações da conta hoje e como ficam depois de vincular. */
function NotesPreview({ c, line, noteKey }: { c: FiscalCandidate; line: string; noteKey: string }) {
  const after = notesAfterLink(c.notes, line, noteKey);
  const same = after === (c.notes ?? '').trimEnd();
  const added = same ? '' : after.slice((c.notes ?? '').trimEnd().length).replace(/^\n/, '');
  const before = (c.notes ?? '').trimEnd();
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <div className="truncate font-medium">{c.description}</div>
      {same ? <p className="text-xs text-muted">As observações já citam esta nota: nada muda.</p> : (
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="min-w-0 rounded-lg bg-surface-2/60 px-3 py-2">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-faint">Hoje</div>
            <div className="whitespace-pre-wrap break-words text-muted">{before || <span className="italic text-faint">sem observações</span>}</div>
          </div>
          <div className="min-w-0 rounded-lg bg-surface-2/60 px-3 py-2">
            <div className="mb-1 text-[11px] font-medium uppercase tracking-wide text-faint">Depois de vincular</div>
            <div className="whitespace-pre-wrap break-words text-muted">{before && <>{before}{'\n'}</>}<span className="rounded bg-accent-soft px-0.5 font-medium text-accent">{added}</span></div>
          </div>
        </div>
      )}
    </div>
  );
}
