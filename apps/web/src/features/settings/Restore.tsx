import { useEffect, useRef, useState, type DragEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import {
  AlertTriangle, ArchiveRestore, Check, CheckCircle2, CloudDownload, HardDrive, Loader2, RefreshCw, ShieldCheck, Upload, XCircle,
} from 'lucide-react';
import { Button, Card, Input, Segmented, Spinner } from '@/components/ui/base';
import { Dialog } from '@/components/ui/dialog';
import { errMsg, get, post, uploadWithProgress } from '@/lib/api';
import { useMaintenance } from '@/lib/maintenance';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';
import { BackupBrowser, type BackupFile } from '@/features/platform/BackupBrowser';

// ------------------------------------------------------------------ tipos e utilidades
type Step = 'download' | 'validate' | 'database' | 'maintenance' | 'safety' | 'switch' | 'uploads' | 'finish';
interface RestoreStatus {
  state: 'idle' | 'running' | 'done' | 'error';
  id?: string; step?: Step; steps?: Step[]; file?: string; startedAt?: string; finishedAt?: string | null;
  error?: string | null; outcome?: 'untouched' | 'rolled_back' | null; warnings?: string[];
  safetyBackup?: string | null; backupCreatedAt?: string | null;
}

const STEP_LABEL: Record<Step, { label: string; hint?: string }> = {
  download: { label: 'Baixando do destino remoto' },
  validate: { label: 'Verificando o arquivo', hint: 'Conteúdo, checksum e versão do banco' },
  database: { label: 'Preparando o banco restaurado', hint: 'Num banco separado — o sistema segue no ar' },
  maintenance: { label: 'Pausando o sistema', hint: 'Esperando as operações em andamento terminarem' },
  safety: { label: 'Cópia de segurança do estado atual', hint: 'Para poder voltar, se precisar' },
  switch: { label: 'Trocando para os dados do backup' },
  uploads: { label: 'Restaurando anexos' },
  finish: { label: 'Reativando o sistema' },
};

/** nopaper-20261103-211843.tar.gz → "03/11/2026 às 21:18" */
export function backupDate(name: string) {
  const m = /nopaper-(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)/.exec(name);
  return m ? `${m[3]}/${m[2]}/${m[1]} às ${m[4]}:${m[5]}` : name;
}
const isoDate = (s?: string | null) => (s ? new Date(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }).replace(', ', ' às ') : null);

// ------------------------------------------------------------------ card
type Source = 'local' | 'remote' | 'upload';

export function RestoreCard({ remoteMode }: { remoteMode: 'none' | 'sftp' | 'rclone' }) {
  const qc = useQueryClient();
  const [source, setSource] = useState<Source>('local');
  const [target, setTarget] = useState<{ source: 'local' | 'remote'; name: string } | null>(null);
  const [highlight, setHighlight] = useState<string | null>(null);
  const list = useQuery({ queryKey: ['system', 'backups'], queryFn: () => get<{ files: BackupFile[]; safetyFiles: string[]; busy: string | null }>('/api/system/backups') });
  const safetyFiles = new Set(list.data?.safetyFiles ?? []);

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start gap-3">
        <span className="grid size-9 place-items-center rounded-lg bg-accent-soft text-accent"><ArchiveRestore className="size-4" /></span>
        <div className="mr-auto max-w-2xl">
          <h2 className="font-display font-semibold">Restaurar backup</h2>
          <p className="text-xs text-muted">
            Volta o sistema inteiro (dados, usuários e anexos) para o momento do backup. Antes de trocar, uma cópia de segurança do estado atual é feita automaticamente.
          </p>
        </div>
      </div>

      <Segmented className="mt-5" value={source} onChange={setSource} options={[
        { value: 'local', label: <span className="inline-flex items-center gap-1.5"><HardDrive className="size-3.5" />Neste servidor</span> },
        { value: 'remote', label: <span className="inline-flex items-center gap-1.5"><CloudDownload className="size-3.5" />Destino remoto</span> },
        { value: 'upload', label: <span className="inline-flex items-center gap-1.5"><Upload className="size-3.5" />Do computador</span> },
      ]} />

      <div className="mt-4">
        {source === 'local' && (
          <BackupBrowser
            files={list.data?.files} loading={list.isLoading} highlight={highlight}
            empty="Nenhum backup neste servidor ainda."
            actions={(f) => <Button size="sm" variant="outline" icon={<ArchiveRestore className="size-3.5" />} onClick={() => setTarget({ source: 'local', name: f.name })}>Restaurar</Button>}
          />
        )}
        {source === 'remote' && <RemoteList mode={remoteMode} onRestore={(name) => setTarget({ source: 'remote', name })} />}
        {source === 'upload' && (
          <UploadBox onUploaded={(name) => {
            qc.invalidateQueries({ queryKey: ['system', 'backups'] });
            setHighlight(name);
            setSource('local');
          }} />
        )}
      </div>

      <ConfirmRestore target={target} safety={!!target && safetyFiles.has(target.name)} onClose={() => setTarget(null)} />
    </Card>
  );
}

