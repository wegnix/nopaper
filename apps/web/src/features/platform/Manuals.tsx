import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BookOpen, Eye, FileUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { MANUAL_AUDIENCES, MANUAL_MAX_MB, manualAudienceLabel, type ManualAdminInfo, type ManualAudience } from '@nopaper/shared';
import { Button, Card, Empty, Field, Input, PageHeader, Spinner, Textarea } from '@/components/ui/base';
import { Dialog, SaveFooter, useConfirm, useFormState } from '@/components/ui/dialog';
import { api, get, errMsg, uploadFormWithProgress } from '@/lib/api';
import { cn } from '@/lib/utils';
import { FileViewer, type FileViewerTarget } from '@/features/bills/FileViewer';
import { sizeText, when } from '@/features/accounting/common';

/**
 * Plataforma → Manuais: os PDFs que as pessoas abrem pelo "?" do cabeçalho. Cada manual diz para quem
 * aparece; trocar o PDF não muda o resto.
 */
export function ManualsPage() {
  const qc = useQueryClient();
  const list = useQuery({ queryKey: ['system', 'manuals'], queryFn: () => get<{ items: ManualAdminInfo[] }>('/api/system/manuals').then((r) => r.items) });
  const confirm = useConfirm();
  const [editing, setEditing] = useState<ManualAdminInfo | 'new' | null>(null);
  const [viewer, setViewer] = useState<FileViewerTarget | null>(null);
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['system', 'manuals'] }); void qc.invalidateQueries({ queryKey: ['manuals'] }); };
  const remove = async (m: ManualAdminInfo) => {
    if (!(await confirm({ title: `Apagar o manual “${m.title}”?`, tone: 'danger', confirmLabel: 'Apagar', body: 'O manual deixa de aparecer no “?” para todos e o arquivo é apagado.' }))) return;
    try { await api('DELETE', `/api/system/manuals/${m.id}`); refresh(); toast.success('Manual apagado'); } catch (e) { toast.error(errMsg(e)); }
  };
  const items = list.data ?? [];
  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <PageHeader title="Manuais" description="PDFs de ajuda que cada pessoa abre pelo “?” no alto da tela. Você escolhe para quem cada manual aparece."
        actions={<Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Novo manual</Button>} />
      <Card className="overflow-hidden">
        {list.isLoading ? <div className="grid place-items-center py-16"><Spinner /></div> : !items.length ? (
          <Empty icon={<BookOpen className="size-5" />} title="Nenhum manual publicado" action={<Button variant="secondary" icon={<Plus className="size-4" />} onClick={() => setEditing('new')}>Publicar o primeiro</Button>}>
            Enquanto não houver manual para uma pessoa, o “?” não aparece para ela.
          </Empty>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((m) => (
              <li key={m.id} className="flex flex-col gap-3 p-3 sm:p-4 md:px-5 lg:flex-row lg:items-center">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent"><BookOpen className="size-5" /></span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{m.title}</p>
                    {m.description && <p className="mt-0.5 text-sm text-muted">{m.description}</p>}
                    <p className="mt-1.5 flex flex-wrap gap-1.5 text-xs">{m.audiences.map((a) => <span key={a} className="rounded-md bg-surface-2 px-2 py-0.5">{manualAudienceLabel(a)}</span>)}</p>
                    <p className="mt-1.5 truncate text-xs text-faint">{m.originalName} · {sizeText(m.size)} · atualizado em {when(m.updatedAt)}{m.updatedByName ? ` por ${m.updatedByName}` : ''}</p>
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2 max-lg:pl-[52px]">
                  <Button size="sm" variant="ghost" icon={<Eye className="size-4" />} onClick={() => setViewer({ urlPath: `/api/manuals/${m.id}/url`, label: 'Manual', title: m.title })}>Ver</Button>
                  <Button size="sm" variant="secondary" icon={<Pencil className="size-4" />} onClick={() => setEditing(m)}>Editar</Button>
                  <Button size="sm" variant="ghost" className="text-danger" icon={<Trash2 className="size-4" />} onClick={() => remove(m)}>Apagar</Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {editing && <ManualDialog key={editing === 'new' ? 'new' : editing.id} manual={editing === 'new' ? null : editing} onClose={() => setEditing(null)} onSaved={refresh} />}
      <FileViewer target={viewer} onClose={() => setViewer(null)} />
    </div>
  );
}

function ManualDialog({ manual, onClose, onSaved }: { manual: ManualAdminInfo | null; onClose: () => void; onSaved: () => void }) {
  /** Depois de criar, a janela passa a editar o manual criado. */
  const [id, setId] = useState(manual?.id ?? null);
  const [current, setCurrent] = useState(manual ? { name: manual.originalName, size: manual.size } : null);
  const [f, setF, form] = useFormState({ title: manual?.title ?? '', description: manual?.description ?? '', audiences: (manual?.audiences ?? []) as ManualAudience[] });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const pick = (x: File | null | undefined) => {
    if (!x) return;
    if (x.type !== 'application/pdf' && !/\.pdf$/i.test(x.name)) return void toast.warning('O manual precisa ser um arquivo PDF.');
    if (x.size > MANUAL_MAX_MB * 1024 * 1024) return void toast.warning(`O arquivo é maior que ${MANUAL_MAX_MB} MB. Exporte o PDF com imagens mais leves.`);
    setFile(x);
  };
  const toggle = (k: ManualAudience) => setF((p) => ({ ...p, audiences: p.audiences.includes(k) ? p.audiences.filter((a) => a !== k) : [...p.audiences, k] }));
  const dirty = form.dirty || !!file;
  const canSave = f.title.trim().length >= 2 && f.audiences.length > 0 && (!!id || !!file);
  const save = async () => {
    setBusy(true); setPct(0);
    const build = () => { const fd = new FormData(); fd.append('title', f.title); fd.append('description', f.description); fd.append('audiences', JSON.stringify(f.audiences)); if (file) fd.append('file', file); return fd; };
    try {
      if (id) await api('PUT', `/api/system/manuals/${id}`, build());
      else setId((await uploadFormWithProgress<{ id: string }>('/api/system/manuals', build, setPct)).id);
      if (file) { setCurrent({ name: file.name, size: file.size }); setFile(null); }
      form.markSaved(f);
      onSaved();
      toast.success(id ? 'Manual salvo' : 'Manual publicado');
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} dirty={dirty} size="lg" title={id ? 'Editar manual' : 'Novo manual'} description="O manual aparece no “?” do alto da tela para as pessoas que você marcar."
      footer={<SaveFooter dirty={dirty} isNew={!id} saving={busy} canSave={canSave} saveLabel={id ? 'Salvar' : 'Publicar manual'} onSave={save} onClose={onClose} />}>
      <div className="flex flex-col gap-5">
        <Field label="Título" required hint="Como aparece para as pessoas. Ex.: Manual do contador."><Input maxLength={120} value={f.title} onChange={(e) => setF((p) => ({ ...p, title: e.target.value }))} /></Field>
        <Field label="Descrição (opcional)" hint="Uma linha que ajuda a escolher quando há mais de um manual."><Textarea rows={2} maxLength={300} value={f.description} onChange={(e) => setF((p) => ({ ...p, description: e.target.value }))} /></Field>
        <div>
          <p className="mb-2 text-[13px] font-medium text-muted">Para quem aparece</p>
          <div className="grid gap-2 sm:grid-cols-2">
            {MANUAL_AUDIENCES.map((a) => {
              const on = f.audiences.includes(a.key);
              return (
                <label key={a.key} className={cn('flex cursor-pointer items-start gap-2.5 rounded-xl border p-3 transition', on ? 'border-accent bg-accent-soft/50' : 'border-line hover:border-line-strong')}>
                  <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-accent)]" checked={on} onChange={() => toggle(a.key)} />
                  <span className="min-w-0"><span className="block text-sm font-medium leading-tight">{a.label}</span><span className="mt-0.5 block text-xs leading-snug text-faint">{a.hint}</span></span>
                </label>
              );
            })}
          </div>
        </div>
        <div>
          <p className="mb-2 text-[13px] font-medium text-muted">Arquivo (PDF, até {MANUAL_MAX_MB} MB)</p>
          <input ref={inputRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ''; }} />
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-line p-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-surface-2 text-muted"><BookOpen className="size-5" /></span>
            <span className="min-w-0 flex-1">
              {file ? <><span className="block break-words text-sm font-medium">{file.name}</span><span className="block text-xs text-warn">{sizeText(file.size)} · {id ? 'substitui o atual ao salvar' : 'será enviado ao publicar'}</span></>
                : current ? <><span className="block break-words text-sm font-medium">{current.name}</span><span className="block text-xs text-muted">{sizeText(current.size)} · arquivo atual</span></>
                  : <span className="text-sm text-muted">Nenhum arquivo escolhido.</span>}
            </span>
            <Button size="sm" variant="secondary" icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>{current || file ? 'Trocar PDF' : 'Escolher PDF'}</Button>
          </div>
          {busy && !id && <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} /></div>}
        </div>
      </div>
    </Dialog>
  );
}
