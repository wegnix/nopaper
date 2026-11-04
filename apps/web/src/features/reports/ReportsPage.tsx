import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, ChevronLeft, ChevronRight, Printer, TrendingDown, TrendingUp } from 'lucide-react';
import { COLOR_PRESETS, isColorKey, MONTHS_PT, MONTHS_PT_SHORT, formatBRL, toCents, todayISO, type BillType } from '@nopaper/shared';
import { Button, Card, Segmented, Spinner } from '@/components/ui/base';
import { get, qs } from '@/lib/api';
import { useCategories, useFolders } from '@/lib/queries';
import { useCan, useSession } from '@/lib/session';
import { cn } from '@/lib/utils';
import { CountUp } from '@/features/bills/KpiRibbon';
import { compact, niceMax, pct } from './format';
import { ReportPrint } from './ReportPrint';

export interface MonthRow { month: number; total: string; paid: string; pending: string; overdue: string; count: number; other: string | null }
export interface Report {
  type: BillType; year: number; today: string;
  totals: { total: string; paid: string; pending: string; overdue: string; count: number; previousYear: string };
  olderOverdue: { total: string; count: number };
  months: MonthRow[];
  byCategory: Array<{ categoryId: string; total: string; paid: string; count: number }>;
  byFolder: Array<{ folderId: string | null; total: string; count: number }>;
  top: Array<{ description: string; total: string; count: number }>;
  cards: Array<{ categoryId: string; total: string; count: number }> | null;
}

