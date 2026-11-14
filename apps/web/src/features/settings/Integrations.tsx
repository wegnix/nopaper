import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { BookOpen, KeyRound, Pencil, Plus, Send, ShieldAlert, Trash2, Webhook } from 'lucide-react';
import {
  ALL_PERMISSIONS, API_RATE_LIMIT_MAX, API_RATE_LIMIT_MIN, API_RATE_LIMIT_PER_MINUTE, INTEGRATION_PERMISSIONS, INTEGRATION_READ_PERMISSIONS, INTEGRATION_WRITE_PERMISSIONS, PERMISSIONS,
  WEBHOOK_GROUPS, WEBHOOK_GROUP_KEYS, WEBHOOK_GIVE_UP_HOURS,
  billTerms, isIpOrCidr, permissionRequires, withRequired, type ApiTokenInfo, type Permission, type WebhookGroup,
} from '@nopaper/shared';
import { Button, Card, Checkbox, Empty, Field, IconButton, Input, Textarea, Tooltip } from '@/components/ui/base';
import { DatePicker } from '@/components/ui/date-picker';
import { Dialog, SaveFooter, useConfirm, useFormState } from '@/components/ui/dialog';
import { CopyButton } from '@/features/bills/attachments';
import { del, get, post, put, errMsg } from '@/lib/api';
import { useCan, useOrg, useSession } from '@/lib/session';
import { cn } from '@/lib/utils';

type Def = { group: string; label: string; hint?: string };
/** Permissões que um token pode ter, agrupadas como na tela de Grupos. */
const byGroup = INTEGRATION_PERMISSIONS.reduce<Record<string, Array<[Permission, Def]>>>((acc, p) => {
  const d = PERMISSIONS[p] as Def;
  (acc[d.group] ??= []).push([p, d]);
  return acc;
}, {});
const dependents = (p: Permission) => ALL_PERMISSIONS.filter((x) => permissionRequires(x).includes(p));
const PRESETS: Array<{ label: string; perms: Permission[] }> = [
  { label: 'Só leitura', perms: INTEGRATION_READ_PERMISSIONS },
  { label: 'Leitura e escrita', perms: INTEGRATION_WRITE_PERMISSIONS },
];

const apiBase = () => `${window.location.origin}/api/v1`;
const dateBR = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/');
const when = (iso: string) => new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const splitIps = (text: string) => text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);

function useTokens() {
  const orgId = useSession((s) => s.orgId);
  return useQuery({ queryKey: ['api-tokens', orgId], queryFn: () => get<{ items: ApiTokenInfo[] }>('/api/integrations/tokens').then((r) => r.items) });
}

/** O token recém-criado: aparece uma vez só. */
function Secret({ token }: { token: string }) {
  return (
    <div className="rounded-xl border border-accent/40 bg-accent-soft p-4">
      <p className="text-sm font-semibold text-ink">Copie o token agora</p>
      <p className="mt-0.5 text-xs text-muted">Ele não será mostrado de novo. O NoPaper guarda só uma marca para conferir; se perder, crie outro e apague este.</p>
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
        <code className="min-w-0 flex-1 break-all font-mono text-[13px] text-ink">{token}</code>
        <CopyButton text={token} label="Copiar token" toastMsg="Token copiado" />
      </div>
      <p className="mt-2 text-xs text-muted">Envie em toda chamada no cabeçalho <code className="font-mono">Authorization: Bearer {'<token>'}</code>.</p>
    </div>
  );
}

/**
 * Webhook do token: grava na hora, separado do Salvar do token (o segredo da assinatura só aparece
 * quando é criado ou trocado).
 */
