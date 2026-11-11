import { LogoLoader, PixelSpinner } from '@/components/brand/Brand';
import { useEffect, useState } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ArchiveRestore, CheckCircle2, Clock, Cloud, Download, HardDrive, History, Play, Settings2, Trash2, XCircle } from 'lucide-react';
import { Button, Card, Field, IconButton, Input, Segmented, Select, Spinner, Switch, Textarea } from '@/components/ui/base';
import { useConfirm } from '@/components/ui/dialog';
import { api, errMsg, get, post, put } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn, downloadBlob } from '@/lib/utils';
import { ConfirmRestore, RestoreCard } from '@/features/settings/Restore';
import { BackupBrowser, TRIGGER, backupWhen, fileSize, type BackupFile } from './BackupBrowser';
import { secretHint, useSystemSettings, when, type Run, type SystemView } from './common';

type Tab = 'arquivos' | 'restaurar' | 'historico' | 'configuracao';
interface BackupsList { files: BackupFile[]; runs: Run[]; safetyFiles: string[]; busy: string | null }

export function useBackups() {
  return useQuery({
    queryKey: ['system', 'backups'], queryFn: () => get<BackupsList>('/api/system/backups'),
    refetchInterval: (q) => (q.state.data?.runs.some((x) => x.status === 'running') ? 2000 : false),
  });
}

export function BackupsPage() {
  const me = useSession((s) => s.user);
  const q = useSystemSettings();
  const list = useBackups();
  const [sp, setSp] = useSearchParams();
  const tab = (['arquivos', 'restaurar', 'historico', 'configuracao'].includes(sp.get('aba') ?? '') ? sp.get('aba') : 'arquivos') as Tab;
  const setTab = (t: Tab) => setSp(t === 'arquivos' ? {} : { aba: t }, { replace: true });
  if (!me?.isSuperadmin) return <Navigate to="/config/perfil" replace />;
  if (!q.data) return <div className="grid place-items-center py-16"><Spinner /></div>;
  return (
    <div className="flex flex-col gap-5">
      <Summary v={q.data.backup} list={list.data} onConfig={() => setTab('configuracao')} />
      <Segmented value={tab} onChange={setTab} options={[
        { value: 'arquivos', label: <span className="inline-flex items-center gap-1.5"><HardDrive className="size-3.5" />Arquivos</span> },
        { value: 'restaurar', label: <span className="inline-flex items-center gap-1.5"><ArchiveRestore className="size-3.5" />Restaurar</span> },
        { value: 'historico', label: <span className="inline-flex items-center gap-1.5"><History className="size-3.5" />Histórico</span> },
        { value: 'configuracao', label: <span className="inline-flex items-center gap-1.5"><Settings2 className="size-3.5" />Configuração</span> },
      ]} />
      {tab === 'arquivos' && <FilesTab list={list.data} loading={list.isLoading} />}
      {tab === 'restaurar' && <RestoreCard remoteMode={q.data.backup.remote.mode} />}
      {tab === 'historico' && <HistoryTab />}
      {tab === 'configuracao' && <BackupConfig v={q.data.backup} />}
    </div>
  );
}

