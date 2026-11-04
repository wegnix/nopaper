import { useState } from 'react';
import { Navigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Mail, Send } from 'lucide-react';
import { Button, Card, Field, Input, Select, Spinner } from '@/components/ui/base';
import { errMsg, post, put } from '@/lib/api';
import { useSession } from '@/lib/session';
import { secretHint, useSystemSettings, type SystemView } from './common';

export function NotificationsPage() {
  const me = useSession((s) => s.user);
  const qc = useQueryClient();
  const q = useSystemSettings();
  if (!me?.isSuperadmin) return <Navigate to="/config/perfil" replace />;
  if (!q.data) return <div className="grid place-items-center py-16"><Spinner /></div>;
  const refresh = () => qc.invalidateQueries({ queryKey: ['system'] });
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted">Canais usados pelos alertas de todos os espaços. Cada espaço escolhe, em Alertas, quem recebe e quando.</p>
      <div className="grid gap-6 xl:grid-cols-2">
        <SmtpCard v={q.data.smtp} onSaved={refresh} email={me.email} />
        <TelegramCard v={q.data.telegram} onSaved={refresh} />
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ Telegram
function TelegramCard({ v, onSaved }: { v: SystemView['telegram']; onSaved: () => void }) {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (value: string | null) => {
    setBusy(true);
    try { const r = await put<{ botUsername: string | null }>('/api/system/telegram', { token: value }); setToken(''); onSaved(); toast.success(r.botUsername ? `Bot @${r.botUsername} conectado` : 'Bot removido'); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Card className="p-5">
      <div className="flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-lg bg-accent-soft text-accent"><Send className="size-4" /></span>
        <div>
          <h2 className="font-display font-semibold">Bot do Telegram</h2>
          <p className="text-xs text-muted">{v.botUsername ? `Conectado: @${v.botUsername}` : 'Usado pelos alertas de todos os espaços'}</p>
        </div>
      </div>
      <ol className="mt-4 list-decimal space-y-1 pl-5 text-sm text-muted">
        <li>No Telegram, converse com <b>@BotFather</b> e envie <code>/newbot</code>.</li>
        <li>Escolha um nome e um usuário terminado em “bot”.</li>
        <li>Cole aqui o token que ele devolver.</li>
      </ol>
      <Field label="Token do bot" className="mt-4" hint={v.hasToken ? 'Já existe um token guardado. Cole outro para trocar.' : undefined}>
        <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="123456789:AA…" />
      </Field>
      <div className="mt-4 flex gap-2">
        <Button variant="primary" loading={busy} disabled={!token.trim()} onClick={() => save(token.trim())}>Salvar e validar</Button>
        {v.hasToken && <Button variant="ghost" disabled={busy} onClick={() => save(null)}>Remover bot</Button>}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ SMTP
function SmtpCard({ v, onSaved, email }: { v: SystemView['smtp']; onSaved: () => void; email: string }) {
  const [f, setF] = useState({ host: v.host, port: v.port, secure: v.secure, user: v.user, from: v.from, password: '' });
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [to, setTo] = useState(email);
  const save = async () => {
    setBusy('save');
    try { await put('/api/system/smtp', f); setF({ ...f, password: '' }); onSaved(); toast.success('SMTP salvo'); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(null); }
  };
  const test = async () => {
    setBusy('test');
    try { await post('/api/system/smtp/test', { to }); toast.success(`E-mail de teste enviado para ${to}`); } catch (e) { toast.error(errMsg(e)); } finally { setBusy(null); }
  };
  return (
    <Card className="p-5">
      <div className="flex items-center gap-3">
        <span className="grid size-9 place-items-center rounded-lg bg-accent-soft text-accent"><Mail className="size-4" /></span>
        <div>
          <h2 className="font-display font-semibold">Servidor de e-mail (SMTP)</h2>
          <p className="text-xs text-muted">Gmail, Outlook, Amazon SES, Brevo… qualquer SMTP</p>
        </div>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_110px]">
        <Field label="Servidor"><Input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="smtp.gmail.com" /></Field>
        <Field label="Porta"><Input type="number" value={f.port} onChange={(e) => setF({ ...f, port: Number(e.target.value) || 587, secure: Number(e.target.value) === 465 ? true : f.secure })} /></Field>
        <Field label="Usuário"><Input value={f.user} autoComplete="off" onChange={(e) => setF({ ...f, user: e.target.value })} /></Field>
        <Field label="Segurança">
          <Select value={f.secure ? 'tls' : 'starttls'} onChange={(e) => setF({ ...f, secure: e.target.value === 'tls' })}>
            <option value="starttls">STARTTLS</option><option value="tls">TLS (465)</option>
          </Select>
        </Field>
        <Field label="Senha" hint={secretHint(v.hasPassword)} className="sm:col-span-2">
          <Input type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} placeholder={v.hasPassword ? '••••••••' : 'Senha ou senha de app'} />
        </Field>
        <Field label="Remetente" className="sm:col-span-2" hint='Ex.: NoPaper <alertas@suaempresa.com.br>'>
          <Input value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
        </Field>
      </div>
      <div className="mt-4 flex flex-wrap items-end gap-2">
        <Button variant="primary" loading={busy === 'save'} disabled={!!busy || !f.host} onClick={save}>Salvar</Button>
        <div className="ml-auto flex items-end gap-2">
          <Input className="w-56" value={to} onChange={(e) => setTo(e.target.value)} aria-label="Enviar teste para" />
          <Button variant="ghost" loading={busy === 'test'} disabled={!!busy || !v.host} onClick={test}>Testar</Button>
        </div>
      </div>
    </Card>
  );
}

