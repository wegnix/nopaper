import type { Wallet } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CountUp } from '@/features/bills/KpiRibbon';

/** Número do topo do mês da folha (6 por linha no computador, 3 no tablet, rolando no celular). */
export function Kpi({ icon: Icon, label, value, sub, tone, first }: { icon: typeof Wallet; label: string; value: string; sub: string; tone?: 'accent'; first?: boolean }) {
  return (
    <div className={cn('p-3.5 sm:p-4 md:p-5 border-line max-sm:w-[44%] max-sm:min-w-[150px] max-sm:shrink-0 max-sm:snap-start', !first && 'border-l', 'sm:max-xl:[&:nth-child(3n+1)]:border-l-0 sm:max-xl:[&:nth-child(n+4)]:border-t')}>
      <span className="flex items-center gap-2 text-[13px] text-muted"><Icon className={cn('size-4', tone === 'accent' ? 'text-accent' : 'text-faint')} />{label}</span>
      <CountUp value={value} className="mt-2 block font-display text-[19px] sm:text-[22px] font-semibold leading-none whitespace-nowrap" />
      <span className="mt-1.5 block truncate text-xs text-faint">{sub}</span>
    </div>
  );
}

export const KPI_STRIP = 'flex max-sm:snap-x max-sm:snap-mandatory max-sm:overflow-x-auto no-scrollbar sm:grid sm:grid-cols-3 xl:grid-cols-6 border-b border-line';
