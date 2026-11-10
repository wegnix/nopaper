import { useMemo, useState } from 'react';
import { Navigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Building2, Crown, KeyRound, LogOut, Pencil, Search, ShieldCheck, Trash2, UserCheck, UserPlus, UserX } from 'lucide-react';
import { usernameFromEmail } from '@nopaper/shared';
import { Button, Card, Checkbox, Field, IconButton, Input, Select, Spinner, Switch } from '@/components/ui/base';
import { Dialog, SaveFooter, useConfirm, useFormState } from '@/components/ui/dialog';
import { api, errMsg, get, post, put } from '@/lib/api';
import { useSession, type SessionPayload } from '@/lib/session';
import { cn } from '@/lib/utils';
import { when } from './common';

interface PUser {
  id: string; name: string; email: string; username: string; active: boolean; isSuperadmin: boolean; canCreateOrgs: boolean;
  mustChangePassword: boolean; lastLoginAt: string | null; createdAt: string; sessions: number;
  orgs: Array<{ id: string; name: string; isOwner: boolean; active: boolean; groupIds: string[] }>;
}

type Filter = '' | 'admins' | 'creators' | 'inactive';

export function UsersPage() {
  const me = useSession((s) => s.user);
  const q = useQuery({ enabled: !!me?.isSuperadmin, queryKey: ['system', 'users'], queryFn: () => get<{ items: PUser[] }>('/api/system/users').then((r) => r.items) });
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<Filter>('');
  const [editing, setEditing] = useState<PUser | 'new' | null>(null);
  const [resetting, setResetting] = useState<PUser | null>(null);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const rows = useMemo(() => {
    const t = search.trim().toLowerCase();
    return (q.data ?? []).filter((u) => (!t || `${u.name} ${u.email} ${u.username} ${u.orgs.map((o) => o.name).join(' ')}`.toLowerCase().includes(t))
      && (filter !== 'admins' || u.isSuperadmin) && (filter !== 'creators' || u.canCreateOrgs || u.isSuperadmin) && (filter !== 'inactive' || !u.active));
  }, [q.data, search, filter]);
  if (!me?.isSuperadmin) return <Navigate to="/config/perfil" replace />;

  const logoutAll = async (u: PUser) => {
    try { const r = await post<{ revoked: number }>(`/api/system/users/${u.id}/logout`); toast.success(r.revoked ? `${r.revoked} sessão(ões) encerrada(s)` : 'Nenhuma sessão aberta'); qc.invalidateQueries({ queryKey: ['system', 'users'] }); }
    catch (e) { toast.error(errMsg(e)); }
  };

  const refresh = () => qc.invalidateQueries({ queryKey: ['system', 'users'] });
  /** Desativar: bloqueia o acesso e mantém a conta (dá para reativar). */
  const toggleActive = async (u: PUser) => {
    if (u.active && !(await confirm({ title: `Desativar ${u.name}?`, confirmLabel: 'Desativar', body: 'A pessoa não entra mais em nenhum espaço e as sessões abertas são encerradas. A conta continua aqui e pode ser reativada quando quiser.' }))) return;
    try { await put(`/api/system/users/${u.id}`, { active: !u.active }); refresh(); toast.success(u.active ? 'Conta desativada' : 'Conta reativada'); } catch (e) { toast.error(errMsg(e)); }
  };
  /** Remover: a conta some das listas e dos espaços; o que a pessoa fez continua registrado com o nome dela. */
  const remove = async (u: PUser) => {
    const ok = await confirm({
      title: `Remover a conta de ${u.name}?`, tone: 'danger', confirmLabel: 'Remover conta',
      body: `A conta deixa de existir${u.orgs.length ? ` e sai de ${u.orgs.length === 1 ? `“${u.orgs[0]!.name}”` : `${u.orgs.length} espaços`}` : ''}. Nada do que ela fez é apagado: contas lançadas, anexos e o histórico da auditoria continuam, com o nome dela. O e-mail e o usuário ficam livres para uma conta nova. Não dá para desfazer — se for só bloquear o acesso, prefira desativar.`,
    });
    if (!ok) return;
    try { await api('DELETE', `/api/system/users/${u.id}`); refresh(); toast.success(`Conta de ${u.name} removida`); } catch (e) { toast.error(errMsg(e)); }
  };

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line p-5">
        <div>
          <h2 className="font-display text-lg font-semibold">Usuários da plataforma</h2>
          <p className="text-sm text-muted">Todas as contas, de todos os espaços. O acesso a cada espaço é dado em Membros, dentro do espaço.</p>
        </div>
        <Button variant="primary" icon={<UserPlus className="size-4" />} onClick={() => setEditing('new')}>Nova conta</Button>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <Input className="h-9 pl-9" placeholder="Buscar por nome, e-mail, usuário ou espaço…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {([['', 'Todas'], ['admins', 'Administradores'], ['creators', 'Podem criar espaços'], ['inactive', 'Desativadas']] as Array<[Filter, string]>).map(([k, label]) => (
          <button key={k || 'all'} type="button" onClick={() => setFilter(k)}
            className={cn('rounded-md border px-2 py-1 text-xs font-medium transition-colors', filter === k ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-ink')}>{label}</button>
        ))}
      </div>
      {q.isLoading ? <div className="grid place-items-center py-12"><Spinner /></div> : (
        <ul className="divide-y divide-line">
          {rows.map((u) => (
            <li key={u.id} className={cn('flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-4', !u.active && 'opacity-60')}>
              <span className="grid size-9 shrink-0 place-items-center rounded-full bg-surface-2 text-sm font-semibold">{u.name.slice(0, 1).toUpperCase()}</span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-1.5 font-medium">
                  {u.name}
                  {u.id === me.id && <span className="text-xs font-normal text-faint">você</span>}
                  {u.isSuperadmin && <Badge tone="accent"><ShieldCheck className="size-3" />admin da plataforma</Badge>}
                  {!u.isSuperadmin && u.canCreateOrgs && <Badge><Building2 className="size-3" />cria espaços</Badge>}
                  {!u.active && <Badge tone="danger">desativada</Badge>}
                  {u.mustChangePassword && <Badge tone="warn">senha provisória</Badge>}
                </p>
                <p className="truncate text-xs text-faint">@{u.username} · {u.email} · {u.lastLoginAt ? `último acesso ${when(u.lastLoginAt)}` : 'nunca entrou'}{u.sessions ? ` · ${u.sessions} sessão(ões) aberta(s)` : ''}</p>
                {u.orgs.length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {u.orgs.map((o) => (
                      <span key={o.id} className={cn('inline-flex items-center gap-1 rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted', !o.active && 'line-through')}>
                        {o.isOwner && <Crown className="size-3 text-warn" />}{o.name}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <div className="flex items-center gap-0.5 max-sm:w-full max-sm:justify-end">
                <IconButton label="Encerrar sessões" onClick={() => logoutAll(u)} disabled={!u.sessions}><LogOut className="size-4" /></IconButton>
                {u.id !== me.id && <IconButton label="Definir senha provisória" onClick={() => setResetting(u)}><KeyRound className="size-4" /></IconButton>}
                <IconButton label="Editar" onClick={() => setEditing(u)}><Pencil className="size-4" /></IconButton>
                {u.id !== me.id && <IconButton label={u.active ? 'Desativar (bloqueia o acesso, mantém a conta)' : 'Reativar a conta'} onClick={() => toggleActive(u)}>{u.active ? <UserX className="size-4" /> : <UserCheck className="size-4 text-ok" />}</IconButton>}
                {u.id !== me.id && <IconButton label="Remover a conta" tone="danger" onClick={() => remove(u)}><Trash2 className="size-4" /></IconButton>}
              </div>
            </li>
          ))}
          {!rows.length && <li className="px-5 py-10 text-center text-sm text-faint">Nenhuma conta encontrada.</li>}
        </ul>
      )}
      {editing && <UserForm user={editing === 'new' ? null : (q.data?.find((x) => x.id === editing.id) ?? editing)} selfId={me.id} onClose={() => setEditing(null)} onSaved={setEditing} />}
      {resetting && <ResetPassword user={resetting} onClose={() => setResetting(null)} />}
    </Card>
  );
}

function Badge({ children, tone }: { children: React.ReactNode; tone?: 'accent' | 'danger' | 'warn' }) {
  return (
    <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium',
      tone === 'accent' ? 'bg-accent-soft text-accent' : tone === 'danger' ? 'bg-danger/10 text-danger' : tone === 'warn' ? 'bg-warn/15 text-warn' : 'bg-surface-2 text-muted')}>
      {children}
    </span>
  );
}

