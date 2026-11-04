import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { Popover } from 'radix-ui';
import { normText } from '@nopaper/shared';
import { cn } from '@/lib/utils';
import { Input } from './base';

/**
 * Campo de texto livre com sugestões — substitui o <datalist> nativo, que o navegador
 * desenha fora do tema e mal posicionado dentro de diálogos animados.
 */
export function Combobox({ value, onChange, options, placeholder, maxLength, className }: {
  value: string; onChange: (v: string) => void; options: readonly string[]; placeholder?: string; maxLength?: number; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [typed, setTyped] = useState(false);
  const listId = useId();
  const items = useMemo(() => {
    const q = normText(value);
    // ao abrir com um valor já escolhido, mostra todas; filtra só depois de digitar
    return !typed || !q ? [...options] : options.filter((o) => normText(o).includes(q));
  }, [options, value, typed]);

  const pick = (v: string) => { onChange(v); setOpen(false); setTyped(false); };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); if (!open) setOpen(true); setActive((a) => Math.min(items.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter' && open && items[active]) { e.preventDefault(); pick(items[active]); }
    else if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); }
  };

  return (
    <Popover.Root open={open && items.length > 0} onOpenChange={setOpen}>
      <Popover.Anchor asChild>
        <Input
          value={value} maxLength={maxLength} placeholder={placeholder} className={className}
          role="combobox" aria-expanded={open} aria-controls={listId} aria-autocomplete="list" autoComplete="off"
          onFocus={() => { setOpen(true); setActive(0); }}
          onClick={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onChange={(e) => { onChange(e.target.value); setTyped(true); setOpen(true); setActive(0); }}
          onKeyDown={onKey}
        />
      </Popover.Anchor>
      <Popover.Portal>
        <Popover.Content
          align="start" sideOffset={4} onOpenAutoFocus={(e) => e.preventDefault()} onCloseAutoFocus={(e) => e.preventDefault()}
          className="z-[6000] max-h-64 w-[var(--radix-popover-trigger-width)] overflow-auto rounded-xl border border-line bg-raised p-1 shadow-2xl"
        >
          <ul id={listId} role="listbox">
            {items.map((o, i) => (
              <li key={o} role="option" aria-selected={i === active}
                onMouseDown={(e) => { e.preventDefault(); pick(o); }} onMouseEnter={() => setActive(i)}
                className={cn('cursor-pointer rounded-lg px-2.5 py-1.5 text-sm', i === active ? 'bg-surface-2 text-ink' : 'text-muted', normText(o) === normText(value) && 'font-medium text-ink')}>
                {o}
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
