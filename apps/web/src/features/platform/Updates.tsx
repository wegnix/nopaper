import { useEffect, useState } from 'react';
import { Navigate } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ArrowUpCircle, CheckCircle2, DatabaseBackup, Download, ExternalLink, Loader2, RefreshCw, XCircle } from 'lucide-react';
import { Button, Card, Checkbox, Spinner } from '@/components/ui/base';
import { Dialog } from '@/components/ui/dialog';
import { Markdown } from '@/components/ui/markdown';
import { api, errMsg, get, post } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn, downloadBlob } from '@/lib/utils';
import { when } from './common';

interface Release { version: string; name: string; notes: string; publishedAt: string; url: string; major: boolean }
interface UpdaterStatus { state: 'idle' | 'running' | 'done' | 'failed'; from: string | null; to: string | null; step: string | null; startedAt: string | null; finishedAt: string | null; error: string | null; log: string[] }
interface PreBackup { id: string; status: 'running' | 'ok' | 'error'; fileName: string | null; sizeBytes: number | null; remoteStatus: string; error: string | null; finishedAt: string | null; usable: boolean; validUntil: string | null }
interface View {
  current: string; repo: string; releases: Release[]; checkedAt: string; checkError: string | null;
  updater: { git: boolean; ref?: string; origin?: string; dirty?: boolean; error?: string; originMatches: boolean } | null;
  status: UpdaterStatus | null; backup: PreBackup | null; busy: string | null;
}