function UserForm({ user, selfId, onClose, onSaved }: { user: PUser | null; selfId: string; onClose: () => void; onSaved: (u: PUser) => void }) {
  const qc = useQueryClient();
  const self = user?.id === selfId;
  const [f, setF, form] = useFormState({
    name: user?.name ?? '', email: user?.email ?? '', username: user?.username ?? '', password: '',
    active: user?.active ?? true, isSuperadmin: user?.isSuperadmin ?? false, canCreateOrgs: user?.canCreateOrgs ?? false,
  });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      const u = user
        ? await put<PUser>(`/api/system/users/${user.id}`, { name: f.name, email: f.email, username: f.username, active: f.active, isSuperadmin: f.isSuperadmin, canCreateOrgs: f.canCreateOrgs })
        : await post<PUser>('/api/system/users', { name: f.name, email: f.email, username: f.username || undefined, password: f.password, isSuperadmin: f.isSuperadmin, canCreateOrgs: f.canCreateOrgs });
      qc.invalidateQueries({ queryKey: ['system', 'users'] });
      if (self) useSession.getState().setSession(await get<SessionPayload>('/api/auth/me'));
      toast.success(user ? 'Conta salva' : 'Conta criada. A pessoa cria a própria senha no primeiro acesso.');
      const saved = { ...f, password: '', username: u?.username ?? f.username };
      form.load(saved);
      if (!user && u?.id) onSaved(u);
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} dirty={form.dirty} title={user ? user.name : 'Nova conta'}
      description={user ? 'Dados de acesso e permissões da conta na plataforma.' : 'A conta é criada sem espaço: depois, adicione a pessoa em Membros do espaço desejado (ou deixe que ela crie o próprio).'}
      footer={<SaveFooter dirty={form.dirty} isNew={!user} saving={busy} canSave={f.name.trim().length >= 2 && !!f.email.trim() && (!!user || f.password.length >= 8)} onSave={save} onClose={onClose} saveLabel={user ? 'Salvar' : 'Criar conta'} />}>
      <div className="flex flex-col gap-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Nome"><Input value={f.name} autoFocus={!user} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="E-mail"><Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></Field>
          <Field label="Usuário" hint={user ? undefined : 'Vazio: gerado a partir do e-mail.'}>
            <Input value={f.username} maxLength={32} autoCapitalize="none" spellCheck={false} placeholder={!user && f.email ? usernameFromEmail(f.email) : ''} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase().replace(/\s+/g, '') })} />
          </Field>
          {!user && <Field label="Senha provisória" hint="Mínimo 8 caracteres. Troca obrigatória no primeiro acesso."><Input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>}
        </div>
        <div className="flex flex-col gap-4 rounded-xl border border-line p-4">
          <Switch checked={f.canCreateOrgs || f.isSuperadmin} disabled={f.isSuperadmin} onChange={(canCreateOrgs) => setF({ ...f, canCreateOrgs })} label="Pode criar espaços"
            hint={f.isSuperadmin ? 'Administradores da plataforma sempre podem.' : 'A pessoa vira dona dos espaços que criar. Sem isso, só acessa os espaços em que for adicionada.'} />
          <Switch checked={f.isSuperadmin} disabled={self} onChange={(isSuperadmin) => setF({ ...f, isSuperadmin })} label="Administrador da plataforma"
            hint={self ? 'Você não pode tirar o seu próprio acesso.' : 'Vê esta área: usuários, backups, restauração, e-mail e Telegram. Não dá acesso aos espaços.'} />
          {user && <Switch checked={f.active} disabled={self} onChange={(active) => setF({ ...f, active })} label="Conta ativa"
            hint={self ? 'Você não pode desativar a sua própria conta.' : 'Desativada, a pessoa não entra em nenhum espaço e as sessões abertas são encerradas.'} />}
        </div>
        {user && <UserOrgs user={user} />}
      </div>
    </Dialog>
  );
}

