import { useState } from 'react';
import { Popover } from 'radix-ui';
import { CalendarDays, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Escolha de um dia do mês (1–31) numa grade, no lugar de um <select> com 31 opções — a lista
 * nativa longa fechava sozinha dentro dos diálogos em alguns navegadores e é ruim no celular.
 * `special`: opção extra acima da grade (ex.: 0 = "5º dia útil").
 */
export function DayPicker({ value, onChange, special, id, disabled, className, 'aria-label': ariaLabel }: {
  value: number; onChange: (d: number) => void; special?: { value: number; label: string }; id?: string; disabled?: boolean;
  className?: string; 'aria-label'?: string;
}) {
  const [open, setOpen] = useState(false);
  const pick = (d: number) => { onChange(d); setOpen(false); };
  const label = special && value === special.value ? special.label : `Dia ${value}`;
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild disabled={disabled}>
        <button type="button" id={id} aria-label={ariaLabel}
          className={cn('flex h-10 w-full items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 text-left text-sm text-ink transition-colors hover:border-line-strong focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-60 data-[state=open]:border-accent', className)}>
          <CalendarDays className="size-4 shrink-0 text-faint" />
          <span className="flex-1 truncate tnum">{label}</span>
          <ChevronDown className="size-4 shrink-0 text-faint" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} collisionPadding={12}
          className="z-[6000] w-[min(296px,calc(100vw-24px))] rounded-xl border border-line bg-raised p-2 shadow-2xl">
          {special && (
            <button type="button" onClick={() => pick(special.value)}
              className={cn('mb-1.5 h-9 pointer-coarse:h-11 w-full rounded-lg text-sm transition-colors',
                value === special.value ? 'bg-accent font-semibold text-accent-ink' : 'bg-surface-2 text-ink hover:bg-line')}>
              {special.label}
            </button>
          )}
          <div role="radiogroup" aria-label="Dia do mês" className="grid grid-cols-7 gap-1">
            {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
              <button key={d} type="button" role="radio" aria-checked={value === d} onClick={() => pick(d)}
                className={cn('h-9 pointer-coarse:h-10 rounded-md text-[13px] tnum transition-colors',
                  value === d ? 'bg-accent font-semibold text-accent-ink' : 'text-muted hover:bg-surface-2 hover:text-ink')}>
                {d}
              </button>
            ))}
          </div>
          <p className="mt-2 px-1 text-[11px] leading-snug text-faint">Em meses mais curtos, os dias 29 a 31 viram o último dia do mês.</p>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