function RemoteList({ mode, onRestore }: { mode: 'none' | 'sftp' | 'rclone'; onRestore: (name: string) => void }) {
  const q = useQuery({
    enabled: mode !== 'none', queryKey: ['system', 'backups-remote'], retry: false, staleTime: 30_000,
    queryFn: () => get<{ files: BackupFile[] }>('/api/system/backups-remote'),
  });
  if (mode === 'none') {
    return <p className="rounded-xl border border-dashed border-line px-3 py-8 text-center text-sm text-faint">Configure uma cópia externa (SFTP ou rclone) na aba Configuração para restaurar de lá.</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs text-muted">
        <span className="mr-auto">Backups no destino {mode === 'sftp' ? 'SFTP' : 'rclone'}. O arquivo é baixado e verificado antes de qualquer alteração.</span>
        <Button size="sm" variant="ghost" icon={<RefreshCw className={cn('size-3.5', q.isFetching && 'animate-spin')} />} onClick={() => q.refetch()} disabled={q.isFetching}>Atualizar</Button>
      </div>
      {q.isError
        ? <p className="rounded-xl border border-danger/30 bg-danger/5 px-3 py-4 text-sm text-danger">{errMsg(q.error)}</p>
        : <BackupBrowser files={q.data?.files} loading={q.isLoading} empty="Nenhum backup no destino remoto." newestLabel
            actions={(f) => <Button size="sm" variant="outline" icon={<ArchiveRestore className="size-3.5" />} onClick={() => onRestore(f.name)}>Restaurar</Button>} />}
    </div>
  );
}

