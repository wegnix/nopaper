import { usernameFromEmail } from '@nopaper/shared';
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Crown, Pencil, Trash2, UserPlus } from 'lucide-react';
import { Button, Card, Checkbox, Field, IconButton, Input, Switch } from '@/components/ui/base';
import { Dialog, SaveFooter, useConfirm, useFormState } from '@/components/ui/dialog';
import { del, get, post, put, errMsg } from '@/lib/api';
import { useCan, useOrg, useSession } from '@/lib/session';
import { cn } from '@/lib/utils';
import type { Permission } from '@nopaper/shared';
import { useGroups } from './Groups';

interface Member { id: string; userId: string; name: string; email: string; username: string; isOwner: boolean; active: boolean; lastLoginAt: string | null; groupIds: string[] }

function MemberForm({ member, onClose, onSaved }: { member: Partial<Member>; onClose: () => void; onSaved: (m: Partial<Member>) => void }) {
  const { data: groups = [] } = useGroups();
  const org = useOrg();
  const can = useCan();
  // quem não é admin do espaço só mexe em grupos cujas permissões já tem
  const assignable = (g: { isAdmin: boolean; permissions: Permission[] }) => !!org?.isAdmin || (!g.isAdmin && g.permissions.every(can));
  const qc = useQueryClient();
  const [f, setF, form] = useFormState({ email: member.email ?? '', name: member.name ?? '', username: '', password: '', groupIds: new Set(member.groupIds ?? []), active: member.active ?? true });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (member.id) await put(`/api/members/${member.id}`, { groupIds: [...f.groupIds], active: f.active });
      else {
        const r = await post<{ id: string }>('/api/members', { email: f.email, name: f.name || undefined, username: f.username || undefined, password: f.password || undefined, groupIds: [...f.groupIds] });
        onSaved({ ...member, id: r.id, email: f.email, name: f.name || f.email, groupIds: [...f.groupIds], active: true, isOwner: false });
      }
      qc.invalidateQueries({ queryKey: ['members'] }); qc.invalidateQueries({ queryKey: ['groups'] });
      toast.success(member.id ? 'Membro salvo' : 'Membro adicionado');
      form.markSaved({ ...f, password: '' }); if (!member.id) setF((p) => ({ ...p, password: '' }));
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} dirty={form.dirty} title={member.id ? member.name : 'Adicionar membro'} description={member.id ? member.email : 'Se a pessoa já tem conta no NoPaper, basta o e-mail. Senão, defina nome e senha inicial.'}
      footer={<SaveFooter dirty={form.dirty} isNew={!member.id} saving={busy} canSave={!!member.id || !!f.email.trim()} onSave={save} onClose={onClose} saveLabel={member.id ? 'Salvar' : 'Adicionar'} />}>
      <div className="flex flex-col gap-4">
        {!member.id && <>
          <Field label="E-mail"><Input type="email" autoFocus value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <div className="grid sm:grid-cols-2 gap-4">
            <Field label="Nome (se for conta nova)"><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
            <Field label="Usuário (se for conta nova)" hint="Vazio: gerado a partir do e-mail.">
              <Input value={f.username} maxLength={32} autoCapitalize="none" spellCheck={false} placeholder={f.email ? usernameFromEmail(f.email) : ''} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase().replace(/\s+/g, '') })} />
            </Field>
            <Field label="Senha inicial (se for conta nova)" hint="Mínimo 8 caracteres. É provisória: a pessoa cria a própria senha no primeiro acesso." className="sm:col-span-2"><Input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
          </div>
        </>}
        <div>
          <p className="mb-2 text-[13px] font-medium text-muted">Grupos</p>
          <div className="flex flex-col gap-2">
            {groups.map((g) => (
              <Checkbox key={g.id} checked={f.groupIds.has(g.id)} disabled={!assignable(g)} onChange={(v) => { const s = new Set(f.groupIds); if (v) s.add(g.id); else s.delete(g.id); setF({ ...f, groupIds: s }); }}
                label={<span className={cn(!assignable(g) && 'opacity-60')}>{g.name}<span className="ml-2 text-xs text-faint">{g.isAdmin ? 'acesso total' : `${g.permissions.length} permissões`}{!assignable(g) && ' · só um administrador pode mudar'}</span></span>} />
            ))}
          </div>
        </div>
        {member.id && !member.isOwner && <Switch checked={f.active} onChange={(active) => setF({ ...f, active })} label="Acesso ativo" hint="Desative para bloquear o acesso a este espaço sem remover o histórico." />}
      </div>
    </Dialog>
  );
}

export function MembersPage() {
  const orgId = useSession((s) => s.orgId);
  const me = useSession((s) => s.user);
  const q = useQuery({ queryKey: ['members', orgId], queryFn: () => get<{ items: Member[] }>('/api/members').then((r) => r.items) });
  const { data: groups = [] } = useGroups();
  const [editing, setEditing] = useState<Partial<Member> | null>(null);
  const confirm = useConfirm();
  const qc = useQueryClient();
  const groupName = (id: string) => groups.find((g) => g.id === id)?.name;
  const remove = async (m: Member) => {
    if (!(await confirm({ title: `Remover ${m.name}?`, body: 'A pessoa perde o acesso a este espaço. A conta dela no NoPaper continua existindo.', confirmLabel: 'Remover', tone: 'danger' }))) return;
    try { await del(`/api/members/${m.id}`); qc.invalidateQueries({ queryKey: ['members'] }); } catch (e) { toast.error(errMsg(e)); }
  };
  return (
    <Card>
      <div className="flex items-center justify-between gap-4 border-b border-line p-5">
        <div><h2 className="font-display text-lg font-semibold">Membros</h2><p className="text-sm text-muted">Quem tem acesso a este espaço.</p></div>
        <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setEditing({})}>Adicionar</Button>
      </div>
      <ul className="divide-y divide-line">
        {q.data?.map((m) => (
          <li key={m.id} className="flex items-center gap-4 px-5 py-4">
            <span className="grid size-9 place-items-center rounded-full bg-surface-2 text-sm font-semibold">{m.name.slice(0, 1).toUpperCase()}</span>
            <div className="min-w-0 flex-1">
              <p className="font-medium flex items-center gap-1.5">{m.name}{m.isOwner && <Crown className="size-3.5 text-warn" />}{!m.active && <span className="text-xs text-danger">(desativado)</span>}{m.userId === me?.id && <span className="text-xs text-faint">você</span>}</p>
              <p className="text-xs text-faint truncate">@{m.username} · {m.email} · {m.groupIds.map(groupName).filter(Boolean).join(', ') || 'sem grupo'}</p>
            </div>
            <IconButton label="Editar" onClick={() => setEditing(m)}><Pencil className="size-4" /></IconButton>
            {!m.isOwner && <IconButton label="Remover" tone="danger" onClick={() => remove(m)}><Trash2 className="size-4" /></IconButton>}
          </li>
        ))}
      </ul>
      {editing && <MemberForm member={editing} onClose={() => setEditing(null)} onSaved={setEditing} />}
    </Card>
  );
}
