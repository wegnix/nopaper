import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { motion } from 'motion/react';
import { toast } from 'sonner';
import type { OrgKind } from '@nopaper/shared';
import { Button, Field, Input, Segmented } from '@/components/ui/base';
import { Logo } from '@/components/layout/Logo';
import { useAuthScene } from './AuthScenes';
import { post, get, errMsg } from '@/lib/api';
import { useSession, type SessionPayload } from '@/lib/session';
import { afterLoginPath } from '@/lib/utils';

function AuthLayout({ children, title, subtitle }: { children: React.ReactNode; title: string; subtitle: string }) {
  const scene = useAuthScene();
  return (
    <div className="safe-top safe-bottom safe-x min-h-dvh grid lg:grid-cols-[1.1fr_1fr]">
      <div className="relative hidden lg:flex flex-col justify-between overflow-hidden bg-[#141029] p-10 text-white">
        <div className="absolute inset-0 opacity-[.35] [background:radial-gradient(60%_50%_at_30%_30%,#5b4be8_0%,transparent_70%),radial-gradient(40%_40%_at_80%_80%,#2a1f7a_0%,transparent_70%)]" />
        <div className="relative"><Logo animated scale="lg" className="[&_span]:text-white" /></div>
        <div className="relative flex items-center gap-12">
          {scene.art}
          <motion.div key={scene.key} className="max-w-xs" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.25, duration: 0.6 }}>
            <p className="font-display text-[34px] leading-[1.05] font-semibold">{scene.title}</p>
            <p className="mt-4 text-sm text-white/70">{scene.text}</p>
          </motion.div>
        </div>
        <p className="relative text-xs text-white/50">NoPaper · gestão financeira pessoal e para pequenas empresas</p>
      </div>
      <div className="flex items-center justify-center p-6">
        <div className="w-full max-w-sm">
          <div className="lg:hidden mb-8 sm:mb-10"><Logo animated scale="lg" /></div>
          <h1 className="font-display text-3xl font-semibold">{title}</h1>
          <p className="mt-2 text-sm text-muted">{subtitle}</p>
          <div className="mt-8">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function LoginPage() {
  const nav = useNavigate();
  const loc = useLocation();
  const setSession = useSession((s) => s.setSession);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [needsSetup, setNeedsSetup] = useState(false);
  const endReason = useSession((s) => s.endReason);
  useEffect(() => { get<{ needsSetup: boolean }>('/api/auth/bootstrap').then((b) => setNeedsSetup(b.needsSetup)).catch(() => null); }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      setSession(await post<SessionPayload>('/api/auth/login', { login: email, password }));
      nav(afterLoginPath(loc.state), { replace: true });
    } catch (err) { toast.error(errMsg(err)); } finally { setBusy(false); }
  };
  return (
    <AuthLayout title="Entrar" subtitle="Use seu usuário ou e-mail e a senha da sua conta.">
      {endReason && (
        <p role="status" className="mb-6 rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm text-ink">
          {endReason === 'idle' ? 'Sua sessão foi encerrada por inatividade. Entre de novo para continuar.' : 'Sua sessão expirou. Entre de novo para continuar.'}
        </p>
      )}
      {needsSetup && (
        <p className="mb-6 rounded-lg border border-line bg-surface-2 p-3 text-sm text-muted">
          Nenhum administrador foi criado ainda. Defina <code>ADMIN_EMAIL</code> e <code>ADMIN_PASSWORD</code> no <code>.env</code> do servidor e reinicie a API.
        </p>
      )}
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="E-mail ou usuário"><Input autoComplete="username" autoCapitalize="none" spellCheck={false} required value={email} onChange={(e) => setEmail(e.target.value)} autoFocus /></Field>
        <Field label="Senha"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Button type="submit" variant="primary" size="lg" loading={busy} className="mt-2">Entrar</Button>
      </form>
    </AuthLayout>
  );
}

/** Primeiro login com senha provisória (do .env ou definida por um administrador). */
export function ForcePasswordPage() {
  const user = useSession((s) => s.user);
  const setSession = useSession((s) => s.setSession);
  const clear = useSession((s) => s.clear);
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const [kind, setKind] = useState<OrgKind>('company');
  const [orgName, setOrgName] = useState(user?.initialOrgName ?? '');
  const [busy, setBusy] = useState(false);
  const mismatch = f.confirm.length > 0 && f.next !== f.confirm;
  const needsOrg = !!user?.needsInitialOrg;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (f.next !== f.confirm) return;
    setBusy(true);
    try {
      await post('/api/auth/password', { currentPassword: f.current, newPassword: f.next, ...(needsOrg ? { initialOrgKind: kind, initialOrgName: orgName } : {}) });
      setSession(await get<SessionPayload>('/api/auth/me'));
      toast.success('Senha definida. Tudo pronto!');
    } catch (err) { toast.error(errMsg(err)); } finally { setBusy(false); }
  };
  const leave = async () => { await post('/api/auth/logout').catch(() => null); clear(); };
  return (
    <AuthLayout title="Crie sua senha" subtitle={`Olá, ${user?.name ?? ''}. Você entrou com uma senha provisória; defina a sua para continuar.`}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <input type="text" autoComplete="username" value={user?.username ?? ''} readOnly hidden />
        <Field label="Senha provisória"><Input type="password" required autoComplete="current-password" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} autoFocus /></Field>
        <Field label="Nova senha" hint="Mínimo de 8 caracteres, diferente da provisória."><Input type="password" required minLength={8} autoComplete="new-password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} /></Field>
        <Field label="Repita a nova senha" error={mismatch ? 'As senhas não conferem' : undefined}><Input type="password" required minLength={8} autoComplete="new-password" value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} /></Field>
        {needsOrg && (
          <Field label="Nome do espaço" hint="Pode ser alterado depois em Configurações → Espaço.">
            <Input required minLength={2} maxLength={120} value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder={kind === 'company' ? 'Ex.: Minha Empresa Ltda' : 'Ex.: Finanças da Família'} />
          </Field>
        )}
        {needsOrg && (
          <Field label="Perfil do espaço" hint={kind === 'company'
            ? 'Inclui as pastas FUNCIONARIO e BANCO e categorias de empresa (Salário, Pró-Labore, Frota…).'
            : 'Pastas e categorias para finanças pessoais.'}>
            <Segmented value={kind} onChange={setKind} options={[{ value: 'personal', label: 'Pessoal' }, { value: 'company', label: 'Empresa' }]} />
          </Field>
        )}
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={mismatch} className="mt-2">Salvar senha e entrar</Button>
      </form>
      <button type="button" onClick={leave} className="mt-6 text-sm text-muted hover:text-ink">Sair</button>
    </AuthLayout>
  );
}