function UploadBox({ onUploaded }: { onUploaded: (name: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [drag, setDrag] = useState(false);
  const [pct, setPct] = useState<number | null>(null);
  const send = async (file: File | undefined) => {
    if (!file) return;
    if (!/\.(tar\.gz|tgz|gz)$/i.test(file.name)) { toast.error('Escolha o arquivo .tar.gz do backup do NoPaper'); return; }
    setPct(0);
    try {
      const r = await uploadWithProgress<{ name: string; existed: boolean }>('/api/system/restore/upload', file, setPct);
      toast.success(r.existed ? 'Este backup já estava no servidor' : 'Backup enviado e verificado');
      onUploaded(r.name);
    } catch (e) { toast.error(errMsg(e)); } finally { setPct(null); if (input.current) input.current.value = ''; }
  };
  const onDrop = (e: DragEvent) => { e.preventDefault(); setDrag(false); void send(e.dataTransfer.files[0]); };
  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)} onDrop={onDrop}
      className={cn('relative grid place-items-center rounded-xl border-2 border-dashed px-4 py-10 text-center transition-colors', drag ? 'border-accent bg-accent-soft/50' : 'border-line')}
    >
      <input ref={input} type="file" accept=".gz,.tgz,application/gzip" className="hidden" onChange={(e) => send(e.target.files?.[0])} />
      {pct === null ? (
        <>
          <Upload className="mb-2 size-6 text-faint" />
          <p className="text-sm">Arraste aqui o arquivo <span className="font-mono text-xs">nopaper-….tar.gz</span></p>
          <p className="mt-1 text-xs text-muted">Útil num servidor novo. O arquivo é verificado e fica na lista “Neste servidor”.</p>
          <Button className="mt-4" size="sm" variant="secondary" onClick={() => input.current?.click()}>Escolher arquivo</Button>
        </>
      ) : (
        <div className="w-full max-w-sm">
          <p className="mb-2 text-sm">{pct < 100 ? `Enviando… ${pct}%` : 'Verificando o arquivo…'}</p>
          <div className="h-2 overflow-hidden rounded-full bg-surface-2">
            <motion.div className="h-full rounded-full bg-accent" animate={{ width: `${pct}%` }} transition={{ ease: 'easeOut', duration: 0.3 }} />
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ confirmação
const WORD = 'RESTAURAR';

export function ConfirmRestore({ target, safety, onClose }: { target: { source: 'local' | 'remote'; name: string } | null; safety: boolean; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const startMaintenance = useMaintenance((s) => s.start);
  useEffect(() => { if (target) setTyped(''); }, [target]);
  const go = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await post('/api/system/restore', target);
      startMaintenance(true);
      onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog
      open={!!target} onClose={() => !busy && onClose()} size="sm"
      title="Restaurar este backup?"
      description={target ? <>Backup de <b className="text-ink">{backupDate(target.name)}</b>{target.source === 'remote' ? ' (destino remoto)' : ''}</> : undefined}
      footer={<>
        <Button variant="ghost" onClick={onClose} disabled={busy}>Cancelar</Button>
        <Button variant="danger" loading={busy} disabled={typed.trim().toUpperCase() !== WORD} icon={<ArchiveRestore className="size-4" />} onClick={go}>Restaurar</Button>
      </>}
    >
      <ul className="flex flex-col gap-2.5 text-sm text-muted">
        <li className="flex gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" /><span><b className="text-ink">Tudo o que existe hoje</b> (contas, cartões, anexos, usuários e configurações dos espaços) é substituído pelo conteúdo do backup.</span></li>
        <li className="flex gap-2"><ShieldCheck className="mt-0.5 size-4 shrink-0 text-ok" /><span>Antes, o sistema faz uma <b className="text-ink">cópia de segurança do estado atual</b>. Para desfazer, basta restaurá-la.</span></li>
        <li className="flex gap-2"><RefreshCw className="mt-0.5 size-4 shrink-0 text-accent" /><span>O sistema fica indisponível por alguns instantes e <b className="text-ink">todos precisarão entrar de novo</b>. A configuração de backup deste servidor é mantida.</span></li>
        {safety && <li className="flex gap-2"><ArchiveRestore className="mt-0.5 size-4 shrink-0 text-accent" /><span>Esta é a cópia feita antes de uma restauração: restaurá-la desfaz aquela restauração.</span></li>}
      </ul>
      <label className="mt-5 block text-sm">
        Digite <b className="font-mono tracking-wide">{WORD}</b> para confirmar
        <Input className="mt-1.5 font-mono tracking-wide" value={typed} autoFocus autoComplete="off" onChange={(e) => setTyped(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && typed.trim().toUpperCase() === WORD && !busy) void go(); }} />
      </label>
    </Dialog>
  );
}

// ------------------------------------------------------------------ progresso (tela inteira)
/**
 * Mostrada quando esta aba iniciou a restauração ou quando a API respondeu 503 `maintenance`.
 * Consulta o status público (sem login) até terminar.
 */
export function RestoreOverlay() {
  const { active, owner, stop } = useMaintenance();
  const qc = useQueryClient();
  const [st, setSt] = useState<RestoreStatus | null>(null);
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    if (!active) { setSt(null); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      try {
        const r = await fetch('/api/system/restore/status', { cache: 'no-store' });
        if (!r.ok) throw new Error(String(r.status));
        const s = (await r.json()) as RestoreStatus;
        if (!alive) return;
        setOffline(false);
        setSt(s);
        if (s.state === 'running') timer = setTimeout(tick, 900);
        // manutenção vista sem restauração recente: só recarrega
        else if (s.state === 'idle' && !owner) window.location.reload();
      } catch {
        if (!alive) return;
        setOffline(true);
        timer = setTimeout(tick, 2000);
      }
    };
    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [active, owner]);

  const relogin = () => { useSession.getState().clear(); window.location.assign('/login'); };
  const close = () => { stop(); qc.invalidateQueries(); };

  return (
    <AnimatePresence>
      {active && (
        <motion.div
          className="fixed inset-0 z-[6000] grid place-items-center overflow-y-auto bg-bg/85 p-4 backdrop-blur-md"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
          role="dialog" aria-modal="true" aria-label="Restauração de backup"
        >
          <motion.div
            className="w-full max-w-lg rounded-2xl border border-line bg-surface p-6 shadow-2xl"
            initial={{ y: 18, scale: 0.97 }} animate={{ y: 0, scale: 1 }} transition={{ type: 'spring', stiffness: 380, damping: 30 }}
          >
            {!st || st.state === 'running' || st.state === 'idle'
              ? <Running st={st} offline={offline} owner={owner} />
              : st.state === 'done'
                ? <Done st={st} onLogin={relogin} />
                : <Failed st={st} onClose={close} />}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Running({ st, offline, owner }: { st: RestoreStatus | null; offline: boolean; owner: boolean }) {
  const steps = st?.steps ?? ['validate', 'database', 'maintenance', 'safety', 'switch', 'uploads', 'finish'];
  const cur = st?.step ? steps.indexOf(st.step) : 0;
  return (
    <>
      <div className="flex items-center gap-4">
        <div className="relative grid size-12 place-items-center">
          <motion.span className="absolute inset-0 rounded-full bg-accent/20" animate={{ scale: [1, 1.35, 1], opacity: [0.6, 0, 0.6] }} transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }} />
          <span className="relative grid size-12 place-items-center rounded-full bg-accent-soft text-accent"><ArchiveRestore className="size-5" /></span>
        </div>
        <div className="min-w-0">
          <h2 className="font-display text-xl font-semibold leading-tight">{owner ? 'Restaurando backup' : 'Sistema em manutenção'}</h2>
          <p className="text-sm text-muted">
            {st?.file ? <>Backup de {backupDate(st.file)}</> : 'Um backup está sendo restaurado'}
          </p>
        </div>
      </div>
      <ol className="mt-6 flex flex-col gap-1">
        {steps.map((s, i) => {
          const state = i < cur ? 'done' : i === cur ? 'now' : 'next';
          return (
            <li key={s} className={cn('flex items-start gap-3 rounded-lg px-2 py-1.5 transition-colors', state === 'now' && 'bg-surface-2')}>
              <span className={cn('mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border',
                state === 'done' && 'border-ok bg-ok text-white', state === 'now' && 'border-accent text-accent', state === 'next' && 'border-line text-faint')}>
                {state === 'done' ? <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }}><Check className="size-3" strokeWidth={3} /></motion.span>
                  : state === 'now' ? <Loader2 className="size-3 animate-spin" /> : <span className="size-1.5 rounded-full bg-current" />}
              </span>
              <div className="min-w-0">
                <p className={cn('text-sm', state === 'next' ? 'text-faint' : 'text-ink', state === 'now' && 'font-medium')}>{STEP_LABEL[s].label}</p>
                {state === 'now' && STEP_LABEL[s].hint && <p className="text-xs text-muted">{STEP_LABEL[s].hint}</p>}
              </div>
            </li>
          );
        })}
      </ol>
      <p className={cn('mt-5 text-xs', offline ? 'text-warn' : 'text-faint')}>
        {offline ? 'Sem resposta do servidor — tentando de novo…' : 'Não feche esta página. Se algo falhar, o sistema volta sozinho ao estado anterior.'}
      </p>
    </>
  );
}

function Done({ st, onLogin }: { st: RestoreStatus; onLogin: () => void }) {
  return (
    <div className="text-center">
      <motion.div initial={{ scale: 0.6, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: 'spring', stiffness: 300, damping: 18 }}
        className="mx-auto grid size-14 place-items-center rounded-full bg-ok/15 text-ok">
        <CheckCircle2 className="size-7" />
      </motion.div>
      <h2 className="mt-4 font-display text-2xl font-semibold">Backup restaurado</h2>
      <p className="mt-1 text-sm text-muted">O sistema voltou para {isoDate(st.backupCreatedAt) ?? (st.file ? backupDate(st.file) : 'o momento do backup')}.</p>
      {st.safetyBackup && (
        <div className="mt-5 rounded-xl border border-line bg-surface-2/60 p-3 text-left text-sm">
          <p className="flex items-center gap-1.5 font-medium"><ShieldCheck className="size-4 text-ok" />Cópia de segurança do estado anterior</p>
          <p className="mt-0.5 text-xs text-muted">{backupDate(st.safetyBackup)} — em Plataforma → Restaurar backup. Restaure-a para desfazer.</p>
        </div>
      )}
      {!!st.warnings?.length && (
        <ul className="mt-3 flex flex-col gap-1.5 text-left">
          {st.warnings.map((w) => <li key={w} className="flex gap-2 rounded-lg bg-warn/10 px-3 py-2 text-xs text-ink"><AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-warn" />{w}</li>)}
        </ul>
      )}
      <p className="mt-5 text-sm text-muted">Por segurança, todos foram desconectados.</p>
      <Button className="mt-4 w-full" variant="primary" size="lg" onClick={onLogin}>Entrar novamente</Button>
    </div>
  );
}

function Failed({ st, onClose }: { st: RestoreStatus; onClose: () => void }) {
  const outcome = st.outcome === 'untouched' ? 'Nada foi alterado: o sistema continua exatamente como estava.'
    : st.outcome === 'rolled_back' ? 'O sistema voltou automaticamente ao estado anterior.' : null;
  return (
    <div className="text-center">
      <div className="mx-auto grid size-14 place-items-center rounded-full bg-danger/12 text-danger"><XCircle className="size-7" /></div>
      <h2 className="mt-4 font-display text-2xl font-semibold">A restauração não foi concluída</h2>
      {outcome && <p className="mt-1 text-sm text-ok">{outcome}</p>}
      <p className="mt-4 rounded-xl border border-danger/30 bg-danger/5 px-3 py-3 text-left text-sm text-ink">{st.error}</p>
      <Button className="mt-5 w-full" variant="secondary" size="lg" onClick={onClose}>Fechar</Button>
    </div>
  );
}