// ------------------------------------------------------------------ resumo
function Summary({ v, list, onConfig }: { v: SystemView['backup']; list?: BackupsList; onConfig: () => void }) {
  const qc = useQueryClient();
  const [starting, setStarting] = useState(false);
  const running = list?.runs.some((x) => x.status === 'running');
  const last = list?.runs.find((x) => x.status !== 'running');
  const lastOk = list?.runs.find((x) => x.status === 'ok');
  const total = (list?.files ?? []).reduce((a, f) => a + f.size, 0);
  const failing = last && (last.status === 'error' || last.remoteStatus === 'error');
  useEffect(() => { if (running) setStarting(false); }, [running]);
  const runNow = async () => {
    setStarting(true);
    try { await post('/api/system/backup/run'); setTimeout(() => qc.invalidateQueries({ queryKey: ['system', 'backups'] }), 400); }
    catch (e) { toast.error(errMsg(e)); setStarting(false); }
  };
  const remote = v.remote.mode === 'none' ? 'Só no servidor' : v.remote.mode === 'sftp' ? `SFTP · ${v.remote.sftp.host || '—'}` : `rclone · ${v.remote.rcloneTarget || '—'}`;
  return (
    <Card className="overflow-hidden">
      <div className="grid sm:grid-cols-2 xl:grid-cols-4 divide-line max-xl:[&>*:nth-child(n+3)]:border-t sm:max-xl:[&>*:nth-child(even)]:border-l xl:divide-x [&>*]:border-line">
        <Stat icon={failing ? <XCircle className="size-4 text-danger" /> : <CheckCircle2 className="size-4 text-ok" />} label="Último backup"
          value={lastOk ? backupWhen(lastOk.fileName ?? '') : 'Nenhum ainda'}
          sub={failing ? <span className="text-danger">a última execução falhou · veja o Histórico</span> : lastOk?.sizeBytes ? fileSize(lastOk.sizeBytes) : undefined} />
        <Stat icon={<Clock className="size-4 text-accent" />} label="Agendamento" value={v.enabled ? `Todo dia às ${String(v.hour).padStart(2, '0')}:00` : 'Desligado'}
          sub={<button type="button" className="text-accent hover:underline" onClick={onConfig}>{v.enabled ? 'alterar' : 'ligar agendamento'}</button>} />
        <Stat icon={<HardDrive className="size-4 text-accent" />} label="Neste servidor" value={`${list?.files.length ?? 0} ${list?.files.length === 1 ? 'arquivo' : 'arquivos'}`} sub={`${fileSize(total)} · mantém os últimos ${v.keepLocal}`} />
        <Stat icon={<Cloud className="size-4 text-accent" />} label="Cópia externa" value={remote} sub={v.remote.mode === 'none' ? <span className="inline-flex items-center gap-1 text-warn"><AlertTriangle className="size-3" />sem cópia fora do servidor</span> : v.remote.keepDays ? `apaga após ${v.remote.keepDays} dias` : 'nunca apaga'} />
      </div>
      <div className="flex flex-wrap items-center gap-3 border-t border-line px-4 py-3">
        {running
          ? <p className="mr-auto flex items-center gap-2 text-sm text-muted"><LogoLoader size={56} className="-my-1" label="Fazendo backup" />Fazendo o backup: banco de dados e anexos…</p>
          : <p className="mr-auto text-xs text-muted">Banco de dados completo + anexos, num .tar.gz verificado depois de criado.</p>}
        <Button variant="primary" disabled={running || starting} icon={running || starting ? <PixelSpinner className="size-4" /> : <Play className="size-4" />} onClick={runNow}>
          {running ? 'Fazendo backup…' : 'Fazer backup agora'}
        </Button>
      </div>
    </Card>
  );
}
function Stat({ icon, label, value, sub }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="p-4">
      <p className="flex items-center gap-1.5 text-xs text-muted">{icon}{label}</p>
      <p className="mt-1 truncate font-display text-[17px] font-semibold">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-faint">{sub}</p>}
    </div>
  );
}

