import { Children, Fragment, forwardRef, isValidElement, useSyncExternalStore, type ChangeEvent, type ReactNode, type SelectHTMLAttributes } from 'react';
import { Select as RS } from 'radix-ui';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

/**
 * Lista de escolha do NoPaper. Mesma API do <select> (filhos <option>/<optgroup>, `value`,
 * `onChange(e)` com `e.target.value`), mas no computador abre uma lista própria: a lista nativa
 * fecha sozinha ao soltar o clique em alguns sistemas (Linux/GTK) e dentro de diálogos animados.
 * No celular/tablet (toque) continua a nativa — o seletor do iOS/Android funciona bem.
 */
const fieldBase = 'w-full rounded-lg border border-line bg-surface-2 px-3 text-sm text-ink transition-colors hover:border-line-strong focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-60';
const nativeArrow = 'pr-8 appearance-none bg-[url("data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2716%27 height=%2716%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%238a93a8%27 stroke-width=%272%27%3E%3Cpath d=%27m6 9 6 6 6-6%27/%3E%3C/svg%3E")] bg-no-repeat bg-[right_10px_center]';

const coarseQuery = '(pointer: coarse)';
const subscribe = (cb: () => void) => { const m = window.matchMedia(coarseQuery); m.addEventListener('change', cb); return () => m.removeEventListener('change', cb); };
const isCoarse = () => window.matchMedia(coarseQuery).matches;
const useCoarse = () => useSyncExternalStore(subscribe, isCoarse, () => false);

/** Radix não aceita valor vazio num item: "" vira esta marca e volta ao avisar a mudança. */
const EMPTY = '__np_empty__';
const enc = (v: string) => (v === '' ? EMPTY : v);
const dec = (v: string) => (v === EMPTY ? '' : v);

interface Opt { value: string; text: string; disabled?: boolean }
interface Group { label?: string; options: Opt[] }

const textOf = (n: ReactNode): string => Children.toArray(n).map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : isValidElement<{ children?: ReactNode }>(c) ? textOf(c.props.children) : '')).join('');

/** Lê os <option>/<optgroup> (com fragmentos, listas e condicionais) para os itens da lista própria. */
function parseOptions(children: ReactNode): Group[] {
  const groups: Group[] = [];
  let loose: Group | null = null;
  const walk = (nodes: ReactNode, group: Group | null) => Children.forEach(nodes, (c) => {
    if (!isValidElement<{ children?: ReactNode; label?: string; value?: string | number; disabled?: boolean }>(c)) return;
    if (c.type === Fragment) { walk(c.props.children, group); return; }
    if (c.type === 'optgroup') { const g: Group = { label: c.props.label, options: [] }; groups.push(g); loose = null; walk(c.props.children, g); return; }
    if (c.type === 'option') {
      const text = textOf(c.props.children);
      const o: Opt = { value: String(c.props.value ?? text), text, disabled: c.props.disabled };
      if (group) group.options.push(o);
      else { if (!loose) { loose = { options: [] }; groups.push(loose); } loose.options.push(o); }
    }
  });
  walk(children, null);
  return groups.filter((g) => g.options.length);
}

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, value, onChange, disabled, id, title, ...rest }, ref) {
  const coarse = useCoarse();
  if (coarse) {
    return <select ref={ref} id={id} title={title} value={value} onChange={onChange} disabled={disabled} className={cn(fieldBase, 'h-10', nativeArrow, className)} {...rest}>{children}</select>;
  }
  const groups = parseOptions(children);
  const all = groups.flatMap((g) => g.options);
  const cur = String(value ?? '');
  // como o <select> nativo: valor que não está na lista mostra a 1ª opção
  const shown = all.find((o) => o.value === cur) ?? all[0];
  const emit = (v: string) => onChange?.({ target: { value: v }, currentTarget: { value: v } } as unknown as ChangeEvent<HTMLSelectElement>);
  return (
    <RS.Root value={enc(cur)} onValueChange={(v) => emit(dec(v))} disabled={disabled}>
      <RS.Trigger id={id} title={title} aria-label={rest['aria-label']} autoFocus={rest.autoFocus}
        className={cn(fieldBase, 'group inline-flex h-10 min-w-0 items-center justify-between gap-2 text-left data-[state=open]:border-accent', className)}>
        <span className="min-w-0 flex-1 truncate">{shown?.text ?? ''}</span>
        <ChevronDown className="size-4 shrink-0 text-faint transition-transform group-data-[state=open]:rotate-180" />
      </RS.Trigger>
      <RS.Portal>
        <RS.Content position="popper" sideOffset={4} collisionPadding={8}
          className="z-[6000] max-h-[min(24rem,var(--radix-select-content-available-height))] min-w-[var(--radix-select-trigger-width)] max-w-[min(94vw,34rem)] overflow-hidden rounded-xl border border-line bg-raised shadow-2xl">
          <RS.Viewport className="p-1">
            {groups.map((g, gi) => (
              <RS.Group key={gi}>
                {g.label && <RS.Label className="px-2.5 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-faint">{g.label}</RS.Label>}
                {g.options.map((o) => (
                  <RS.Item key={o.value} value={enc(o.value)} disabled={o.disabled}
                    className="relative flex cursor-pointer select-none items-center rounded-lg py-1.5 pl-7 pr-2.5 text-sm text-ink outline-none data-[disabled]:cursor-default data-[highlighted]:bg-surface-2 data-[disabled]:text-faint data-[state=checked]:font-medium">
                    <RS.ItemIndicator className="absolute left-2 inline-flex"><Check className="size-3.5 text-accent" /></RS.ItemIndicator>
                    <RS.ItemText>{o.text}</RS.ItemText>
                  </RS.Item>
                ))}
                {gi < groups.length - 1 && g.label !== undefined && <RS.Separator className="my-1 h-px bg-line" />}
              </RS.Group>
            ))}
          </RS.Viewport>
        </RS.Content>
      </RS.Portal>
    </RS.Root>
  );
});
