import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Folder, Lock, Pencil, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { COLOR_KEYS, COLOR_PRESETS, type ColorKey } from '@nopaper/shared';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { Button, Checkbox, Field, IconButton, Input, Segmented } from '@/components/ui/base';
import { ColorChip } from '@/components/ui/chips';
import { del, post, put, errMsg } from '@/lib/api';
import { useCategories, useFolders } from '@/lib/queries';
import { useCan } from '@/lib/session';
import { cn } from '@/lib/utils';
import type { Category, Folder as FolderT } from '@/lib/types';

/** `keys`/`presets`: troca a paleta (cartões usam a de categorias + preto). */
export function ColorPicker<K extends string = ColorKey>({ value, onChange, keys = COLOR_KEYS as readonly string[] as readonly K[], presets = COLOR_PRESETS as Record<string, { label: string; base: string }> }: {
  value: string; onChange: (c: K) => void; keys?: readonly K[]; presets?: Record<string, { label: string; base: string }>;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {keys.map((k) => (
        <button
          key={k} type="button" title={presets[k].label} aria-label={presets[k].label} onClick={() => onChange(k)}
          style={{ background: presets[k].base }}
          className={cn('size-7 rounded-full transition-transform hover:scale-110 ring-offset-2 ring-offset-surface', value === k && 'ring-2 ring-ink scale-110')}
        />
      ))}
    </div>
  );
}

function CategoryForm({ initial, onClose }: { initial: Partial<Category> | null; onClose: () => void }) {
  const can = useCan();
  const qc = useQueryClient();
  const [f, setF] = useState({ label: initial?.label ?? '', color: (initial?.color ?? 'slate') as ColorKey, kind: initial?.kind ?? 'both', isRestricted: initial?.isRestricted ?? false });
  const save = useMutation({
    mutationFn: () => (initial?.id ? put(`/api/categories/${initial.id}`, f) : post('/api/categories', f)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['categories'] }); toast.success(initial?.id ? 'Categoria atualizada' : 'Categoria criada'); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Dialog open onClose={onClose} title={initial?.id ? 'Editar categoria' : 'Nova categoria'} size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={save.isPending} disabled={!f.label.trim()} onClick={() => save.mutate()}>Salvar</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Nome"><Input autoFocus value={f.label} maxLength={64} onChange={(e) => setF({ ...f, label: e.target.value })} placeholder="Ex.: Retiradas dos sócios" /></Field>
        <Field label="Usada em">
          <Segmented value={f.kind} onChange={(kind) => setF({ ...f, kind })} options={[{ value: 'payable', label: 'A pagar' }, { value: 'receivable', label: 'A receber' }, { value: 'both', label: 'Ambas' }]} />
        </Field>
        <Field label="Cor"><ColorPicker value={f.color} onChange={(color) => setF({ ...f, color })} /></Field>
        <div className="flex items-center gap-2 text-sm text-muted">Prévia: <ColorChip color={f.color}>{f.label || 'Categoria'}</ColorChip></div>
        {can('bills.view_restricted') && (
          <Checkbox
            checked={f.isRestricted} onChange={(isRestricted) => setF({ ...f, isRestricted })}
            disabled={!!initial?.id && !!initial.usage && !initial.isRestricted}
            label={<span><span className="font-medium inline-flex items-center gap-1"><Lock className="size-3.5" /> Categoria restrita</span><span className="block text-xs text-faint mt-0.5">Contas desta categoria ficam ocultas para quem não tem a permissão "Ver contas de categorias restritas" — na lista, nos totais, nos lembretes e no ZIP. Só pode ser marcada em categorias ainda sem contas.</span></span>}
          />
        )}
      </div>
    </Dialog>
  );
}