// ------------------------------------------------------------------ arquivos
function FilesTab({ list, loading }: { list?: BackupsList; loading: boolean }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [target, setTarget] = useState<{ source: 'local'; name: string } | null>(null);
  const safety = new Set(list?.safetyFiles ?? []);
  const download = async (name: string) => {
    try { const res = await api<Response>('GET', `/api/system/backups/${name}`, undefined, { raw: true }); downloadBlob(await res.blob(), name); } catch (e) { toast.error(errMsg(e)); }
  };
  const remove = async (name: string) => {
    if (!(await confirm({ title: `Apagar o backup de ${backupWhen(name)}?`, body: 'O arquivo deste servidor é removido. Cópias no destino remoto não são afetadas.', tone: 'danger', confirmLabel: 'Apagar' }))) return;
    try { await api('DELETE', `/api/system/backups/${name}`); qc.invalidateQueries({ queryKey: ['system', 'backups'] }); toast.success('Backup apagado'); } catch (e) { toast.error(errMsg(e)); }
  };
  return (
    <Card className="p-5">
      <h2 className="font-display font-semibold">Backups neste servidor</h2>
      <p className="mb-4 text-xs text-muted">Os mais antigos saem sozinhos conforme a retenção. Baixe um arquivo para guardar fora daqui.</p>
      <BackupBrowser files={list?.files} loading={loading} empty="Nenhum backup ainda. Use “Fazer backup agora” ou ligue o agendamento."
        actions={(f) => <>
          <IconButton label="Baixar" onClick={() => download(f.name)}><Download className="size-4" /></IconButton>
          <IconButton label="Restaurar este backup" onClick={() => setTarget({ source: 'local', name: f.name })}><ArchiveRestore className="size-4" /></IconButton>
          <IconButton label="Apagar" tone="danger" onClick={() => remove(f.name)}><Trash2 className="size-4" /></IconButton>
        </>} />
      <ConfirmRestore target={target} safety={!!target && safety.has(target.name)} onClose={() => setTarget(null)} />
    </Card>
  );
}

