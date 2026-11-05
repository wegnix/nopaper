import { useEffect, useState } from 'react';
import { Popover } from 'radix-ui';
import { CalendarDays, ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { MONTHS_PT, MONTHS_PT_SHORT, formatDateBR, parseISODate, todayISO } from '@nopaper/shared';
import { cn } from '@/lib/utils';

const WEEK = ['D', 'S', 'T', 'Q', 'Q', 'S', 'S'];

/**
 * Data (YYYY-MM-DD) escolhida num calendário em grade — mesmo visual do DayPicker, no lugar do
 * <input type="date"> nativo (cada navegador mostra de um jeito e no iPhone é uma roda).
 */
export function DatePicker({ value, onChange, disabled, min, max, clearable, placeholder = 'Escolher data', size = 'md', className, id, 'aria-label': ariaLabel }: {
  value: string; onChange: (v: string) => void; disabled?: boolean; min?: string; max?: string; clearable?: boolean;
  placeholder?: string; size?: 'sm' | 'md'; className?: string; id?: string; 'aria-label'?: string;
}) {
  const [open, setOpen] = useState(false);
  const today = todayISO();
  const base = parseISODate(value || today);
  const [view, setView] = useState({ y: base.y, m: base.m });
  const [mode, setMode] = useState<'days' | 'months'>('days');
  // ao abrir, mostra o mês da data escolhida (ou o atual)
  useEffect(() => { if (open) { const b = parseISODate(value || today); setView({ y: b.y, m: b.m }); setMode('days'); } }, [open, value, today]);

  const shift = (n: number) => setView((v) => { const t = v.y * 12 + (v.m - 1) + n; return { y: Math.floor(t / 12), m: (t % 12) + 1 }; });
  const out = (iso: string) => (!!min && iso < min) || (!!max && iso > max);
  const pick = (iso: string) => { if (out(iso)) return; onChange(iso); setOpen(false); };

  // grade de 6 semanas começando no domingo, com os dias dos meses vizinhos esmaecidos
  const first = new Date(Date.UTC(view.y, view.m - 1, 1)).getUTCDay();
  const cells = Array.from({ length: 42 }, (_, i) => {
    const d = new Date(Date.UTC(view.y, view.m - 1, 1 - first + i));
    return { iso: d.toISOString().slice(0, 10), day: d.getUTCDate(), inMonth: d.getUTCMonth() + 1 === view.m };
  });
  const lastRow = cells.slice(35).every((c) => !c.inMonth) ? 35 : 42;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild disabled={disabled}>
        <button type="button" id={id} aria-label={ariaLabel}
          className={cn('flex w-full items-center gap-2 rounded-lg border border-line bg-surface-2 text-left text-sm text-ink transition-colors hover:border-line-strong focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-60 disabled:hover:border-line data-[state=open]:border-accent',
            size === 'sm' ? 'h-9 px-2.5' : 'h-10 px-3', className)}>
          <CalendarDays className="size-4 shrink-0 text-faint" />
          <span className={cn('flex-1 truncate tnum', !value && 'text-faint')}>{value ? formatDateBR(value) : placeholder}</span>
          <ChevronDown className="size-4 shrink-0 text-faint" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} collisionPadding={12}
          className="z-[6000] w-[min(296px,calc(100vw-24px))] rounded-xl border border-line bg-raised p-2 shadow-2xl">
          <div className="mb-1 flex items-center justify-between gap-1">
            <button type="button" aria-label={mode === 'days' ? 'Mês anterior' : 'Ano anterior'} onClick={() => (mode === 'days' ? shift(-1) : shift(-12))}
              className="grid size-9 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink"><ChevronLeft className="size-4" /></button>
            <button type="button" onClick={() => setMode(mode === 'days' ? 'months' : 'days')}
              className="h-9 flex-1 rounded-md font-display text-sm font-semibold hover:bg-surface-2" aria-label="Escolher mês e ano">
              {mode === 'days' ? `${MONTHS_PT[view.m - 1]} ${view.y}` : view.y}
            </button>
            <button type="button" aria-label={mode === 'days' ? 'Próximo mês' : 'Próximo ano'} onClick={() => (mode === 'days' ? shift(1) : shift(12))}
              className="grid size-9 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink"><ChevronRight className="size-4" /></button>
          </div>

          {mode === 'days' ? (
            <>
              <div className="grid grid-cols-7 gap-1 pb-1 text-center text-[11px] font-medium text-faint">{WEEK.map((w, i) => <span key={i}>{w}</span>)}</div>
              <div role="grid" className="grid grid-cols-7 gap-1">
                {cells.slice(0, lastRow).map((c) => {
                  const sel = c.iso === value, isToday = c.iso === today, dis = out(c.iso);
                  return (
                    <button key={c.iso} type="button" disabled={dis} aria-pressed={sel} aria-label={formatDateBR(c.iso)} onClick={() => pick(c.iso)}
                      className={cn('h-9 pointer-coarse:h-10 rounded-md text-[13px] tnum transition-colors disabled:opacity-30 disabled:cursor-not-allowed',
                        sel ? 'bg-accent font-semibold text-accent-ink'
                          : c.inMonth ? 'text-ink hover:bg-surface-2' : 'text-faint/70 hover:bg-surface-2',
                        isToday && !sel && 'ring-1 ring-inset ring-accent/60 font-semibold text-accent')}>
                      {c.day}
                    </button>
                  );
                })}
              </div>
            </>
          ) : (
            <div className="grid grid-cols-3 gap-1">
              {MONTHS_PT_SHORT.map((label, i) => (
                <button key={label} type="button" onClick={() => { setView({ y: view.y, m: i + 1 }); setMode('days'); }}
                  className={cn('h-11 rounded-md text-sm transition-colors', view.m === i + 1 ? 'bg-accent font-semibold text-accent-ink' : 'text-ink hover:bg-surface-2')}>
                  {label}
                </button>
              ))}
            </div>
          )}

          <div className="mt-2 flex items-center justify-between gap-2 border-t border-line pt-2">
            <button type="button" disabled={out(today)} onClick={() => pick(today)} className="h-8 rounded-md px-2.5 text-[13px] font-medium text-accent hover:bg-accent-soft disabled:opacity-40">Hoje</button>
            {mode === 'days' && value && (view.y !== base.y || view.m !== base.m) && (
              <button type="button" onClick={() => setView({ y: base.y, m: base.m })} className="h-8 rounded-md px-2.5 text-[13px] text-muted hover:bg-surface-2 hover:text-ink">Ir para {formatDateBR(value).slice(0, 5)}</button>
            )}
            {clearable && value && <button type="button" onClick={() => { onChange(''); setOpen(false); }} className="h-8 rounded-md px-2.5 text-[13px] text-muted hover:bg-surface-2 hover:text-danger">Limpar</button>}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