export function CategoryManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data = [] } = useCategories();
  const [editing, setEditing] = useState<Partial<Category> | null | false>(false);
  const confirm = useConfirm();
  const qc = useQueryClient();
  const remove = async (c: Category) => {
    if (!(await confirm({ title: `Apagar "${c.label}"?`, body: c.usage ? `Esta categoria tem ${c.usage} conta(s) e não pode ser apagada. Mova as contas antes.` : 'A categoria será removida.', confirmLabel: 'Apagar', tone: 'danger' }))) return;
    try { await del(`/api/categories/${c.id}`); qc.invalidateQueries({ queryKey: ['categories'] }); toast.success('Categoria apagada'); } catch (e) { toast.error(errMsg(e)); }
  };
  const kindLabel = { payable: 'a pagar', receivable: 'a receber', both: 'ambas' };
  return (
    <>
      <Dialog open={open} onClose={onClose} title="Categorias" description="Organizam as contas nos filtros, totais e relatórios." size="md"
        footer={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({})}>Nova categoria</Button>}>
        <ul className="divide-y divide-line -mx-1">
          {data.map((c) => (
            <li key={c.id} className="flex items-center gap-3 px-1 py-2.5">
              <ColorChip color={c.color} icon={c.isRestricted ? <Lock className="size-3" /> : undefined}>{c.label}</ColorChip>
              <span className="text-xs text-faint">{kindLabel[c.kind]} · {c.usage} conta(s)</span>
              <span className="ml-auto flex gap-1">
                <IconButton label="Editar" onClick={() => setEditing(c)}><Pencil className="size-4" /></IconButton>
                <IconButton label="Apagar" tone="danger" onClick={() => remove(c)}><Trash2 className="size-4" /></IconButton>
              </span>
            </li>
          ))}
        </ul>
      </Dialog>
      {editing !== false && <CategoryForm initial={editing} onClose={() => setEditing(false)} />}
    </>
  );
}

function FolderForm({ initial, onClose }: { initial: Partial<FolderT> | null; onClose: () => void }) {
  const qc = useQueryClient();
  const [f, setF] = useState({ label: initial?.label ?? '', name: initial?.name ?? '', color: (initial?.color ?? 'slate') as ColorKey });
  const save = useMutation({
    mutationFn: () => (initial?.id ? put(`/api/folders/${initial.id}`, f) : post('/api/folders', f)),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['folders'] }); toast.success(initial?.id ? 'Pasta atualizada' : 'Pasta criada'); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Dialog open onClose={onClose} title={initial?.id ? 'Editar pasta' : 'Nova pasta'} size="sm"
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={save.isPending} disabled={!f.label.trim() || !f.name.trim()} onClick={() => save.mutate()}>Salvar</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Rótulo" hint="Texto curto exibido na tabela (até 32 caracteres)."><Input autoFocus maxLength={32} value={f.label} onChange={(e) => setF({ ...f, label: e.target.value, name: f.name || '' })} placeholder="Ex.: Aluguel" /></Field>
        <Field label="Nome da pasta no ZIP" hint="Nome do diretório criado dentro de ANO/MÊS/ na exportação para a contabilidade. Não use / ou \."><Input maxLength={64} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Ex.: Aluguel da matriz" /></Field>
        <Field label="Cor"><ColorPicker value={f.color} onChange={(color) => setF({ ...f, color })} /></Field>
      </div>
    </Dialog>
  );
}

export function FolderManager({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { data = [] } = useFolders();
  const [editing, setEditing] = useState<Partial<FolderT> | null | false>(false);
  const confirm = useConfirm();
  const qc = useQueryClient();
  const remove = async (f: FolderT) => {
    if (!(await confirm({ title: `Apagar a pasta "${f.label}"?`, body: f.usage ? `As ${f.usage} conta(s) desta pasta ficarão sem pasta. Nenhuma conta é apagada.` : 'A pasta está vazia.', confirmLabel: 'Apagar pasta', tone: 'danger' }))) return;
    try { await del(`/api/folders/${f.id}`); qc.invalidateQueries({ queryKey: ['folders'] }); qc.invalidateQueries({ queryKey: ['bills'] }); toast.success('Pasta apagada'); } catch (e) { toast.error(errMsg(e)); }
  };
  return (
    <>
      <Dialog open={open} onClose={onClose} title="Pastas" description="Agrupam contas para filtrar e para montar o ZIP da contabilidade (ano / mês / pasta)." size="md"
        footer={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({})}>Nova pasta</Button>}>
        {!data.length && <p className="py-6 text-center text-sm text-muted">Nenhuma pasta ainda. Crie uma para organizar a exportação.</p>}
        <ul className="divide-y divide-line -mx-1">
          {data.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-1 py-2.5">
              <ColorChip color={f.color} icon={<Folder className="size-3" />}>{f.label}</ColorChip>
              <span className="text-xs text-faint truncate">{f.name} · {f.usage} conta(s)</span>
              <span className="ml-auto flex gap-1">
                <IconButton label="Editar" onClick={() => setEditing(f)}><Pencil className="size-4" /></IconButton>
                <IconButton label="Apagar" tone="danger" onClick={() => remove(f)}><Trash2 className="size-4" /></IconButton>
              </span>
            </li>
          ))}
        </ul>
      </Dialog>
      {editing !== false && <FolderForm initial={editing} onClose={() => setEditing(false)} />}
    </>
  );
}
