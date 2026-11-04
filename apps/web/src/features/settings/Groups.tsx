import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { ALL_PERMISSIONS, DEFAULT_OPERATOR_PERMISSIONS, DEFAULT_READONLY_PERMISSIONS, PERMISSIONS, permissionRequires, withRequired, type Permission } from '@nopaper/shared';
import { Button, Card, Checkbox, Field, IconButton, Input, Switch, Tooltip } from '@/components/ui/base';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { del, get, post, put, errMsg } from '@/lib/api';
import { useCan, useOrg, useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

export interface Group { id: string; name: string; description: string | null; isAdmin: boolean; permissions: Permission[]; members: number }

type Def = { group: string; label: string; hint?: string; requires?: readonly string[] };
const byGroup = Object.entries(PERMISSIONS as Record<Permission, Def>).reduce<Record<string, Array<[Permission, Def]>>>((acc, [k, v]) => {
  (acc[v.group] ??= []).push([k as Permission, v]);
  return acc;
}, {});
/** Quem depende de `p` (desmarcar "ver" desmarca "editar", etc.). */
const dependents = (p: Permission) => ALL_PERMISSIONS.filter((x) => permissionRequires(x).includes(p));

const PRESETS: Array<{ label: string; perms: Permission[] }> = [
  { label: 'Somente leitura', perms: DEFAULT_READONLY_PERMISSIONS },
  { label: 'Operador', perms: DEFAULT_OPERATOR_PERMISSIONS },
];

export function useGroups() {
  const orgId = useSession((s) => s.orgId);
  return useQuery({ queryKey: ['groups', orgId], queryFn: () => get<{ items: Group[] }>('/api/groups').then((r) => r.items) });
}

function GroupForm({ group, onClose }: { group: Partial<Group>; onClose: () => void }) {
  const qc = useQueryClient();
  const org = useOrg();
  const can = useCan();
  const iAmAdmin = !!org?.isAdmin;
  const [f, setF] = useState({ name: group.name ?? '', description: group.description ?? '', isAdmin: group.isAdmin ?? false, permissions: new Set(group.permissions ?? []) });
  const [busy, setBusy] = useState(false);
  // quem não é admin só concede o que já tem (o que o grupo já tinha pode ficar)
  const grantable = (p: Permission) => iAmAdmin || can(p) || !!group.permissions?.includes(p);
  const set = (next: Set<Permission>) => setF((cur) => ({ ...cur, permissions: next }));
  const toggle = (p: Permission, v: boolean) => {
    const s = new Set(f.permissions);
    if (v) { s.add(p); for (const r of withRequired([p])) if (grantable(r)) s.add(r); }
    else { s.delete(p); for (const d of dependents(p)) s.delete(d); }
    set(s);
  };
  const toggleSection = (perms: Permission[], v: boolean) => {
    const s = new Set(f.permissions);
    for (const p of perms) if (grantable(p)) { if (v) s.add(p); else s.delete(p); }
    set(new Set(withRequired(s).filter((p) => s.has(p) || grantable(p))));
  };
  const save = async () => {
    setBusy(true);
    const body = { ...f, permissions: [...f.permissions] };
    try { if (group.id) await put(`/api/groups/${group.id}`, body); else await post('/api/groups', body); qc.invalidateQueries({ queryKey: ['groups'] }); toast.success('Grupo salvo'); onClose(); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const count = f.permissions.size;
  return (
    <Dialog open onClose={onClose} size="xl" title={group.id ? `Editar grupo ${group.name}` : 'Novo grupo'}
      description="Marque o que as pessoas deste grupo podem fazer neste espaço. Quem está em vários grupos recebe a soma."
      footer={<>
        {!f.isAdmin && <span className="mr-auto text-xs text-muted">{count} de {ALL_PERMISSIONS.length} permissões</span>}
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button variant="primary" loading={busy} disabled={!f.name.trim()} onClick={save}>Salvar grupo</Button>
      </>}>
      <div className="flex flex-col gap-5">
        <div className="grid sm:grid-cols-2 gap-4">
          <Field label="Nome"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus /></Field>
          <Field label="Descrição"><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="Ex.: lança e paga as contas da loja" /></Field>
        </div>
        <div className={cn(!iAmAdmin && 'opacity-60')}>
          <Switch checked={f.isAdmin} disabled={!iAmAdmin} onChange={(isAdmin) => setF({ ...f, isAdmin })} label="Administrador do espaço"
            hint={iAmAdmin ? 'Acesso total a este espaço, incluindo categorias restritas, membros e grupos.' : 'Só um administrador do espaço pode criar grupos de administradores.'} />
        </div>
        {!f.isAdmin && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-muted">Começar de um modelo:</span>
              {PRESETS.map((p) => (
                <button key={p.label} type="button" onClick={() => set(new Set(p.perms.filter(grantable)))} className="rounded-md border border-line px-2 py-1 font-medium text-muted hover:border-accent hover:text-accent transition-colors">{p.label}</button>
              ))}
              <button type="button" onClick={() => set(new Set())} className="rounded-md px-2 py-1 font-medium text-faint hover:text-danger">Limpar tudo</button>
            </div>
            <div className="grid gap-4 md:grid-cols-2">
              {Object.entries(byGroup).map(([g, perms]) => {
                const keys = perms.map(([p]) => p);
                const on = keys.filter((p) => f.permissions.has(p)).length;
                return (
                  <section key={g} className="rounded-xl border border-line p-3.5">
                    <div className="mb-2.5 flex items-center gap-2">
                      <Checkbox checked={on === keys.length} indeterminate={on > 0 && on < keys.length} disabled={!keys.some(grantable)} onChange={(v) => toggleSection(keys, v)}
                        label={<span className="text-[13px] font-semibold">{g}</span>} />
                      <span className="ml-auto text-[11px] text-faint tnum">{on}/{keys.length}</span>
                    </div>
                    <div className="flex flex-col gap-2.5 pl-1">
                      {perms.map(([p, d]) => {
                        const locked = !grantable(p);
                        return (
                          <Tooltip key={p} content={locked ? 'Você não tem esta permissão, então não pode concedê-la.' : null} side="left">
                            <div className={cn(locked && 'opacity-50')}>
                              <Checkbox checked={f.permissions.has(p)} disabled={locked} onChange={(v) => toggle(p, v)}
                                label={<span className="flex flex-col"><span className="text-sm text-ink">{d.label}</span>{d.hint && <span className="text-xs text-faint leading-snug">{d.hint}</span>}</span>} />
                            </div>
                          </Tooltip>
                        );
                      })}
                    </div>
                  </section>
                );
              })}
            </div>
            <p className="text-xs text-faint">Criar espaços novos não é uma permissão do espaço: fica na conta da pessoa, em Plataforma → Usuários.</p>
          </>
        )}
      </div>
    </Dialog>
  );
}

export function GroupsPage() {
  const { data = [] } = useGroups();
  const [editing, setEditing] = useState<Partial<Group> | null>(null);
  const confirm = useConfirm();
  const qc = useQueryClient();
  const remove = async (g: Group) => {
    if (!(await confirm({ title: `Apagar o grupo "${g.name}"?`, body: g.members ? `${g.members} membro(s) perderão as permissões deste grupo.` : undefined, confirmLabel: 'Apagar', tone: 'danger' }))) return;
    try { await del(`/api/groups/${g.id}`); qc.invalidateQueries({ queryKey: ['groups'] }); } catch (e) { toast.error(errMsg(e)); }
  };
  return (
    <Card>
      <div className="flex items-center justify-between gap-4 border-b border-line p-5">
        <div><h2 className="font-display text-lg font-semibold">Grupos e permissões</h2><p className="text-sm text-muted">Cada membro recebe a soma das permissões dos seus grupos.</p></div>
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({})}>Novo grupo</Button>
      </div>
      <ul className="divide-y divide-line">
        {data.map((g) => (
          <li key={g.id} className="flex items-center gap-4 px-5 py-4">
            <span className="grid size-9 place-items-center rounded-lg bg-accent-soft text-accent"><ShieldCheck className="size-4" /></span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">{g.name}</p>
              <p className="text-xs text-faint">{g.isAdmin ? 'Acesso total' : `${g.permissions.length} permissões`} · {g.members} membro(s){g.description && ` · ${g.description}`}</p>
              {!g.isAdmin && g.permissions.length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {Object.entries(byGroup).map(([sec, perms]) => {
                    const n = perms.filter(([p]) => g.permissions.includes(p)).length;
                    return n ? <span key={sec} className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">{sec} {n === perms.length ? '· tudo' : `${n}/${perms.length}`}</span> : null;
                  })}
                </div>
              )}
            </div>
            <IconButton label="Editar" onClick={() => setEditing(g)}><Pencil className="size-4" /></IconButton>
            <IconButton label="Apagar" tone="danger" onClick={() => remove(g)}><Trash2 className="size-4" /></IconButton>
          </li>
        ))}
      </ul>
      {editing && <GroupForm group={editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}