// ------------------------------------------------------------------ histórico
function HistoryTab() {
  const [status, setStatus] = useState('');
  const [trigger, setTrigger] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['system', 'backup-runs', status, trigger], initialPageParam: '',
    queryFn: ({ pageParam }) => get<{ items: Run[]; nextBefore: string | null; total: number; failed: number }>(`/api/system/backup-runs?${new URLSearchParams({ ...(pageParam ? { before: pageParam } : {}), ...(status ? { status } : {}), ...(trigger ? { trigger } : {}) })}`),
    getNextPageParam: (last) => last.nextBefore ?? undefined,
    refetchInterval: (qq) => (qq.state.data?.pages[0]?.items.some((x) => x.status === 'running') ? 2000 : false),
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  const head = q.data?.pages[0];
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-line p-4">
        <div className="mr-auto">
          <h2 className="font-display font-semibold">Histórico de execuções</h2>
          {head && <p className="text-xs text-muted">{head.total} {head.total === 1 ? 'execução' : 'execuções'}{head.failed ? <> · <span className="text-danger">{head.failed} com falha</span></> : ' · nenhuma falha'}</p>}
        </div>
        <Select aria-label="Situação" className="h-9 w-auto text-sm" value={status} onChange={(e) => setStatus(e.target.value)}>
          <option value="">Todas as situações</option><option value="ok">Concluídos</option><option value="error">Com erro</option><option value="running">Em andamento</option>
        </Select>
        <Select aria-label="Origem" className="h-9 w-auto text-sm" value={trigger} onChange={(e) => setTrigger(e.target.value)}>
          <option value="">Todas as origens</option><option value="schedule">Agendados</option><option value="manual">Manuais</option><option value="pre_restore">Antes de restaurar</option><option value="pre_update">Antes de atualizar</option>
        </Select>
      </div>
      {q.isLoading ? <div className="grid place-items-center py-12"><Spinner /></div> : !rows.length ? (
        <p className="px-4 py-10 text-center text-sm text-faint">Nenhuma execução{status || trigger ? ' com estes filtros' : ' ainda'}.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted">
              <tr className="border-b border-line">
                <th className="px-4 py-2 font-medium">Início</th><th className="px-3 py-2 font-medium">Origem</th><th className="px-3 py-2 font-medium">Situação</th>
                <th className="px-3 py-2 font-medium text-right">Tamanho</th><th className="px-3 py-2 font-medium">Duração</th><th className="px-4 py-2 font-medium">Cópia externa</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((x) => {
                const secs = x.finishedAt ? Math.max(1, Math.round((Date.parse(x.finishedAt) - Date.parse(x.startedAt)) / 1000)) : null;
                return (
                  <tr key={x.id} className="border-b border-line/70 last:border-0 align-top">
                    <td className="px-4 py-2.5 whitespace-nowrap tnum">{when(x.startedAt)}</td>
                    <td className="px-3 py-2.5"><span className={cn('rounded-md px-1.5 py-0.5 text-[11px] font-medium', TRIGGER[x.trigger]?.tone)}>{TRIGGER[x.trigger]?.label ?? x.trigger}</span></td>
                    <td className="px-3 py-2.5">
                      {x.status === 'running' ? <span className="inline-flex items-center gap-1 text-accent"><PixelSpinner className="size-3.5" />em andamento</span>
                        : x.status === 'ok' ? <span className="inline-flex items-center gap-1 text-ok"><CheckCircle2 className="size-3.5" />ok</span>
                          : <span className="inline-flex items-center gap-1 text-danger"><XCircle className="size-3.5" />erro</span>}
                      {x.error && <p className="mt-0.5 max-w-md text-xs text-danger">{x.error}</p>}
                    </td>
                    <td className="px-3 py-2.5 text-right tnum text-muted whitespace-nowrap">{x.sizeBytes ? fileSize(x.sizeBytes) : '—'}</td>
                    <td className="px-3 py-2.5 tnum text-muted whitespace-nowrap">{secs === null ? '—' : secs < 60 ? `${secs}s` : `${Math.floor(secs / 60)}min ${secs % 60}s`}</td>
                    <td className="px-4 py-2.5 text-muted">{x.remoteStatus === 'ok' ? <span className="text-ok">enviada</span> : x.remoteStatus === 'error' ? <span className="text-danger">falhou</span> : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {q.hasNextPage && <div className="border-t border-line p-3 text-center"><Button size="sm" loading={q.isFetchingNextPage} onClick={() => q.fetchNextPage()}>Carregar mais</Button></div>}
    </Card>
  );
}

// ------------------------------------------------------------------ configuração
function BackupConfig({ v }: { v: SystemView['backup'] }) {
  const qc = useQueryClient();
  const r = v.remote;
  const [f, setF] = useState({
    enabled: v.enabled, hour: v.hour, keepLocal: v.keepLocal, includeUploads: v.includeUploads,
    remote: { mode: r.mode, rcloneTarget: r.rcloneTarget, keepDays: r.keepDays, rcloneConfig: '', sftp: { ...r.sftp, password: '', privateKey: '' } },
  });
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const payload = () => {
    const s = f.remote.sftp;
    return { ...f, remote: { ...f.remote, sftp: { host: s.host, port: s.port, user: s.user, path: s.path, password: s.password, privateKey: s.privateKey } } };
  };
  const save = async (silent = false) => {
    setBusy('save');
    try {
      await put('/api/system/backup', payload());
      setF({ ...f, remote: { ...f.remote, rcloneConfig: '', sftp: { ...f.remote.sftp, password: '', privateKey: '' } } });
      qc.invalidateQueries({ queryKey: ['system'] }); if (!silent) toast.success('Configuração de backup salva'); return true;
    } catch (e) { toast.error(errMsg(e)); return false; } finally { setBusy(null); }
  };
  const testRemote = async () => {
    if (!(await save(true))) return;
    setBusy('test');
    try { const t = await post<{ files: number }>('/api/system/backup/test-remote'); toast.success(`Destino acessível (${t.files} ${t.files === 1 ? 'item' : 'itens'} na pasta)`); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(null); }
  };
  const setS = (patch: Partial<typeof f.remote.sftp>) => setF({ ...f, remote: { ...f.remote, sftp: { ...f.remote.sftp, ...patch } } });

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start gap-3">
        <div className="mr-auto">
          <h2 className="font-display font-semibold">Agendamento e destino</h2>
          <p className="text-xs text-muted">Um backup por dia, no horário escolhido. Com cópia externa, o arquivo também vai para outro lugar.</p>
        </div>
        <Switch checked={f.enabled} onChange={(enabled) => setF({ ...f, enabled })} label={f.enabled ? 'Agendado' : 'Desligado'} />
      </div>

      <div className="mt-5 grid gap-4 sm:grid-cols-3">
        <Field label="Horário diário" hint="Fuso do servidor">
          <Select value={f.hour} onChange={(e) => setF({ ...f, hour: Number(e.target.value) })}>
            {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
          </Select>
        </Field>
        <Field label="Manter no servidor" hint="Os mais antigos são apagados">
          <Select value={f.keepLocal} onChange={(e) => setF({ ...f, keepLocal: Number(e.target.value) })}>
            {[3, 7, 14, 30, 60].map((n) => <option key={n} value={n}>Últimos {n}</option>)}
          </Select>
        </Field>
        <div className="flex items-end pb-2"><Switch checked={f.includeUploads} onChange={(includeUploads) => setF({ ...f, includeUploads })} label="Incluir anexos" /></div>
      </div>

      <div className="mt-6 border-t border-line pt-5">
        <p className="mb-3 text-sm font-medium">Cópia externa</p>
        <Segmented value={f.remote.mode} onChange={(mode) => setF({ ...f, remote: { ...f.remote, mode } })}
          options={[{ value: 'none', label: 'Só no servidor' }, { value: 'sftp', label: 'SFTP / SSH' }, { value: 'rclone', label: 'rclone (Drive, S3…)' }]} />
        {f.remote.mode === 'sftp' && (
          <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_100px_1fr]">
            <Field label="Servidor"><Input value={f.remote.sftp.host} onChange={(e) => setS({ host: e.target.value })} placeholder="backup.exemplo.com" /></Field>
            <Field label="Porta"><Input type="number" value={f.remote.sftp.port} onChange={(e) => setS({ port: Number(e.target.value) || 22 })} /></Field>
            <Field label="Usuário"><Input value={f.remote.sftp.user} autoComplete="off" onChange={(e) => setS({ user: e.target.value })} /></Field>
            <Field label="Pasta no servidor" className="sm:col-span-3"><Input value={f.remote.sftp.path} onChange={(e) => setS({ path: e.target.value })} /></Field>
            <Field label="Senha" hint={secretHint(r.sftp.hasPassword)}>
              <Input type="password" autoComplete="new-password" value={f.remote.sftp.password} onChange={(e) => setS({ password: e.target.value })} />
            </Field>
            <Field label="Ou chave privada (PEM)" className="sm:col-span-2" hint={secretHint(r.sftp.hasPrivateKey) ?? 'Preferível à senha. Sem frase-senha.'}>
              <Textarea value={f.remote.sftp.privateKey} onChange={(e) => setS({ privateKey: e.target.value })} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" className="font-mono text-xs" />
            </Field>
          </div>
        )}
        {f.remote.mode === 'rclone' && (
          <div className="mt-4 grid gap-3">
            <Field label="Conteúdo do rclone.conf" hint={secretHint(r.hasRcloneConfig) ?? 'Gere no seu computador com “rclone config” e cole aqui (fica cifrado).'}>
              <Textarea value={f.remote.rcloneConfig} onChange={(e) => setF({ ...f, remote: { ...f.remote, rcloneConfig: e.target.value } })} className="min-h-[110px] font-mono text-xs" placeholder={'[gdrive]\ntype = drive\n…'} />
            </Field>
            <Field label="Destino" hint="remoto:pasta"><Input value={f.remote.rcloneTarget} onChange={(e) => setF({ ...f, remote: { ...f.remote, rcloneTarget: e.target.value } })} placeholder="gdrive:Backups/nopaper" /></Field>
          </div>
        )}
        {f.remote.mode !== 'none' && (
          <div className="mt-3 grid gap-3 sm:grid-cols-[220px_1fr] items-end">
            <Field label="Apagar do destino após">
              <Select value={f.remote.keepDays} onChange={(e) => setF({ ...f, remote: { ...f.remote, keepDays: Number(e.target.value) } })}>
                {[7, 30, 90, 365].map((n) => <option key={n} value={n}>{n} dias</option>)}
                <option value={0}>Nunca apagar</option>
              </Select>
            </Field>
            <div className="pb-0.5"><Button variant="ghost" loading={busy === 'test'} disabled={!!busy} onClick={testRemote}>Testar conexão</Button></div>
          </div>
        )}
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        <Button variant="primary" loading={busy === 'save'} disabled={!!busy} onClick={() => save()}>Salvar</Button>
      </div>
    </Card>
  );
}