const mb = (n: number | null) => (n == null ? '' : n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(0.1, n / 1e6).toFixed(1)} MB`);

export function UpdatesPage() {
  const me = useSession((s) => s.user);
  const qc = useQueryClient();
  const [target, setTarget] = useState<Release | null>(null);
  const [checking, setChecking] = useState(false);
  const q = useQuery({
    queryKey: ['system', 'updates'], queryFn: () => get<View>('/api/system/updates'), enabled: !!me?.isSuperadmin,
    refetchInterval: (qq) => (qq.state.data?.status?.state === 'running' || qq.state.data?.backup?.status === 'running' ? 3000 : false),
  });
  if (!me?.isSuperadmin) return <Navigate to="/config/perfil" replace />;
  if (!q.data) return <div className="grid place-items-center py-16"><Spinner /></div>;
  const v = q.data;
  const running = v.status?.state === 'running';

  const check = async () => {
    setChecking(true);
    try { await post('/api/system/updates/check'); await qc.invalidateQueries({ queryKey: ['system', 'updates'] }); }
    catch (e) { toast.error(errMsg(e)); } finally { setChecking(false); }
  };

  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted">Novas versões publicadas no GitHub ({v.repo}). A atualização é feita aqui mesmo, sempre depois de um backup completo.</p>

      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-4">
          <span className="grid size-11 place-items-center rounded-xl bg-accent/15 text-accent"><ArrowUpCircle className="size-6" /></span>
          <div className="mr-auto">
            <p className="text-xs text-faint">Versão instalada</p>
            <p className="font-display text-2xl font-semibold tnum">v{v.current}</p>
          </div>
          <div className="text-right text-xs text-faint">
            <p>Verificado {when(v.checkedAt)}</p>
            <Button variant="ghost" size="sm" className="mt-1" icon={<RefreshCw className={cn('size-4', checking && 'animate-spin')} />} onClick={check} disabled={checking}>Verificar agora</Button>
          </div>
        </div>
        {v.checkError && <p className="mt-4 rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm text-ink">{v.checkError}</p>}
        <UpdaterNotice v={v} />
      </Card>

      {v.status && v.status.state !== 'idle' && <ProgressCard status={v.status} current={v.current} />}

      {v.releases.length === 0 ? (
        v.checkError ? null : (
          <Card className="p-8 text-center">
            <CheckCircle2 className="mx-auto size-8 text-ok" />
            <p className="mt-3 font-medium">O NoPaper está na versão mais recente.</p>
          </Card>
        )
      ) : (
        <div className="flex flex-col gap-4">
          {v.releases.map((r, i) => (
            <Card key={r.version} className="p-5">
              <div className="flex flex-wrap items-start gap-3">
                <div className="mr-auto">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-display text-lg font-semibold">{r.name}</h3>
                    {i === 0 && <span className="rounded-md bg-accent-soft px-1.5 py-0.5 text-[11px] font-medium text-accent">mais recente</span>}
                    {r.major && <span className="inline-flex items-center gap-1 rounded-md bg-warn/15 px-1.5 py-0.5 text-[11px] font-medium text-warn"><AlertTriangle className="size-3" /> versão maior: leia antes</span>}
                  </div>
                  <p className="mt-0.5 text-xs text-faint">publicada em {when(r.publishedAt)} · <a href={r.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-0.5 hover:text-ink">ver no GitHub <ExternalLink className="size-3" /></a></p>
                </div>
                {i === 0 && (
                  <Button variant="primary" icon={<ArrowUpCircle className="size-4" />} disabled={running || !v.updater?.git || !!v.updater?.dirty} onClick={() => setTarget(r)}>
                    Atualizar para {r.version}
                  </Button>
                )}
              </div>
              <div className="mt-4 max-h-80 overflow-y-auto rounded-lg border border-line bg-surface-2/50 p-4">
                {r.notes.trim() ? <Markdown source={r.notes} /> : <p className="text-sm text-faint">Sem notas nesta versão.</p>}
              </div>
            </Card>
          ))}
          {v.releases.length > 1 && <p className="text-xs text-faint">A atualização vai direto para a mais recente e inclui as mudanças de todas as versões acima.</p>}
        </div>
      )}

      {target && <UpdateDialog release={target} view={v} onClose={() => setTarget(null)} />}
    </div>
  );
}

function UpdaterNotice({ v }: { v: View }) {
  const u = v.updater;
  const box = 'mt-4 flex items-start gap-2 rounded-lg border p-3 text-sm';
  if (!u) return (
    <div className={cn(box, 'border-line bg-surface-2/60 text-muted')}>
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
      <span>O serviço de atualização (<code>updater</code>) não está rodando nesta instalação, então a atualização pela interface está desligada. Atualize pela linha de comando ou ative o serviço (guia de publicação, seção "Atualizar").</span>
    </div>
  );
  if (!u.git) return <div className={cn(box, 'border-warn/40 bg-warn/10 text-ink')}><AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" /><span>{u.error}</span></div>;
  if (u.dirty) return <div className={cn(box, 'border-warn/40 bg-warn/10 text-ink')}><AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" /><span>Há arquivos do projeto alterados no servidor (<code>git status</code>). Desfaça as alterações locais para poder atualizar.</span></div>;
  if (!u.originMatches) return <div className={cn(box, 'border-warn/40 bg-warn/10 text-ink')}><AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" /><span>A instalação foi baixada de <code>{u.origin}</code>, mas as versões são consultadas em <code>{v.repo}</code>. Ajuste <code>UPDATE_REPO</code> no <code>.env</code> se você usa um fork.</span></div>;
  return <p className="mt-4 text-xs text-faint">Atualizador pronto · código em <code>{u.ref}</code></p>;
}

// ------------------------------------------------------------------ diálogo: backup → confirmar → atualizar
function UpdateDialog({ release, view, onClose }: { release: Release; view: View; onClose: () => void }) {
  const qc = useQueryClient();
  const [read, setRead] = useState(false);
  const [majorOk, setMajorOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const b = view.backup;
  const backingUp = b?.status === 'running';
  const backupOk = !!b?.usable;

  const doBackup = async () => {
    try { await post('/api/system/updates/backup'); toast.info('Backup completo iniciado'); qc.invalidateQueries({ queryKey: ['system', 'updates'] }); }
    catch (e) { toast.error(errMsg(e)); }
  };
  const apply = async () => {
    if (!b) return;
    setBusy(true);
    try {
      await post('/api/system/updates/apply', { version: release.version, backupRunId: b.id, confirm: true });
      toast.success(`Atualização para ${release.version} iniciada`);
      qc.invalidateQueries({ queryKey: ['system', 'updates'] });
      onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Dialog open onClose={onClose} size="lg" title={`Atualizar para ${release.version}`}
      description={`De v${view.current} para ${release.version}. Durante a atualização o sistema fica fora do ar por alguns instantes.`}
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancelar</Button>
        <Button variant="primary" loading={busy} disabled={!backupOk || !read || (release.major && !majorOk)} onClick={apply}>Atualizar agora</Button>
      </>}>
      <div className="flex flex-col gap-5">
        <section>
          <p className="mb-2 text-sm font-semibold">1. Backup completo (obrigatório)</p>
          <div className="rounded-lg border border-line bg-surface-2/50 p-4 text-sm">
            {backingUp ? (
              <p className="flex items-center gap-2 text-muted"><Loader2 className="size-4 animate-spin" /> Fazendo o backup do banco e de todos os anexos…</p>
            ) : backupOk ? (
              <div className="flex flex-wrap items-center gap-3">
                <CheckCircle2 className="size-5 text-ok" />
                <div className="mr-auto">
                  <p className="font-medium text-ink">{b!.fileName} <span className="font-normal text-faint">· {mb(b!.sizeBytes)}</span></p>
                  <p className="text-xs text-faint">
                    Feito {when(b!.finishedAt!)} · vale até {new Date(b!.validUntil!).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                    {b!.remoteStatus === 'ok' ? ' · cópia remota enviada' : b!.remoteStatus === 'error' ? ' · a cópia remota falhou' : ' · sem cópia remota'}
                  </p>
                </div>
                <a href={`/api/system/backups/${encodeURIComponent(b!.fileName!)}`} onClick={(e) => { e.preventDefault(); void download(b!.fileName!); }}
                  className="inline-flex items-center gap-1 text-sm text-accent hover:underline"><Download className="size-4" /> Baixar uma cópia</a>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <DatabaseBackup className="size-5 text-faint" />
                <p className="mr-auto text-muted">
                  {b?.status === 'error' ? <span className="text-danger">O último backup falhou: {b.error}</span> : 'Antes de atualizar, faça um backup completo agora (banco + anexos). Ele vale por 1 hora.'}
                </p>
                <Button variant="secondary" icon={<DatabaseBackup className="size-4" />} onClick={doBackup} disabled={!!view.busy}>Fazer backup completo</Button>
              </div>
            )}
          </div>
          {backupOk && b!.remoteStatus !== 'ok' && <p className="mt-2 text-xs text-faint">Recomendado: baixe a cópia acima ou configure um destino remoto, para ter o backup fora deste servidor.</p>}
        </section>

        <section>
          <p className="mb-2 text-sm font-semibold">2. O que muda</p>
          <div className="max-h-56 overflow-y-auto rounded-lg border border-line bg-surface-2/50 p-4">
            {release.notes.trim() ? <Markdown source={release.notes} /> : <p className="text-sm text-faint">Sem notas nesta versão.</p>}
          </div>
          <div className="mt-3 flex flex-col gap-2">
            <Checkbox checked={read} onChange={setRead} label="Li as mudanças desta versão" />
            {release.major && <Checkbox checked={majorOk} onChange={setMajorOk} label={<span className="text-warn">É uma versão maior: fiz o que as notas pedem antes de atualizar</span>} />}
          </div>
        </section>
      </div>
    </Dialog>
  );
}

async function download(name: string) {
  try {
    const r = await api<Response>('GET', `/api/system/backups/${encodeURIComponent(name)}`, undefined, { raw: true });
    downloadBlob(await r.blob(), name);
  } catch (e) { toast.error(errMsg(e)); }
}

// ------------------------------------------------------------------ andamento
function ProgressCard({ status, current }: { status: UpdaterStatus; current: string }) {
  const [restarting, setRestarting] = useState(false);
  // enquanto a API reinicia ela some por alguns segundos: consulta a saúde até voltar
  useEffect(() => {
    if (status.state !== 'running') return;
    const t = setInterval(async () => {
      const ok = await fetch('/api/health').then((r) => r.ok).catch(() => false);
      setRestarting(!ok);
    }, 3000);
    return () => clearInterval(t);
  }, [status.state]);
  const done = status.state === 'done' && status.to?.replace(/^v/, '') === current;
  return (
    <Card className={cn('p-5', status.state === 'failed' && 'border-danger/50')}>
      <div className="flex items-center gap-3">
        {status.state === 'running' ? <Loader2 className="size-5 animate-spin text-accent" /> : status.state === 'failed' ? <XCircle className="size-5 text-danger" /> : <CheckCircle2 className="size-5 text-ok" />}
        <div className="mr-auto">
          <p className="font-medium">
            {status.state === 'running' ? `Atualizando ${status.from} → ${status.to}` : status.state === 'failed' ? `A atualização para ${status.to} falhou` : done ? `Atualizado para ${status.to}` : `Atualização para ${status.to} concluída`}
          </p>
          <p className="text-xs text-faint">{restarting ? 'Reiniciando o sistema… a página volta sozinha.' : status.step}{status.finishedAt && ` · ${when(status.finishedAt)}`}</p>
        </div>
        {status.state === 'done' && !done && <Button variant="primary" onClick={() => window.location.reload()}>Recarregar</Button>}
      </div>
      {status.error && <p className="mt-3 rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-ink">{status.error}</p>}
      {status.log.length > 0 && (
        <details className="mt-3" open={status.state !== 'done'}>
          <summary className="cursor-pointer text-xs text-muted">Registro da atualização</summary>
          <pre className="mt-2 max-h-64 overflow-auto rounded-lg bg-[#0b0f19] p-3 font-mono text-[11px] leading-relaxed text-[#c9d1e4]">{status.log.slice(-120).join('\n')}</pre>
        </details>
      )}
    </Card>
  );
}
