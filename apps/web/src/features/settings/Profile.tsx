import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LogOut, Monitor } from 'lucide-react';
import { Button, Card, Field, Input, IconButton } from '@/components/ui/base';
import { del, get, post, put, errMsg } from '@/lib/api';
import { useSession, type SessionPayload } from '@/lib/session';

export function ProfilePage() {
  const { user, setSession } = useSession();
  const [name, setName] = useState(user?.name ?? '');
  const [username, setUsername] = useState(user?.username ?? '');
  const [email, setEmail] = useState(user?.email ?? '');
  const [emailPw, setEmailPw] = useState('');
  const emailChanged = email.trim().toLowerCase() !== (user?.email ?? '').toLowerCase();
  const [pw, setPw] = useState({ currentPassword: '', newPassword: '' });
  const [busy, setBusy] = useState<string | null>(null);
  const qc = useQueryClient();
  useEffect(() => { setName(user?.name ?? ''); setUsername(user?.username ?? ''); setEmail(user?.email ?? ''); setEmailPw(''); }, [user]);
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => get<{ items: Array<{ id: string; userAgent: string | null; ip: string | null; lastUsedAt: string; current: boolean }> }>('/api/auth/sessions') });

  const saveProfile = async () => {
    setBusy('p');
    try {
      setSession(await put<SessionPayload>('/api/auth/profile', { name, username, ...(emailChanged ? { email: email.trim(), currentPassword: emailPw } : {}) }));
      toast.success(emailChanged ? 'Perfil salvo. Use o novo e-mail para entrar.' : 'Perfil salvo');
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(null); }
  };
  const changePw = async () => {
    setBusy('pw');
    try { await post('/api/auth/password', pw); setPw({ currentPassword: '', newPassword: '' }); toast.success('Senha alterada. As outras sessões foram encerradas.'); qc.invalidateQueries({ queryKey: ['sessions'] }); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(null); }
  };
  return (
    <div className="flex flex-col gap-6">
      <Card className="p-5">
        <h2 className="font-display text-lg font-semibold">Dados pessoais</h2>
        <div className="mt-4 grid sm:grid-cols-2 gap-4">
          <Field label="Nome"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Usuário" hint="Você pode entrar com ele ou com o e-mail.">
            <Input value={username} maxLength={32} autoCapitalize="none" spellCheck={false} onChange={(e) => setUsername(e.target.value.toLowerCase().replace(/\s+/g, ''))} />
          </Field>
          <Field label="E-mail" hint="Também serve para entrar e recebe os alertas por e-mail.">
            <Input type="email" autoComplete="email" value={email} maxLength={255} onChange={(e) => setEmail(e.target.value)} />
          </Field>
          {emailChanged && (
            <Field label="Sua senha atual" hint="Para trocar o e-mail, confirme que é você.">
              <Input type="password" autoComplete="current-password" value={emailPw} onChange={(e) => setEmailPw(e.target.value)} />
            </Field>
          )}
        </div>
        <Button className="mt-4" variant="primary" loading={busy === 'p'} disabled={emailChanged && (!emailPw || !/^\S+@\S+\.\S+$/.test(email.trim()))} onClick={saveProfile}>Salvar perfil</Button>
      </Card>
      <Card className="p-5">
        <h2 className="font-display text-lg font-semibold">Senha</h2>
        <div className="mt-4 grid sm:grid-cols-2 gap-4">
          <Field label="Senha atual"><Input type="password" autoComplete="current-password" value={pw.currentPassword} onChange={(e) => setPw({ ...pw, currentPassword: e.target.value })} /></Field>
          <Field label="Nova senha" hint="Mínimo de 8 caracteres."><Input type="password" autoComplete="new-password" value={pw.newPassword} onChange={(e) => setPw({ ...pw, newPassword: e.target.value })} /></Field>
        </div>
        <Button className="mt-4" loading={busy === 'pw'} disabled={!pw.currentPassword || pw.newPassword.length < 8} onClick={changePw}>Alterar senha</Button>
      </Card>
      <Card className="p-5">
        <h2 className="font-display text-lg font-semibold">Sessões ativas</h2>
        <ul className="mt-3 divide-y divide-line">
          {sessions.data?.items.map((s) => (
            <li key={s.id} className="flex items-center gap-3 py-3">
              <Monitor className="size-5 text-faint" />
              <div className="min-w-0 flex-1">
                <p className="text-sm truncate">{s.userAgent ?? 'Navegador desconhecido'}</p>
                <p className="text-xs text-faint">{s.ip} · último uso {new Date(s.lastUsedAt).toLocaleString('pt-BR')}{s.current && ' · esta sessão'}</p>
              </div>
              {!s.current && <IconButton label="Encerrar sessão" tone="danger" onClick={async () => { await del(`/api/auth/sessions/${s.id}`); sessions.refetch(); }}><LogOut className="size-4" /></IconButton>}
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