interface POrg { id: string; name: string; kind: string; groups: Array<{ id: string; name: string; isAdmin: boolean }> }

/** Espaços da conta: em quais está, com que grupos, e adicionar a outro. Cada mudança grava na hora. */
function UserOrgs({ user }: { user: PUser }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const orgs = useQuery({ queryKey: ['system', 'orgs'], queryFn: () => get<{ items: POrg[] }>('/api/system/orgs').then((r) => r.items) });
  const [adding, setAdding] = useState('');
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const refresh = () => { qc.invalidateQueries({ queryKey: ['system', 'users'] }); qc.invalidateQueries({ queryKey: ['members'] }); };
  const byId = new Map((orgs.data ?? []).map((o) => [o.id, o]));
  const free = (orgs.data ?? []).filter((o) => !user.orgs.some((x) => x.id === o.id));
  const setGroups = async (orgId: string, ids: string[]) => {
    try { await put(`/api/system/users/${user.id}/orgs/${orgId}`, { groupIds: ids }); refresh(); } catch (e) { toast.error(errMsg(e)); }
  };
  const add = async () => {
    setBusy(true);
    try { await put(`/api/system/users/${user.id}/orgs/${adding}`, { groupIds }); refresh(); toast.success(`${user.name} agora é do espaço ${byId.get(adding)?.name ?? ''}`); setAdding(''); setGroupIds([]); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const remove = async (o: PUser['orgs'][number]) => {
    if (!(await confirm({ title: `Tirar ${user.name} de “${o.name}”?`, tone: 'danger', confirmLabel: 'Tirar do espaço', body: 'A pessoa perde o acesso a esse espaço. O que ela lançou lá e o histórico continuam.' }))) return;
    try { await api('DELETE', `/api/system/users/${user.id}/orgs/${o.id}`); refresh(); toast.success('Removida do espaço'); } catch (e) { toast.error(errMsg(e)); }
  };
  const toggle = (list: string[], id: string, on: boolean) => (on ? [...list, id] : list.filter((x) => x !== id));
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-line p-4">
      <div>
        <p className="text-sm font-medium">Espaços</p>
        <p className="text-xs text-faint">Onde a conta entra e com que grupos. As mudanças aqui valem na hora.</p>
      </div>
      {!user.orgs.length && <p className="rounded-lg bg-surface-2/60 px-3 py-2 text-sm text-muted">Esta conta ainda não está em nenhum espaço.</p>}
      {user.orgs.map((o) => (
        <div key={o.id} className="rounded-lg border border-line/70 p-3">
          <div className="flex items-center gap-2">
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium">{o.isOwner && <Crown className="size-3.5 shrink-0 text-warn" />}<span className="truncate">{o.name}</span>{o.isOwner && <span className="shrink-0 text-xs font-normal text-faint">dono</span>}{!o.active && <span className="shrink-0 text-xs font-normal text-danger">acesso desativado</span>}</span>
            {!o.isOwner && <IconButton label={`Tirar de ${o.name}`} tone="danger" onClick={() => remove(o)}><Trash2 className="size-4" /></IconButton>}
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
            {(byId.get(o.id)?.groups ?? []).map((g) => (
              <Checkbox key={g.id} checked={o.groupIds.includes(g.id)} onChange={(v) => setGroups(o.id, toggle(o.groupIds, g.id, v))} label={<span className="text-sm">{g.name}{g.isAdmin && <span className="ml-1 text-xs text-faint">acesso total</span>}</span>} />
            ))}
          </div>
        </div>
      ))}
      {free.length > 0 && (
        <div className="flex flex-col gap-2.5 rounded-lg bg-surface-2/50 p-3">
          <Select aria-label="Adicionar a um espaço" value={adding} onChange={(e) => { setAdding(e.target.value); setGroupIds([]); }}>
            <option value="">Adicionar a um espaço…</option>
            {free.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </Select>
          {adding && <>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {(byId.get(adding)?.groups ?? []).map((g) => (
                <Checkbox key={g.id} checked={groupIds.includes(g.id)} onChange={(v) => setGroupIds(toggle(groupIds, g.id, v))} label={<span className="text-sm">{g.name}{g.isAdmin && <span className="ml-1 text-xs text-faint">acesso total</span>}</span>} />
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-faint">{groupIds.length ? '' : 'Sem grupo, a pessoa entra no espaço mas não vê nada.'}</span>
              <Button size="sm" variant="primary" loading={busy} onClick={add}>Adicionar ao espaço</Button>
            </div>
          </>}
        </div>
      )}
    </div>
  );
}

function ResetPassword({ user, onClose }: { user: PUser; onClose: () => void }) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const qc = useQueryClient();
  const go = async () => {
    setBusy(true);
    try { await post(`/api/system/users/${user.id}/reset-password`, { password: pw }); qc.invalidateQueries({ queryKey: ['system', 'users'] }); toast.success(`Senha provisória definida para ${user.name}`); onClose(); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} size="sm" title="Definir senha provisória" description={`${user.name} entra com esta senha e cria a própria no primeiro acesso. As sessões abertas são encerradas.`}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={pw.length < 8} onClick={go}>Definir senha</Button></>}>
      <Field label="Senha provisória" hint="Mínimo 8 caracteres. Passe para a pessoa por um canal seguro.">
        <Input type="password" autoComplete="new-password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} />
      </Field>
    </Dialog>
  );
}
