import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight, ShieldCheck } from 'lucide-react';
import { MONTHS_PT } from '@nopaper/shared';
import { Select, Spinner } from '@/components/ui/base';
import { cn } from '@/lib/utils';

export interface BackupFile { name: string; size: number; trigger?: string | null }

export const fileSize = (b: number) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const parts = (name: string) => /nopaper-(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)/.exec(name);
/** "03/11/2026 às 21:18" */
export function backupWhen(name: string) {
  const m = parts(name);
  return m ? `${m[3]}/${m[2]}/${m[1]} às ${m[4]}:${m[5]}` : name;
}
const monthKey = (name: string) => { const m = parts(name); return m ? `${m[1]}-${m[2]}` : 'outros'; };
const monthLabel = (k: string) => (k === 'outros' ? 'Outros' : `${MONTHS_PT[Number(k.slice(5)) - 1]} de ${k.slice(0, 4)}`);

export const TRIGGER: Record<string, { label: string; tone: string }> = {
  schedule: { label: 'agendado', tone: 'bg-surface-2 text-muted' },
  manual: { label: 'manual', tone: 'bg-surface-2 text-muted' },
  pre_restore: { label: 'antes de uma restauração', tone: 'bg-accent-soft text-accent' },
  pre_update: { label: 'antes de uma atualização', tone: 'bg-accent-soft text-accent' },
  upload: { label: 'enviado do computador', tone: 'bg-surface-2 text-muted' },
};
const kindOf = (f: BackupFile) => (f.trigger === undefined ? null : f.trigger ?? 'upload');

const PAGE = 12;

/**
 * Lista de backups preparada para muitos arquivos: filtro por mês e por origem, agrupada por mês
 * e paginada. As ações de cada linha vêm de fora (baixar, restaurar, apagar…).
 */
export function BackupBrowser({ files, loading, empty, actions, highlight, newestLabel = true }: {
  files?: BackupFile[]; loading?: boolean; empty: ReactNode; actions: (f: BackupFile) => ReactNode; highlight?: string | null; newestLabel?: boolean;
}) {
  const [month, setMonth] = useState('');
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(0);
  const all = useMemo(() => files ?? [], [files]);
  const months = useMemo(() => [...new Set(all.map((f) => monthKey(f.name)))], [all]);
  const kinds = useMemo(() => [...new Set(all.map(kindOf).filter((k): k is string => !!k))], [all]);
  const shown = useMemo(() => all.filter((f) => (!month || monthKey(f.name) === month) && (!kind || kindOf(f) === kind)), [all, month, kind]);
  const pages = Math.max(1, Math.ceil(shown.length / PAGE));
  useEffect(() => setPage(0), [month, kind]);
  useEffect(() => { if (page >= pages) setPage(pages - 1); }, [page, pages]);
  // ao destacar um arquivo (ex.: recém-enviado), vai para a página dele
  useEffect(() => {
    if (!highlight) return;
    setMonth(''); setKind('');
    const i = all.findIndex((f) => f.name === highlight);
    if (i >= 0) setPage(Math.floor(i / PAGE));
  }, [highlight, all]);

  if (loading) return <div className="grid place-items-center py-8"><Spinner /></div>;
  if (!all.length) return <p className="rounded-xl border border-dashed border-line px-3 py-8 text-center text-sm text-faint">{empty}</p>;

  const slice = shown.slice(page * PAGE, page * PAGE + PAGE);
  const total = all.reduce((a, f) => a + f.size, 0);
  let lastMonth = '';
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {months.length > 1 && (
          <Select aria-label="Mês" className="h-9 w-auto min-w-[180px] text-sm" value={month} onChange={(e) => setMonth(e.target.value)}>
            <option value="">Todos os meses</option>
            {months.map((m) => <option key={m} value={m}>{monthLabel(m)} ({all.filter((f) => monthKey(f.name) === m).length})</option>)}
          </Select>
        )}
        {kinds.length > 1 && (
          <div className="flex flex-wrap gap-1">
            {['', ...kinds].map((k) => (
              <button key={k || 'all'} type="button" onClick={() => setKind(k)}
                className={cn('rounded-md border px-2 py-1 text-xs font-medium transition-colors', kind === k ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-ink')}>
                {k ? TRIGGER[k]?.label ?? k : 'Todos'}
              </button>
            ))}
          </div>
        )}
        <span className="ml-auto text-xs text-faint tnum">{all.length} {all.length === 1 ? 'arquivo' : 'arquivos'} · {fileSize(total)}</span>
      </div>

      {!shown.length ? <p className="rounded-xl border border-dashed border-line px-3 py-6 text-center text-sm text-faint">Nenhum backup com estes filtros.</p> : (
        <ul className="overflow-hidden rounded-xl border border-line">
          {slice.map((f) => {
            const mk = monthKey(f.name);
            const header = !month && mk !== lastMonth;
            lastMonth = mk;
            const k = kindOf(f);
            const newest = newestLabel && f.name === all[0]?.name;
            return (
              <li key={f.name}>
                {header && <p className="border-b border-line bg-surface-2/60 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide text-faint">{monthLabel(mk)}</p>}
                <div className={cn('flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line/70 px-3 py-2.5 last:border-0', highlight === f.name && 'bg-accent-soft/60')}>
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                      {backupWhen(f.name)}
                      {newest && <span className="rounded-md bg-ok/15 px-1.5 py-0.5 text-[11px] font-medium text-ok">mais recente</span>}
                      {k && <span className={cn('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium', TRIGGER[k]?.tone)}>{k === 'pre_restore' && <ShieldCheck className="size-3" />}{TRIGGER[k]?.label ?? k}</span>}
                      {highlight === f.name && <span className="rounded-md bg-ok/15 px-1.5 py-0.5 text-[11px] font-medium text-ok">enviado e verificado</span>}
                    </p>
                    <p className="truncate font-mono text-[11px] text-faint">{f.name} · {fileSize(f.size)}</p>
                  </div>
                  <div className="flex items-center gap-1">{actions(f)}</div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-xs text-muted">
          <span className="tnum">{page * PAGE + 1}–{Math.min(shown.length, (page + 1) * PAGE)} de {shown.length}</span>
          <button type="button" className="grid size-8 place-items-center rounded-md border border-line disabled:opacity-40 hover:text-ink" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Página anterior"><ChevronLeft className="size-4" /></button>
          <button type="button" className="grid size-8 place-items-center rounded-md border border-line disabled:opacity-40 hover:text-ink" disabled={page >= pages - 1} onClick={() => setPage(page + 1)} aria-label="Próxima página"><ChevronRight className="size-4" /></button>
        </div>
      )}
    </div>
  );
}