export function ReportsPage() {
  const can = useCan();
  const orgId = useSession((s) => s.orgId);
  const [sp, setSp] = useSearchParams();
  const thisYear = Number(todayISO().slice(0, 4));
  const year = Number(sp.get('ano')) || thisYear;
  const canP = can('payable.view'), canR = can('receivable.view');
  const type: BillType = sp.get('tipo') === 'receber' && canR ? 'receivable' : canP ? 'payable' : 'receivable';
  const set = (k: string, v: string | null) => { const n = new URLSearchParams(sp); if (v === null) n.delete(k); else n.set(k, v); setSp(n, { replace: true }); };

  const q = useQuery({
    queryKey: ['bills', orgId, 'report', type, year], placeholderData: (p) => p,
    queryFn: () => get<Report>(`/api/reports/overview?${qs({ type, year })}`),
  });
  const { data: cats = [] } = useCategories();
  const { data: folders = [] } = useFolders();
  const catMap = useMemo(() => new Map(cats.map((c) => [c.id, c])), [cats]);
  const folderMap = useMemo(() => new Map(folders.map((f) => [f.id, f])), [folders]);
  const r = q.data;
  const listPath = type === 'payable' ? '/pagar' : '/receber';
  const word = type === 'payable' ? { done: 'Pago', open: 'A pagar', verb: 'pagas' } : { done: 'Recebido', open: 'A receber', verb: 'recebidas' };

  const total = r ? toCents(r.totals.total) : 0;
  const prev = r ? toCents(r.totals.previousYear) : 0;
  const delta = prev ? ((total - prev) / prev) * 100 : null;

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <div className="flex flex-wrap items-end gap-3 sm:gap-4">
        <div className="mr-auto min-w-0 max-sm:w-full">
          <h1 className="font-display text-2xl md:text-3xl font-semibold tracking-tight">Relatórios</h1>
          <p className="mt-1 text-sm text-muted">Para onde foi (e de onde veio) o dinheiro em {year}.</p>
        </div>
        {canP && canR && (
          <Segmented value={type} onChange={(v) => set('tipo', v === 'receivable' ? 'receber' : null)}
            options={[{ value: 'payable', label: 'Contas a pagar' }, { value: 'receivable', label: 'Contas a receber' }]} />
        )}
        <div className="flex items-center rounded-lg border border-line bg-surface">
          <button className="grid size-10 place-items-center text-muted hover:text-ink" onClick={() => set('ano', String(year - 1))} aria-label="Ano anterior"><ChevronLeft className="size-4" /></button>
          <span className="w-14 text-center font-display font-semibold tnum">{year}</span>
          <button className="grid size-10 place-items-center text-muted hover:text-ink" onClick={() => set('ano', String(year + 1))} aria-label="Próximo ano"><ChevronRight className="size-4" /></button>
        </div>
        <Button variant="ghost" icon={<Printer className="size-4" />} onClick={() => window.print()} disabled={!r}>Imprimir</Button>
      </div>

      {!r ? <div className="grid place-items-center py-24"><Spinner /></div> : (
        <>
          {/* ------------------------------------------------------------ totais */}
          <Card className="grid grid-cols-2 lg:grid-cols-4 divide-line [&>*]:border-line max-lg:[&>*:nth-child(n+3)]:border-t lg:divide-x max-lg:[&>*:nth-child(even)]:border-l">
            <div className="min-w-0 p-3.5 sm:p-5">
              <p className="text-xs text-muted">Total no ano</p>
              <CountUp value={r.totals.total} className="mt-1 block font-display text-lg sm:text-2xl font-semibold" />
              <p className="mt-1 flex items-center gap-1 text-xs text-faint">
                {delta === null ? `${r.totals.count} contas` : <>{delta >= 0 ? <TrendingUp className="size-3.5" /> : <TrendingDown className="size-3.5" />}{delta >= 0 ? '+' : ''}{delta.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% vs {year - 1}</>}
              </p>
            </div>
            <div className="min-w-0 p-3.5 sm:p-5">
              <p className="text-xs text-muted">{word.done}</p>
              <CountUp value={r.totals.paid} className="mt-1 block font-display text-lg sm:text-2xl font-semibold" />
              <p className="mt-1 text-xs text-faint">{pct(toCents(r.totals.paid), total)}% do total</p>
            </div>
            <div className="min-w-0 p-3.5 sm:p-5">
              <p className="text-xs text-muted">{word.open}</p>
              <CountUp value={r.totals.pending} className="mt-1 block font-display text-lg sm:text-2xl font-semibold" />
              <p className="mt-1 text-xs text-faint">vencimentos até dez/{year}</p>
            </div>
            <div className="min-w-0 p-3.5 sm:p-5">
              <p className="text-xs text-muted">Vencido sem baixa</p>
              <CountUp value={r.totals.overdue} className={cn('mt-1 block font-display text-lg sm:text-2xl font-semibold', toCents(r.totals.overdue) > 0 && 'text-danger')} />
              {toCents(r.olderOverdue.total) > 0
                ? <p className="mt-1 flex items-center gap-1 text-xs text-danger"><AlertTriangle className="size-3.5" />+ {formatBRL(r.olderOverdue.total)} de anos anteriores</p>
                : <p className="mt-1 text-xs text-faint">{toCents(r.totals.overdue) > 0 ? 'confira em Situação: vencidas' : 'nada atrasado'}</p>}
            </div>
          </Card>

          {/* ------------------------------------------------------------ mês a mês */}
          <Card className="p-4 sm:p-5">
            <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-2">
              <h2 className="mr-auto font-display font-semibold">Mês a mês</h2>
              <span className="flex items-center gap-1.5 text-xs text-muted"><span className="size-2.5 rounded-sm bg-[var(--np-chart-1)]" />{word.done}</span>
              <span className="flex items-center gap-1.5 text-xs text-muted"><span className="size-2.5 rounded-sm bg-[var(--np-chart-2)]" />{word.open}</span>
            </div>
            <MonthlyChart months={r.months} year={r.year} today={r.today} labels={word} onPick={(m) => `${listPath}?ano=${r.year}&mes=${m}`} />
            <details className="mt-4 group">
              <summary className="cursor-pointer text-xs text-accent hover:underline list-none">Ver em tabela</summary>
              <MonthTable months={r.months} type={type} labels={word} />
            </details>
          </Card>

          <div className="grid gap-4 sm:gap-6 xl:grid-cols-2">
            {/* -------------------------------------------------------- categorias */}
            <Card className="p-4 sm:p-5">
              <h2 className="font-display font-semibold">Por categoria</h2>
              <BarList className="mt-4" total={total}
                rows={r.byCategory.map((c) => ({
                  key: c.categoryId, label: catMap.get(c.categoryId)?.label ?? '—', color: catMap.get(c.categoryId)?.color,
                  cents: toCents(c.total), sub: `${c.count} ${c.count === 1 ? 'conta' : 'contas'} · ${pct(toCents(c.paid), toCents(c.total))}% ${word.verb}`,
                  to: `${listPath}?ano=${r.year}&categoria=${c.categoryId}`,
                }))} />
            </Card>

            <div className="flex min-w-0 flex-col gap-4 sm:gap-6">
              <Card className="p-4 sm:p-5">
                <h2 className="font-display font-semibold">Maiores contas do ano</h2>
                <ol className="mt-3 divide-y divide-line">
                  {r.top.map((t, i) => (
                    <li key={t.description} className="flex items-center gap-3 py-2 text-sm">
                      <span className="w-5 text-right text-xs text-faint tnum">{i + 1}</span>
                      <Link to={`${listPath}?ano=${r.year}&busca=${encodeURIComponent(t.description)}`} className="min-w-0 flex-1 truncate hover:text-accent">{t.description}</Link>
                      <span className="text-xs text-faint">{t.count}×</span>
                      <span className="shrink-0 text-right tnum font-medium sm:w-28">{formatBRL(t.total)}</span>
                    </li>
                  ))}
                  {!r.top.length && <li className="py-6 text-center text-sm text-faint">Sem contas em {year}.</li>}
                </ol>
              </Card>
              {r.byFolder.length > 1 && (
                <Card className="p-4 sm:p-5">
                  <h2 className="font-display font-semibold">Por pasta</h2>
                  <BarList className="mt-4" total={total}
                    rows={r.byFolder.map((f) => ({
                      key: f.folderId ?? 'none', label: f.folderId ? folderMap.get(f.folderId)?.label ?? '—' : 'Sem pasta', color: f.folderId ? folderMap.get(f.folderId)?.color : undefined,
                      cents: toCents(f.total), sub: `${f.count} ${f.count === 1 ? 'conta' : 'contas'}`,
                      to: f.folderId ? `${listPath}?ano=${r.year}&pasta=${f.folderId}` : undefined,
                    }))} />
                </Card>
              )}
            </div>
          </div>

          {r.cards && r.cards.length > 0 && (
            <Card className="p-4 sm:p-5">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <h2 className="font-display font-semibold">Dentro das faturas de cartão</h2>
                <p className="text-xs text-faint">Compras por categoria nas faturas que vencem em {year}. Já estão somadas acima como “Fatura”.</p>
              </div>
              <BarList className="mt-4" total={r.cards.reduce((a, c) => a + toCents(c.total), 0)}
                rows={r.cards.map((c) => ({
                  key: c.categoryId, label: catMap.get(c.categoryId)?.label ?? '—', color: catMap.get(c.categoryId)?.color,
                  cents: toCents(c.total), sub: `${c.count} ${c.count === 1 ? 'lançamento' : 'lançamentos'}`,
                }))} columns />
            </Card>
          )}
          <ReportPrint report={r} catMap={catMap} folderMap={folderMap} />
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ gráfico mensal (barras empilhadas)
function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(e.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

export function MonthlyChart({ months, year, today, labels, onPick, height = 240 }: { months: MonthRow[]; year: number; today: string; labels: { done: string; open: string }; onPick: (m: number) => string; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const nav = useNavigate();
  const [hover, setHover] = useState<number | null>(null);
  const narrow = width > 0 && width < 480;
  const H = height, padL = narrow ? 46 : 64, padB = 26, padT = 8;
  // toque: o 1º mostra o resumo do mês, o 2º abre a lista (no mouse, o hover já mostra)
  const touch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
  const max = niceMax(Math.max(...months.map((m) => toCents(m.total))));
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => f * max);
  const plotW = Math.max(0, width - padL);
  const slot = plotW / 12;
  const barW = Math.min(36, slot * 0.56);
  const y = (c: number) => padT + (H - padT - padB) * (1 - c / max);
  const curMonth = Number(today.slice(0, 4)) === year ? Number(today.slice(5, 7)) : null;
  const h = hover !== null ? months[hover] : null;

  return (
    <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
      {width > 0 && (
        <svg width={width} height={H} role="img" aria-label={`Valores por mês em ${year}`} className="block overflow-visible">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={padL} x2={width} y1={y(t)} y2={y(t)} stroke="var(--np-line)" strokeDasharray={t ? '2 4' : undefined} />
              <text x={padL - (narrow ? 6 : 10)} y={y(t)} dy="0.32em" textAnchor="end" className={cn('fill-[var(--np-faint)] tnum', narrow ? 'text-[10px]' : 'text-[11px]')}>{compact(t)}</text>
            </g>
          ))}
          {months.map((m, i) => {
            const cx = padL + slot * i + slot / 2;
            const paid = toCents(m.paid), pend = toCents(m.pending);
            const yPaid = y(paid), yTop = y(paid + pend);
            const base = y(0);
            const gap = paid > 0 && pend > 0 ? 2 : 0;
            const dim = hover !== null && hover !== i;
            return (
              <g key={m.month} opacity={dim ? 0.45 : 1} className="transition-opacity">
                {paid > 0 && <path d={roundTop(cx - barW / 2, yPaid, barW, base - yPaid, pend > 0 ? 0 : 4)} fill="var(--np-chart-1)" />}
                {pend > 0 && <path d={roundTop(cx - barW / 2, yTop, barW, Math.max(0, yPaid - yTop - gap), 4)} fill="var(--np-chart-2)" />}
                <text x={cx} y={H - 6} textAnchor="middle" className={cn('text-[11px]', curMonth === m.month ? 'fill-[var(--np-ink)] font-semibold' : 'fill-[var(--np-faint)]')}>{slot < 30 ? MONTHS_PT_SHORT[i].slice(0, 1) : MONTHS_PT_SHORT[i]}</text>
                {/* área de hover maior que a barra */}
                <rect x={padL + slot * i} y={0} width={slot} height={H} fill="transparent" className="cursor-pointer"
                  onMouseEnter={() => !touch && setHover(i)} onClick={() => (touch && hover !== i ? setHover(i) : nav(onPick(m.month)))} />
              </g>
            );
          })}
        </svg>
      )}
      {h && hover !== null && (
        <div className="pointer-events-none absolute z-10 w-52 rounded-xl border border-line bg-raised p-3 text-xs shadow-2xl"
          style={{ left: Math.min(Math.max(padL + slot * hover + slot / 2 - 104, 0), width - 208), top: Math.max(0, y(toCents(h.total)) - 120) }}>
          <p className="font-display text-sm font-semibold">{MONTHS_PT[hover]} {year}</p>
          <div className="mt-2 flex flex-col gap-1">
            <Row swatch="var(--np-chart-1)" label={labels.done} value={formatBRL(h.paid)} />
            <Row swatch="var(--np-chart-2)" label={labels.open} value={formatBRL(h.pending)} />
            <div className="my-1 h-px bg-line" />
            <Row label="Total" value={formatBRL(h.total)} strong />
            {toCents(h.overdue) > 0 && <p className="flex items-center gap-1 text-danger"><AlertTriangle className="size-3" />{formatBRL(h.overdue)} vencido</p>}
          </div>
          <p className="mt-2 text-faint">{h.count} {h.count === 1 ? 'conta' : 'contas'} · {touch ? 'toque de novo para abrir' : 'clique para abrir'}</p>
        </div>
      )}
    </div>
  );
}
function Row({ swatch, label, value, strong }: { swatch?: string; label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center gap-2">
      {swatch ? <span className="size-2 rounded-sm" style={{ background: swatch }} /> : <span className="size-2" />}
      <span className="flex-1 text-muted">{label}</span>
      <span className={cn('tnum', strong && 'font-semibold')}>{value}</span>
    </div>
  );
}
function roundTop(x: number, y: number, w: number, h: number, r: number) {
  if (h <= 0) return '';
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function MonthTable({ months, type, labels }: { months: MonthRow[]; type: BillType; labels: { done: string; open: string } }) {
  const hasOther = months.some((m) => m.other !== null);
  const sum = (k: 'total' | 'paid' | 'pending' | 'other') => months.reduce((a, m) => a + toCents(m[k] ?? '0'), 0);
  const bal = (m: { total: number; other: number }) => (type === 'receivable' ? m.total - m.other : m.other - m.total);
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="text-left text-xs text-muted">
          <tr className="border-b border-line">
            <th className="py-2 font-medium">Mês</th>
            <th className="py-2 text-right font-medium">Total</th>
            <th className="py-2 text-right font-medium">{labels.done}</th>
            <th className="py-2 text-right font-medium">{labels.open}</th>
            {hasOther && <th className="py-2 text-right font-medium">{type === 'payable' ? 'A receber' : 'A pagar'}</th>}
            {hasOther && <th className="py-2 text-right font-medium">Saldo</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-line tnum">
          {months.map((m, i) => {
            const b = hasOther ? bal({ total: toCents(m.total), other: toCents(m.other ?? '0') }) : 0;
            return (
              <tr key={m.month}>
                <td className="py-1.5">{MONTHS_PT[i]}</td>
                <td className="py-1.5 text-right">{formatBRL(m.total)}</td>
                <td className="py-1.5 text-right text-muted">{formatBRL(m.paid)}</td>
                <td className="py-1.5 text-right text-muted">{formatBRL(m.pending)}</td>
                {hasOther && <td className="py-1.5 text-right text-muted">{formatBRL(m.other ?? '0')}</td>}
                {hasOther && <td className={cn('py-1.5 text-right', b < 0 && 'text-danger')}>{formatBRL(b / 100)}</td>}
              </tr>
            );
          })}
        </tbody>
        <tfoot className="border-t-2 border-line-strong font-semibold tnum">
          <tr>
            <td className="py-2">Ano</td>
            <td className="py-2 text-right">{formatBRL(sum('total') / 100)}</td>
            <td className="py-2 text-right">{formatBRL(sum('paid') / 100)}</td>
            <td className="py-2 text-right">{formatBRL(sum('pending') / 100)}</td>
            {hasOther && <td className="py-2 text-right">{formatBRL(sum('other') / 100)}</td>}
            {hasOther && (() => { const b = bal({ total: sum('total'), other: sum('other') }); return <td className={cn('py-2 text-right', b < 0 && 'text-danger')}>{formatBRL(b / 100)}</td>; })()}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ barras horizontais
interface BarRow { key: string; label: string; color?: string; cents: number; sub?: string; to?: string }
function BarList({ rows, total, className, columns }: { rows: BarRow[]; total: number; className?: string; columns?: boolean }) {
  const max = Math.max(1, ...rows.map((r) => r.cents));
  if (!rows.length) return <p className={cn('text-sm text-faint', className)}>Nada no período.</p>;
  return (
    <ul className={cn('grid gap-x-8 gap-y-3.5 [&>li]:min-w-0', columns && 'md:grid-cols-2', className)}>
      {rows.map((r) => {
        const inner = (
          <>
            <div className="flex items-baseline gap-2 text-sm">
              {r.color && <span className="size-2.5 shrink-0 self-center rounded-full" style={{ background: COLOR_PRESETS[isColorKey(r.color) ? r.color : 'slate'].base }} />}
              <span className="min-w-0 flex-1 truncate">{r.label}</span>
              <span className="text-xs text-faint tnum">{pct(r.cents, total)}%</span>
              <span className="shrink-0 text-right font-medium tnum sm:w-28">{formatBRL(r.cents / 100)}</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full bg-[var(--np-chart-1)] transition-[width] duration-700" style={{ width: `${(r.cents / max) * 100}%` }} />
            </div>
            {r.sub && <p className="mt-1 text-xs text-faint">{r.sub}</p>}
          </>
        );
        return <li key={r.key}>{r.to ? <Link to={r.to} className="block rounded-lg hover:[&_span]:text-ink">{inner}</Link> : inner}</li>;
      })}
    </ul>
  );
}
