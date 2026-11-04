import { useMemo, useState } from 'react';
import { Navigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Building2, Crown, KeyRound, LogOut, Pencil, Search, ShieldCheck, UserPlus } from 'lucide-react';
import { usernameFromEmail } from '@nopaper/shared';
import { Button, Card, Field, IconButton, Input, Spinner, Switch } from '@/components/ui/base';
import { Dialog } from '@/components/ui/dialog';
import { errMsg, get, post, put } from '@/lib/api';
import { useSession, type SessionPayload } from '@/lib/session';
import { cn } from '@/lib/utils';
import { when } from './common';

interface PUser {
  id: string; name: string; email: string; username: string; active: boolean; isSuperadmin: boolean; canCreateOrgs: boolean;
  mustChangePassword: boolean; lastLoginAt: string | null; createdAt: string; sessions: number;
  orgs: Array<{ id: string; name: string; isOwner: boolean; active: boolean }>;
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
              <div className="flex items-center gap-0.5">
                <IconButton label="Encerrar sessões" onClick={() => logoutAll(u)} disabled={!u.sessions}><LogOut className="size-4" /></IconButton>
                {u.id !== me.id && <IconButton label="Definir senha provisória" onClick={() => setResetting(u)}><KeyRound className="size-4" /></IconButton>}
                <IconButton label="Editar" onClick={() => setEditing(u)}><Pencil className="size-4" /></IconButton>
              </div>
            </li>
          ))}
          {!rows.length && <li className="px-5 py-10 text-center text-sm text-faint">Nenhuma conta encontrada.</li>}
        </ul>
      )}
      {editing && <UserForm user={editing === 'new' ? null : editing} selfId={me.id} onClose={() => setEditing(null)} />}
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

function UserForm({ user, selfId, onClose }: { user: PUser | null; selfId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const self = user?.id === selfId;
  const [f, setF] = useState({
    name: user?.name ?? '', email: user?.email ?? '', username: user?.username ?? '', password: '',
    active: user?.active ?? true, isSuperadmin: user?.isSuperadmin ?? false, canCreateOrgs: user?.canCreateOrgs ?? false,
  });
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      if (user) await put(`/api/system/users/${user.id}`, { name: f.name, email: f.email, username: f.username, active: f.active, isSuperadmin: f.isSuperadmin, canCreateOrgs: f.canCreateOrgs });
      else await post('/api/system/users', { name: f.name, email: f.email, username: f.username || undefined, password: f.password, isSuperadmin: f.isSuperadmin, canCreateOrgs: f.canCreateOrgs });
      qc.invalidateQueries({ queryKey: ['system', 'users'] });
      if (self) useSession.getState().setSession(await get<SessionPayload>('/api/auth/me'));
      toast.success(user ? 'Conta atualizada' : 'Conta criada. A pessoa cria a própria senha no primeiro acesso.');
      onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} title={user ? user.name : 'Nova conta'}
      description={user ? 'Dados de acesso e permissões da conta na plataforma.' : 'A conta é criada sem espaço: depois, adicione a pessoa em Membros do espaço desejado (ou deixe que ela crie o próprio).'}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={f.name.trim().length < 2 || !f.email.trim() || (!user && f.password.length < 8)} onClick={save}>{user ? 'Salvar' : 'Criar conta'}</Button></>}>
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
      </div>
    </Dialog>
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
