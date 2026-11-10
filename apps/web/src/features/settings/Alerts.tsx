import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CheckCircle2, ExternalLink, Loader2, Mail, Plus, Send, Trash2, X, XCircle } from 'lucide-react';
import { ALERT_DAY_OPTIONS, type AlertConfig } from '@nopaper/shared';
import { Button, Card, Field, IconButton, Input, Select, Switch } from '@/components/ui/base';
import { api, errMsg, get, post, put } from '@/lib/api';
import { useCan, useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

interface Delivery { id: string; channel: 'telegram' | 'email'; target: string; status: 'ok' | 'error'; items: number; test: boolean; error: string | null; createdAt: string }
interface AlertsView {
  config: AlertConfig; lastSentOn: string | null; telegramReady: boolean; botUsername: string | null; smtpReady: boolean;
  deliveries: Delivery[]; pendingLink: string | null;
}

const dayLabel = (d: number) => (d === 0 ? 'No dia' : d === 1 ? '1 dia antes' : `${d} dias antes`);

export function AlertsPage() {
  const orgId = useSession((s) => s.orgId);
  const can = useCan();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['alerts', orgId], queryFn: () => get<AlertsView>('/api/alerts') });
  const [f, setF] = useState<AlertConfig | null>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [link, setLink] = useState<{ url: string; bot: string } | null>(null);
  const poll = useRef<number | null>(null);

  useEffect(() => { if (q.data) setF(q.data.config); }, [q.data]);
  useEffect(() => () => { if (poll.current) window.clearInterval(poll.current); }, []);
  if (!f || !q.data) return null;
  const v = q.data;
  const dirty = JSON.stringify({ ...f, telegram: { ...f.telegram, chats: [] } }) !== JSON.stringify({ ...v.config, telegram: { ...v.config.telegram, chats: [] } });

  const save = async (silent = false) => {
    setBusy('save');
    try { await put('/api/alerts', f); await qc.invalidateQueries({ queryKey: ['alerts', orgId] }); if (!silent) toast.success('Alertas salvos'); return true; }
    catch (e) { toast.error(errMsg(e)); return false; } finally { setBusy(null); }
  };
  const test = async () => {
    if (dirty && !(await save(true))) return;
    setBusy('test');
    try {
      const r = await post<{ items: number; results: Array<{ channel: string; target: string; ok: boolean; error?: string }> }>('/api/alerts/test');
      const bad = r.results.filter((x) => !x.ok);
      if (bad.length) toast.error(bad.map((b) => `${b.channel === 'email' ? 'E-mail' : 'Telegram'} (${b.target}): ${b.error}`).join('\n'));
      else toast.success(`Teste enviado (${r.items} ${r.items === 1 ? 'conta' : 'contas'} no resumo de hoje)`);
      qc.invalidateQueries({ queryKey: ['alerts', orgId] });
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(null); }
  };

  const startLink = async () => {
    try {
      const r = await post<{ url: string; bot: string }>('/api/alerts/telegram/link');
      setLink(r);
      window.open(r.url, '_blank', 'noopener');
      if (poll.current) window.clearInterval(poll.current);
      const started = Date.now();
      poll.current = window.setInterval(async () => {
        if (Date.now() - started > 10 * 60_000) { window.clearInterval(poll.current!); setLink(null); return; }
        try {
          const c = await post<{ linked: { id: string; name: string } | null }>('/api/alerts/telegram/check');
          if (c.linked) {
            window.clearInterval(poll.current!); setLink(null);
            toast.success(`Telegram conectado: ${c.linked.name}`);
            qc.invalidateQueries({ queryKey: ['alerts', orgId] });
          }
        } catch { /* tenta de novo */ }
      }, 3000);
    } catch (e) { toast.error(errMsg(e)); }
  };
  const unlink = async (id: string) => {
    try { await api('DELETE', `/api/alerts/telegram/chats/${id}`); qc.invalidateQueries({ queryKey: ['alerts', orgId] }); } catch (e) { toast.error(errMsg(e)); }
  };
  const addEmail = () => {
    const e = email.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(e)) { toast.error('E-mail inválido'); return; }
    if (!f.email.recipients.includes(e)) setF({ ...f, email: { ...f.email, recipients: [...f.email.recipients, e] } });
    setEmail('');
  };

  const rule = (k: 'payable' | 'receivable', title: string) => {
    const r = f[k];
    const set = (patch: Partial<AlertConfig['payable']>) => setF({ ...f, [k]: { ...r, ...patch } });
    return (
      <div key={k} className={cn('rounded-xl border border-line p-4', !r.enabled && 'opacity-70')}>
        <Switch checked={r.enabled} onChange={(enabled) => set({ enabled })} label={title} />
        {r.enabled && (
          <div className="mt-4 flex flex-col gap-3">
            <div>
              <p className="mb-2 text-xs text-muted">Avisar sobre vencimentos</p>
              <div className="flex flex-wrap gap-1.5">
                {ALERT_DAY_OPTIONS.map((d) => {
                  const on = r.daysBefore.includes(d);
                  return (
                    <button key={d} type="button" aria-pressed={on}
                      onClick={() => set({ daysBefore: on ? r.daysBefore.filter((x) => x !== d) : [...r.daysBefore, d].sort((a, b) => a - b).slice(0, 6) })}
                      className={cn('rounded-lg border px-2.5 py-1 text-xs transition-colors', on ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-ink')}>
                      {dayLabel(d)}
                    </button>
                  );
                })}
              </div>
            </div>
            <Switch checked={r.overdue} onChange={(overdue) => set({ overdue })} label="Lembrar das que já venceram" hint="Todo dia, enquanto não forem baixadas" />
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-6">
      <Card className="p-5">
        <div className="flex flex-wrap items-start gap-4">
          <div className="mr-auto">
            <h2 className="font-display text-lg font-semibold">Resumo diário</h2>
            <p className="mt-1 text-sm text-muted">Uma mensagem por dia com o que vence e o que está atrasado. Só é enviada quando há algo para avisar.</p>
          </div>
          <Switch checked={f.enabled} onChange={(enabled) => setF({ ...f, enabled })} label={f.enabled ? 'Ligado' : 'Desligado'} />
        </div>
        <div className="mt-5 grid gap-4 sm:grid-cols-[180px_1fr]">
          <Field label="Horário do envio" hint="No fuso do espaço">
            <Select value={f.hour} onChange={(e) => setF({ ...f, hour: Number(e.target.value) })}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
            </Select>
          </Field>
          <div className="self-end pb-2 text-xs text-faint">{v.lastSentOn ? `Último resumo processado em ${v.lastSentOn.split('-').reverse().join('/')}.` : 'Nenhum resumo enviado ainda.'}</div>
        </div>
        <div className="mt-5 grid gap-4 md:grid-cols-2">
          {can('payable.view') && rule('payable', 'Contas a pagar')}
          {can('receivable.view') && rule('receivable', 'Contas a receber')}
        </div>
        <div className="mt-4"><Switch checked={f.accounting} onChange={(accounting) => setF({ ...f, accounting })} label="Avisar quando o contador enviar documentos" hint="Na hora do envio (holerites, guias, boletos), pelos mesmos canais." /></div>
        {can('bills.view_restricted') && (
          <div className="mt-4"><Switch checked={f.includeRestricted} onChange={(includeRestricted) => setF({ ...f, includeRestricted })} label="Incluir categorias restritas" hint="Cuidado: quem recebe os alertas passa a ver essas contas" /></div>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <div className="flex items-start gap-3">
            <span className="grid size-9 place-items-center rounded-lg bg-accent-soft text-accent"><Send className="size-4" /></span>
            <div className="mr-auto">
              <h3 className="font-display font-semibold">Telegram</h3>
              <p className="text-xs text-muted">{v.telegramReady ? `Pelo bot @${v.botUsername}` : 'O bot ainda não foi configurado pelo administrador da plataforma'}</p>
            </div>
            <Switch checked={f.telegram.enabled} onChange={(enabled) => setF({ ...f, telegram: { ...f.telegram, enabled } })} />
          </div>
          <ul className="mt-4 flex flex-col gap-2">
            {v.config.telegram.chats.map((c) => (
              <li key={c.id} className="flex items-center gap-2 rounded-lg bg-surface-2 px-3 py-2 text-sm">
                <CheckCircle2 className="size-4 text-ok" /><span className="flex-1 truncate">{c.name}</span>
                <IconButton label="Remover chat" tone="danger" onClick={() => unlink(c.id)}><Trash2 className="size-4" /></IconButton>
              </li>
            ))}
          </ul>
          {link ? (
            <div className="mt-3 rounded-lg border border-accent/40 bg-accent-soft/40 p-3 text-sm">
              <p className="flex items-center gap-2"><Loader2 className="size-4 animate-spin text-accent" /> Aguardando você tocar em <b>Iniciar</b> no Telegram…</p>
              <p className="mt-1 text-xs text-muted">Não abriu? <a className="text-accent hover:underline" href={link.url} target="_blank" rel="noopener noreferrer">Abrir conversa com @{link.bot}</a>. Para um grupo, adicione o bot ao grupo e envie o mesmo link lá.</p>
              <button className="mt-2 text-xs text-muted hover:text-ink" onClick={() => { if (poll.current) window.clearInterval(poll.current); setLink(null); }}>Cancelar</button>
            </div>
          ) : (
            <Button className="mt-3" variant="secondary" disabled={!v.telegramReady} icon={<ExternalLink className="size-4" />} onClick={startLink}>
              {v.config.telegram.chats.length ? 'Conectar outro chat' : 'Conectar Telegram'}
            </Button>
          )}
        </Card>

        <Card className="p-5">
          <div className="flex items-start gap-3">
            <span className="grid size-9 place-items-center rounded-lg bg-accent-soft text-accent"><Mail className="size-4" /></span>
            <div className="mr-auto">
              <h3 className="font-display font-semibold">E-mail</h3>
              <p className="text-xs text-muted">{v.smtpReady ? 'Até 10 destinatários' : 'O servidor de e-mail ainda não foi configurado pelo administrador da plataforma'}</p>
            </div>
            <Switch checked={f.email.enabled} onChange={(enabled) => setF({ ...f, email: { ...f.email, enabled } })} />
          </div>
          <div className="mt-4 flex flex-wrap gap-1.5">
            {f.email.recipients.map((e) => (
              <span key={e} className="inline-flex items-center gap-1 rounded-lg bg-surface-2 py-1 pl-2.5 pr-1 text-sm">
                {e}
                <button className="grid size-5 place-items-center rounded text-muted hover:text-danger" aria-label={`Remover ${e}`}
                  onClick={() => setF({ ...f, email: { ...f.email, recipients: f.email.recipients.filter((x) => x !== e) } })}><X className="size-3.5" /></button>
              </span>
            ))}
          </div>
          <div className="mt-3 flex gap-2">
            <Input type="email" value={email} placeholder="nome@empresa.com.br" onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addEmail(); } }} />
            <Button variant="secondary" icon={<Plus className="size-4" />} onClick={addEmail} disabled={f.email.recipients.length >= 10}>Adicionar</Button>
          </div>
        </Card>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" loading={busy === 'save'} disabled={!dirty || !!busy} onClick={() => save()}>Salvar alertas</Button>
        <Button variant="ghost" loading={busy === 'test'} disabled={!!busy} icon={<Send className="size-4" />} onClick={test}>Enviar teste agora</Button>
        {dirty && <span className="text-xs text-faint">Alterações não salvas</span>}
      </div>

      {v.deliveries.length > 0 && (
        <Card className="overflow-hidden">
          <h3 className="border-b border-line px-5 py-3 font-display font-semibold">Últimos envios</h3>
          <ul className="divide-y divide-line">
            {v.deliveries.map((d) => (
              <li key={d.id} className="flex items-start gap-3 px-5 py-2.5 text-sm">
                {d.status === 'ok' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" /> : <XCircle className="mt-0.5 size-4 shrink-0 text-danger" />}
                <div className="min-w-0 flex-1">
                  <p className="truncate">{d.channel === 'email' ? 'E-mail' : 'Telegram'} · {d.target}{d.test && <span className="text-faint"> · teste</span>}</p>
                  {d.error && <p className="text-xs text-danger">{d.error}</p>}
                </div>
                <span className="whitespace-nowrap text-xs text-faint tnum">{new Date(d.createdAt).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