function WebhookSection({ token, onChange }: { token: ApiTokenInfo; onChange: (t: ApiTokenInfo) => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const orgKind = useOrg()?.kind;
  const hook = token.webhook;
  const [url, setUrl] = useState(hook?.url ?? '');
  const [groups, setGroups] = useState<Set<WebhookGroup>>(new Set(hook?.groups ?? []));
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const dirty = url.trim() !== (hook?.url ?? '') || [...groups].sort().join() !== [...(hook?.groups ?? [])].sort().join();
  const refresh = (t: ApiTokenInfo) => { qc.invalidateQueries({ queryKey: ['api-tokens'] }); onChange(t); };
  const save = async () => {
    setBusy('save');
    try {
      const r = await put<ApiTokenInfo & { webhookSecret?: string }>(`/api/integrations/tokens/${token.id}/webhook`, { url: url.trim(), groups: [...groups] });
      const { webhookSecret, ...info } = r;
      if (webhookSecret) setSecret(webhookSecret);
      toast.success('Webhook salvo'); refresh(info);
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(null); }
  };
  const test = async () => {
    setBusy('test');
    try {
      const r = await post<{ ok: boolean; error: string | null }>(`/api/integrations/tokens/${token.id}/webhook/test`, {});
      if (r.ok) toast.success('O destino recebeu o evento de teste (ping)'); else toast.error(`O teste falhou: ${r.error ?? 'sem resposta'}`);
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(null); }
  };
  const newSecret = async () => {
    if (!(await confirm({ title: 'Gerar outro segredo?', body: 'O segredo atual para de valer na hora: o sistema que recebe precisa ser atualizado com o novo para conferir a assinatura.', confirmLabel: 'Gerar outro' }))) return;
    try { setSecret((await post<{ webhookSecret: string }>(`/api/integrations/tokens/${token.id}/webhook/secret`, {})).webhookSecret); } catch (e) { toast.error(errMsg(e)); }
  };
  const remove = async () => {
    if (!(await confirm({ title: 'Remover o webhook?', body: 'O NoPaper para de enviar eventos para esse endereço. A fila de eventos da API continua disponível.', confirmLabel: 'Remover', tone: 'danger' }))) return;
    try { const t = await del<ApiTokenInfo>(`/api/integrations/tokens/${token.id}/webhook`); setUrl(''); setGroups(new Set()); setSecret(null); refresh(t); } catch (e) { toast.error(errMsg(e)); }
  };
  return (
    <section className="rounded-xl border border-line p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Webhook className="size-4 text-accent" />
        <h3 className="text-sm font-semibold">Webhook</h3>
        <span className="text-xs text-faint">opcional</span>
        {hook?.status === 'ok' && <span className="ml-auto rounded-md bg-ok/10 px-1.5 py-0.5 text-[11px] font-semibold text-ok">Entregando{hook.lastAt ? ` · último envio ${when(hook.lastAt)}` : ''}</span>}
        {hook?.status === 'failing' && <span className="ml-auto rounded-md bg-warn/10 px-1.5 py-0.5 text-[11px] font-semibold text-warn">Falhando, tentando de novo</span>}
        {hook?.status === 'stopped' && <span className="ml-auto rounded-md bg-danger/10 px-1.5 py-0.5 text-[11px] font-semibold text-danger">Pausado</span>}
      </div>
      <p className="mt-1 text-xs text-muted">O NoPaper avisa esse endereço a cada mudança que o token pode ver. Serve para sistemas que recebem chamadas da internet; quem não recebe consulta a fila de eventos da API.</p>
      {hook?.error && (
        <p className="mt-2 rounded-lg bg-danger/5 px-3 py-2 text-xs text-ink">
          {hook.status === 'stopped' ? `Pausado depois de ${WEBHOOK_GIVE_UP_HOURS} h de falhas. Corrija o destino e salve de novo para retomar de onde parou. ` : ''}Última falha: {hook.error}
        </p>
      )}
      {secret && (
        <div className="mt-3 rounded-lg border border-accent/40 bg-accent-soft p-3">
          <p className="text-xs font-semibold text-ink">Segredo da assinatura: copie agora, não será mostrado de novo</p>
          <div className="mt-2 flex items-center gap-2 rounded-lg border border-line bg-surface px-3 py-2">
            <code className="min-w-0 flex-1 break-all font-mono text-[13px] text-ink">{secret}</code>
            <CopyButton text={secret} label="Copiar segredo" toastMsg="Segredo copiado" />
          </div>
        </div>
      )}
      <div className="mt-3 flex flex-col gap-3">
        <Field label="Endereço que recebe os eventos" hint="Precisa ser https. Cada envio vai assinado no cabeçalho X-NoPaper-Signature.">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://sistema.exemplo.com/nopaper/eventos" inputMode="url" maxLength={500} />
        </Field>
        <div>
          <p className="mb-1.5 text-[13px] font-medium text-ink">Quais eventos enviar</p>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <Checkbox checked={groups.size === 0} onChange={(v) => v && setGroups(new Set())} label={<span className="text-sm">Todos</span>} />
            {WEBHOOK_GROUP_KEYS.map((g) => (
              <Checkbox key={g} checked={groups.has(g)} label={<span className="text-sm">{billTerms(WEBHOOK_GROUPS[g].label, orgKind)}</span>}
                onChange={(v) => { const s = new Set(groups); if (v) s.add(g); else s.delete(g); setGroups(s); }} />
            ))}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary" loading={busy === 'save'} disabled={!url.trim() || (!dirty && hook?.status !== 'stopped')} onClick={save}>{hook ? (hook.status === 'stopped' && !dirty ? 'Retomar envios' : 'Salvar webhook') : 'Ligar webhook'}</Button>
          {hook && <Button variant="ghost" icon={<Send className="size-4" />} loading={busy === 'test'} disabled={dirty} onClick={test}>Enviar teste</Button>}
          {hook && <Button variant="ghost" onClick={newSecret}>Gerar outro segredo</Button>}
          {hook && <Button variant="ghost" className="text-danger" onClick={remove}>Remover</Button>}
        </div>
      </div>
    </section>
  );
}

function TokenForm({ token, onClose, onSaved }: { token: Partial<ApiTokenInfo>; onClose: () => void; onSaved: (t: ApiTokenInfo) => void }) {
  const qc = useQueryClient();
  const org = useOrg();
  const can = useCan();
  const iAmAdmin = !!org?.isAdmin;
  const [f, setF, form] = useFormState({
    name: token.name ?? '', expiresAt: token.expiresAt ?? '', ips: (token.allowedIps ?? []).join('\n'), permissions: new Set(token.permissions ?? []),
    rate: token.rateLimit ? String(token.rateLimit) : '',
  });
  const [busy, setBusy] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const grantable = (p: Permission) => iAmAdmin || can(p) || !!token.permissions?.includes(p);
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
    set(new Set(withRequired(s).filter((p) => INTEGRATION_PERMISSIONS.includes(p) && (s.has(p) || grantable(p)))));
  };
  const ips = splitIps(f.ips);
  const badIp = ips.find((ip) => !isIpOrCidr(ip));
  const rate = f.rate.trim() ? Number(f.rate) : null;
  const badRate = rate !== null && (!Number.isInteger(rate) || rate < API_RATE_LIMIT_MIN || rate > API_RATE_LIMIT_MAX);
  const save = async () => {
    setBusy(true);
    const body = { name: f.name, permissions: [...f.permissions], allowedIps: ips, expiresAt: f.expiresAt || null, rateLimit: rate };
    try {
      const saved = token.id
        ? await put<ApiTokenInfo>(`/api/integrations/tokens/${token.id}`, body)
        : await post<ApiTokenInfo & { token: string }>('/api/integrations/tokens', body);
      if ('token' in saved && typeof saved.token === 'string') setSecret(saved.token);
      qc.invalidateQueries({ queryKey: ['api-tokens'] });
      toast.success(token.id ? 'Token salvo' : 'Token criado');
      form.markSaved(f); onSaved(saved);
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const count = f.permissions.size;
  return (
    <Dialog open onClose={onClose} dirty={form.dirty} size="xl" title={token.id ? `Integração ${token.name}` : 'Novo token de integração'}
      description="O token dá a outro sistema acesso a este espaço pela API, só com o que você marcar aqui."
      footer={<SaveFooter dirty={form.dirty} isNew={!token.id} saving={busy} canSave={!!f.name.trim() && !badIp && !badRate} saveLabel={token.id ? 'Salvar' : 'Criar token'} onSave={save} onClose={onClose}
        left={<span className="mr-auto text-xs text-muted">{count === 0 ? 'Nenhuma permissão: o token só testa a conexão' : `${count} de ${INTEGRATION_PERMISSIONS.length} permissões`}</span>} />}>
      <div className="flex flex-col gap-5">
        {secret && <Secret token={secret} />}
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Nome" hint="Qual sistema vai usar. Aparece na auditoria como “Integração <nome>”.">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Ex.: ERP, BI, sistema interno" maxLength={64} autoFocus={!token.id} />
          </Field>
          <Field label="Validade" hint="Último dia em que o token funciona. Em branco = sem validade.">
            <DatePicker value={f.expiresAt} onChange={(expiresAt) => setF({ ...f, expiresAt })} clearable placeholder="Sem validade" />
          </Field>
          <Field label="Chamadas por minuto" error={badRate ? `Use um número inteiro de ${API_RATE_LIMIT_MIN} a ${API_RATE_LIMIT_MAX.toLocaleString('pt-BR')}` : null}
            hint={`Em branco = ${API_RATE_LIMIT_PER_MINUTE} (o padrão). Aumente para uma carga grande, como uma migração, e volte depois.`}>
            <Input inputMode="numeric" className="tnum" value={f.rate} onChange={(e) => setF({ ...f, rate: e.target.value.replace(/\D/g, '').slice(0, 5) })} placeholder={String(API_RATE_LIMIT_PER_MINUTE)} />
          </Field>
        </div>
        <Field label="Endereços IP aceitos" error={badIp ? `“${badIp}” não é um IP nem uma faixa válida` : null}
          hint="Opcional. Um por linha: IP (203.0.113.10) ou faixa (203.0.113.0/24). Em branco, o token funciona de qualquer lugar.">
          <Textarea value={f.ips} onChange={(e) => setF({ ...f, ips: e.target.value })} rows={2} className="font-mono text-[13px]" placeholder="Qualquer endereço" />
        </Field>
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-muted">Começar de um modelo:</span>
          {PRESETS.map((p) => (
            <button key={p.label} type="button" onClick={() => set(new Set(p.perms.filter(grantable)))} className="rounded-md border border-line px-2 py-1 font-medium text-muted transition-colors hover:border-accent hover:text-accent pointer-coarse:px-3 pointer-coarse:py-2">{p.label}</button>
          ))}
          <button type="button" onClick={() => set(new Set())} className="rounded-md px-2 py-1 font-medium text-faint hover:text-danger pointer-coarse:px-3 pointer-coarse:py-2">Limpar tudo</button>
        </div>
        <div className="grid gap-4 md:grid-cols-2">
          {Object.entries(byGroup).map(([g, perms]) => {
            const keys = perms.map(([p]) => p);
            const on = keys.filter((p) => f.permissions.has(p)).length;
            return (
              <section key={g} className="rounded-xl border border-line p-3.5">
                <div className="mb-2.5 flex items-center gap-2">
                  <Checkbox checked={on === keys.length} indeterminate={on > 0 && on < keys.length} disabled={!keys.some(grantable)} onChange={(v) => toggleSection(keys, v)}
                    label={<span className="text-[13px] font-semibold">{billTerms(g, org?.kind)}</span>} />
                  <span className="ml-auto text-[11px] text-faint tnum">{on}/{keys.length}</span>
                </div>
                <div className="flex flex-col gap-2.5 pl-1">
                  {perms.map(([p, d]) => {
                    const locked = !grantable(p);
                    return (
                      <Tooltip key={p} content={locked ? 'Você não tem esta permissão, então não pode concedê-la.' : null} side="left">
                        <div className={cn(locked && 'opacity-50')}>
                          <Checkbox checked={f.permissions.has(p)} disabled={locked} onChange={(v) => toggle(p, v)}
                            label={<span className="flex flex-col"><span className="text-sm text-ink">{billTerms(d.label, org?.kind)}</span><span className="font-mono text-[11px] text-faint">{p}</span></span>} />
                        </div>
                      </Tooltip>
                    );
                  })}
                </div>
              </section>
            );
          })}
        </div>
        {f.permissions.has('bills.view_restricted') && (
          <p className="flex items-start gap-2 rounded-lg bg-warn/10 px-3 py-2 text-xs text-ink">
            <ShieldAlert className="mt-0.5 size-4 shrink-0 text-warn" />
            Com “categorias restritas”, o sistema que usar este token enxerga salários, pró-labore e o que mais estiver nessas categorias.
          </p>
        )}
        <p className="text-xs text-faint">Membros, grupos, dados do espaço, alertas e a criação de tokens ficam fora do alcance de qualquer token: só pela tela, com uma pessoa logada.</p>
        {token.id && <WebhookSection token={token as ApiTokenInfo} onChange={onSaved} />}
      </div>
    </Dialog>
  );
}

export function IntegrationsPage() {
  const orgKind = useOrg()?.kind;
  const { data = [], isLoading } = useTokens();
  const [editing, setEditing] = useState<Partial<ApiTokenInfo> | null>(null);
  const confirm = useConfirm();
  const qc = useQueryClient();
  const revoke = async (t: ApiTokenInfo) => {
    if (!(await confirm({ title: `Revogar o token "${t.name}"?`, body: 'O sistema que usa este token perde o acesso na hora. Não dá para desfazer: seria preciso criar outro token.', confirmLabel: 'Revogar', tone: 'danger' }))) return;
    try { await del(`/api/integrations/tokens/${t.id}`); qc.invalidateQueries({ queryKey: ['api-tokens'] }); toast.success('Token revogado'); } catch (e) { toast.error(errMsg(e)); }
  };
  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-line p-5">
        <div className="min-w-0">
          <h2 className="font-display text-lg font-semibold">Integrações</h2>
          <p className="text-sm text-muted">Tokens para outros sistemas lerem e gravarem neste espaço pela API.</p>
        </div>
        <Button variant="primary" icon={<Plus className="size-4" />} onClick={() => setEditing({})}>Novo token</Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line bg-surface-2/50 px-5 py-3 text-sm">
        <div className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-muted">Endereço da API</span>
          <code className="min-w-0 truncate font-mono text-[13px] text-ink">{apiBase()}</code>
          <CopyButton text={apiBase()} label="Copiar endereço" />
        </div>
        <a href="/api/v1/openapi.json" target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline">
          <BookOpen className="size-4" />Descrição da API (OpenAPI)
        </a>
        <span className="text-xs text-faint">{API_RATE_LIMIT_PER_MINUTE} chamadas por minuto por token, ajustável em cada um</span>
      </div>
      {!isLoading && data.length === 0 ? (
        <Empty icon={<KeyRound className="size-6" />} title="Nenhum token ainda">
          Crie um token para ligar outro sistema a este espaço. Você escolhe o que ele pode ler e gravar.
        </Empty>
      ) : (
        <ul className="divide-y divide-line">
          {data.map((t) => (
            <li key={t.id} className="flex items-start gap-4 px-5 py-4">
              <span className={cn('mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg', t.expired ? 'bg-danger/10 text-danger' : 'bg-accent-soft text-accent')}><KeyRound className="size-4" /></span>
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
                  {t.name}
                  <code className="rounded-md bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-normal text-muted">{t.hint}…</code>
                  {t.expired && <span className="rounded-md bg-danger/10 px-1.5 py-0.5 text-[11px] font-semibold text-danger">Vencido</span>}
                  {t.webhook && <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold', t.webhook.status === 'stopped' ? 'bg-danger/10 text-danger' : t.webhook.status === 'failing' ? 'bg-warn/10 text-warn' : 'bg-surface-2 text-muted')}><Webhook className="size-3" />{t.webhook.status === 'stopped' ? 'Webhook pausado' : t.webhook.status === 'failing' ? 'Webhook falhando' : 'Webhook'}</span>}
                </p>
                <p className="mt-0.5 text-xs text-faint">
                  {t.lastUsedAt ? `Último uso em ${when(t.lastUsedAt)}${t.lastUsedIp ? ` · ${t.lastUsedIp}` : ''}` : 'Nunca usado'}
                  {' · '}{t.expiresAt ? `${t.expired ? 'venceu' : 'vale até'} ${dateBR(t.expiresAt)}` : 'sem validade'}
                  {t.rateLimit && t.rateLimit !== API_RATE_LIMIT_PER_MINUTE && ` · até ${t.rateLimit.toLocaleString('pt-BR')} chamadas/min`}
                  {t.allowedIps.length > 0 && ` · ${t.allowedIps.length === 1 ? `só de ${t.allowedIps[0]}` : `${t.allowedIps.length} endereços aceitos`}`}
                  {' · '}criado em {dateBR(t.createdAt)}{t.createdByName && ` por ${t.createdByName}`}
                </p>
                <div className="mt-1.5 flex flex-wrap gap-1">
                  {t.permissions.length === 0 && <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">Sem permissões</span>}
                  {Object.entries(byGroup).map(([sec, perms]) => {
                    const n = perms.filter(([p]) => t.permissions.includes(p)).length;
                    return n ? <span key={sec} className="rounded-md bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">{billTerms(sec, orgKind)} {n === perms.length ? '· tudo' : `${n}/${perms.length}`}</span> : null;
                  })}
                </div>
              </div>
              <IconButton label="Editar" onClick={() => setEditing(t)}><Pencil className="size-4" /></IconButton>
              <IconButton label="Revogar" tone="danger" onClick={() => revoke(t)}><Trash2 className="size-4" /></IconButton>
            </li>
          ))}
        </ul>
      )}
      {editing && <TokenForm token={editing} onClose={() => setEditing(null)} onSaved={setEditing} />}
    </Card>
  );
}
