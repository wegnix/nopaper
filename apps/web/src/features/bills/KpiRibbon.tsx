import { useEffect, useRef } from 'react';
import { animate, useReducedMotion } from 'motion/react';
import { AlertTriangle, CalendarClock, CheckCircle2, Clock, Sigma } from 'lucide-react';
import { formatBRL, toCents, type BillType } from '@nopaper/shared';
import { cn, plural } from '@/lib/utils';
import type { Summary } from '@/lib/types';
import { L } from './labels';

export function CountUp({ value, className }: { value: string; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(0);
  const reduce = useReducedMotion();
  useEffect(() => {
    const to = toCents(value) / 100;
    if (!ref.current) return;
    if (reduce) { ref.current.textContent = formatBRL(to); prev.current = to; return; }
    const ctl = animate(prev.current, to, {
      duration: 0.7, ease: [0.2, 0.8, 0.2, 1],
      onUpdate: (v) => { if (ref.current) ref.current.textContent = formatBRL(v); },
    });
    prev.current = to;
    return () => ctl.stop();
  }, [value, reduce]);
  return <span ref={ref} className={cn('tnum', className)}>{formatBRL(value)}</span>;
}

interface Kpi { key: string; label: string; value: string; sub: string; icon: typeof Clock; tone: 'accent' | 'danger' | 'warn' | 'ok' | 'plain'; onClick?: () => void; active?: boolean }
const tones = {
  accent: 'text-accent', danger: 'text-danger', warn: 'text-warn', ok: 'text-ok', plain: 'text-muted',
};

export function KpiRibbon({ type, s, onFilter, active }: { type: BillType; s?: Summary; onFilter: (status: 'pending' | 'overdue' | 'due_soon' | 'paid' | '') => void; active: string }) {
  const l = L[type];
  const kpis: Kpi[] = [
    { key: 'pending', label: 'Pendente no mês', value: s?.pending.total ?? '0', sub: plural(s?.pending.count ?? 0, 'conta', 'contas'), icon: Clock, tone: 'accent', onClick: () => onFilter('pending') },
    { key: 'overdue', label: l.overduePl, value: s?.overdue.total ?? '0', sub: s?.overdue.count ? `${plural(s.overdue.count, 'conta', 'contas')} em todos os meses` : 'nada em atraso', icon: AlertTriangle, tone: s?.overdue.count ? 'danger' : 'plain', onClick: s?.overdue.count ? () => onFilter('overdue') : undefined },
    { key: 'due_soon', label: 'Próximos 7 dias', value: s?.dueSoon.total ?? '0', sub: plural(s?.dueSoon.count ?? 0, 'conta', 'contas'), icon: CalendarClock, tone: s?.dueSoon.count ? 'warn' : 'plain', onClick: s?.dueSoon.count ? () => onFilter('due_soon') : undefined },
    { key: 'paid', label: l.paidKpi, value: s?.paid.total ?? '0', sub: plural(s?.paid.count ?? 0, 'conta', 'contas'), icon: CheckCircle2, tone: 'ok', onClick: () => onFilter('paid') },
    { key: '', label: 'Total do mês', value: s?.forecast.total ?? '0', sub: `${plural(s?.forecast.count ?? 0, 'conta', 'contas')} · ${plural(s?.categoriesActive ?? 0, 'categoria', 'categorias')}`, icon: Sigma, tone: 'plain', onClick: () => onFilter('') },
  ];
  return (
    // celular: faixa que rola para o lado (economiza a altura da tela); tablet/desktop: grade
    <div className="flex max-sm:snap-x max-sm:snap-mandatory max-sm:overflow-x-auto no-scrollbar sm:grid sm:grid-cols-3 xl:grid-cols-5 rounded-xl border border-line bg-surface shadow-card sm:overflow-hidden">
      {kpis.map((k, i) => {
        const Comp = k.onClick ? 'button' : 'div';
        const isActive = active === k.key;
        return (
          <Comp
            key={k.label} type={k.onClick ? 'button' : undefined} onClick={k.onClick}
            className={cn(
              'relative text-left p-3.5 sm:p-4 md:p-5 border-line transition-colors max-sm:w-[44%] max-sm:min-w-[150px] max-sm:shrink-0 max-sm:snap-start',
              i > 0 && 'border-l', i >= 3 && 'sm:max-xl:border-t', i === 3 && 'sm:max-xl:border-l-0', i === 4 && 'sm:max-xl:col-span-2',
              k.onClick && 'hover:bg-surface-2/70 cursor-pointer',
              isActive && 'bg-surface-2',
            )}
          >
            {isActive && <span className="absolute inset-x-0 bottom-0 h-[3px] bg-accent" />}
            <span className="flex items-center gap-2 text-[13px] text-muted"><k.icon className={cn('size-4', tones[k.tone])} />{k.label}</span>
            <CountUp value={k.value} className={cn('mt-2 block font-display text-[19px] sm:text-[22px] md:text-[26px] font-semibold leading-none whitespace-nowrap', k.tone === 'danger' && 'text-danger')} />
            <span className="mt-1.5 block text-xs text-faint truncate">{k.sub}</span>
          </Comp>
        );
      })}
    </div>
  );
}
