import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil, Plus, Sparkles, Trash2 } from 'lucide-react';
import { type ColorKey } from '@nopaper/shared';
import { Dialog, SaveFooter, useFormState } from '@/components/ui/dialog';
import { Button, Field, IconButton, Input, Select, Spinner } from '@/components/ui/base';
import { ColorChip } from '@/components/ui/chips';
import { del, post, put, errMsg } from '@/lib/api';
import { useCardCategories } from '@/lib/queries';
import { plural } from '@/lib/utils';
import type { CardCategory } from '@/lib/types';
import { ColorPicker } from '@/features/bills/Catalog';

function CardCategoryForm({ initial, onClose, onSaved }: { initial: Partial<CardCategory> | null; onClose: () => void; onSaved: (c: CardCategory) => void }) {
  const qc = useQueryClient();
  const [f, setF, form] = useFormState({ label: initial?.label ?? '', color: (initial?.color ?? 'slate') as ColorKey });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const c = initial?.id ? await put<CardCategory>(`/api/card-categories/${initial.id}`, f) : await post<CardCategory>('/api/card-categories', f);
      qc.invalidateQueries({ queryKey: ['bills'] });
      toast.success(initial?.id ? 'Categoria salva' : 'Categoria criada');
      form.markSaved(f); onSaved({ ...initial, ...c } as CardCategory);
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} dirty={form.dirty} size="sm" title={initial?.id ? 'Editar categoria do cartão' : 'Nova categoria do cartão'}
      footer={<SaveFooter dirty={form.dirty} isNew={!initial?.id} saving={busy} canSave={!!f.label.trim()} onSave={save} onClose={onClose} />}>
      <div className="flex flex-col gap-4">
        <Field label="Nome"><Input autoFocus value={f.label} maxLength={64} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Ex.: Pet, Presentes, Viagem de férias" /></Field>
        <Field label="Cor"><ColorPicker value={f.color} onChange={(color) => setF({ ...f, color })} /></Field>
        <div className="flex items-center gap-2 text-sm text-muted">Prévia: <ColorChip color={f.color}>{f.label || 'Categoria'}</ColorChip></div>
        {initial?.ruleKey && <p className="flex items-start gap-2 text-xs text-faint"><Sparkles className="mt-0.5 size-3.5 shrink-0 text-accent" />Recebe sozinha as compras reconhecidas pelo nome da loja. Mudar o nome não muda isso.</p>}
      </div>
    </Dialog>
  );
}

function DeleteCardCategory({ cat, all, onClose }: { cat: CardCategory; all: CardCategory[]; onClose: () => void }) {
  const qc = useQueryClient();
  const others = all.filter((c) => c.id !== cat.id);
  const [moveTo, setMoveTo] = useState(others.find((c) => c.ruleKey === 'other')?.id ?? others[0]?.id ?? '');
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true);
    try {
      await del(`/api/card-categories/${cat.id}${cat.usage ? `?moveTo=${moveTo}` : ''}`);
      qc.invalidateQueries({ queryKey: ['bills'] });
      toast.success(`Categoria "${cat.label}" apagada`);
      onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} size="sm" title={`Apagar "${cat.label}"?`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="danger" loading={busy} disabled={!!cat.usage && !moveTo} onClick={run}>Apagar</Button></>}>
      {cat.usage ? (
        <div className="flex flex-col gap-3 text-sm">
          <p className="text-muted">Esta categoria tem {plural(cat.usage, 'compra', 'compras')}. Elas vão para:</p>
          <Select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>{others.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}</Select>
          {cat.ruleKey && <p className="text-xs text-faint">As compras que o NoPaper reconhecia como “{cat.label}” passam a ir para a categoria escolhida.</p>}
        </div>
      ) : <p className="text-sm text-muted">A categoria não tem compras e será removida.</p>}
    </Dialog>
  );
}

/** Categorias do cartão: detalham as compras das faturas (a fatura em si fica em Contas a pagar com a categoria do cartão). */
export function CardCategoryManager({ open, onClose, canManage }: { open: boolean; onClose: () => void; canManage: boolean }) {
  const q = useCardCategories(open);
  const [editing, setEditing] = useState<Partial<CardCategory> | null | false>(false);
  const [deleting, setDeleting] = useState<CardCategory | null>(null);
  useEffect(() => { if (!open) { setEditing(false); setDeleting(null); } }, [open]);
  const data = q.data ?? [];
  return (
    <>
      <Dialog open={open} onClose={onClose} size="md" title="Categorias do cartão"
        description="Detalham o que foi comprado em cada fatura. São só do cartão: em Contas a pagar a fatura inteira continua com a categoria escolhida no cadastro do cartão."
        footer={<>{<Button variant="ghost" className="mr-auto" onClick={onClose}>Fechar</Button>}{canManage && <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({})}>Nova categoria</Button>}</>}>
        {q.isLoading ? <div className="grid place-items-center py-10"><Spinner /></div> : (
          <ul className="-mx-1 divide-y divide-line">
            {data.map((c) => (
              <li key={c.id} className="flex items-center gap-3 px-1 py-2.5">
                <ColorChip color={c.color}>{c.label}</ColorChip>
                <span className="min-w-0 truncate text-xs text-faint">{plural(c.usage, 'compra', 'compras')}{c.ruleKey && ' · automática'}</span>
                {canManage && (
                  <span className="ml-auto flex shrink-0 gap-1">
                    <IconButton label="Editar" onClick={() => setEditing(c)}><Pencil className="size-4" /></IconButton>
                    <IconButton label="Apagar" tone="danger" disabled={data.length <= 1} onClick={() => setDeleting(c)}><Trash2 className="size-4" /></IconButton>
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
      </Dialog>
      {editing !== false && <CardCategoryForm initial={editing} onClose={() => setEditing(false)} onSaved={setEditing} />}
      {deleting && <DeleteCardCategory cat={deleting} all={data} onClose={() => setDeleting(null)} />}
    </>
  );
}
