import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';
import { Loader2 } from 'lucide-react';
import { Checkbox as RCheckbox, Switch as RSwitch, Tooltip as RTooltip } from 'radix-ui';
import { Check, Minus } from 'lucide-react';
import { cn } from '@/lib/utils';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'ok' | 'outline';
const variants: Record<Variant, string> = {
  primary: 'bg-accent text-accent-ink hover:brightness-110 shadow-[0_6px_20px_-8px_var(--np-accent)]',
  secondary: 'bg-surface-2 text-ink border border-line hover:border-line-strong',
  outline: 'border border-line text-ink hover:bg-surface-2',
  ghost: 'text-muted hover:text-ink hover:bg-surface-2',
  danger: 'bg-danger text-white hover:brightness-110',
  ok: 'bg-ok text-[#06281a] hover:brightness-110',
};
const sizes = { sm: 'h-8 px-3 text-[13px] gap-1.5', md: 'h-10 px-4 text-sm gap-2', lg: 'h-12 px-5 text-[15px] gap-2' };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant; size?: keyof typeof sizes; loading?: boolean; icon?: ReactNode;
}
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', loading, icon, className, children, disabled, ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={cn(
        'inline-flex items-center justify-center rounded-lg font-medium transition-[background,filter,border,color,transform] active:scale-[.98] disabled:opacity-50 disabled:pointer-events-none whitespace-nowrap select-none',
        variants[variant], sizes[size], className,
      )}
      {...rest}
    >
      {loading ? <Loader2 className="size-4 animate-spin" /> : icon}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string; tone?: 'default' | 'danger' | 'ok' }>(
  function IconButton({ label, className, tone = 'default', children, ...rest }, ref) {
    return (
      <Tooltip content={label}>
        <button
          ref={ref}
          aria-label={label}
          className={cn(
            'inline-grid place-items-center size-8 pointer-coarse:size-10 rounded-md text-muted transition-colors hover:bg-surface-2 disabled:opacity-40',
            tone === 'danger' && 'hover:text-danger', tone === 'ok' && 'hover:text-ok', tone === 'default' && 'hover:text-ink',
            className,
          )}
          {...rest}
        >
          {children}
        </button>
      </Tooltip>
    );
  },
);

const fieldBase = 'w-full rounded-lg border border-line bg-surface-2 px-3 text-sm text-ink placeholder:text-faint transition-colors hover:border-line-strong focus:border-accent focus:outline-none focus:ring-3 focus:ring-accent/20 disabled:opacity-60';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cn(fieldBase, 'h-10', className)} {...rest} />;
});
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cn(fieldBase, 'py-2 min-h-[72px] resize-y', className)} {...rest} />;
});
/** Lista de escolha: ver `select.tsx` (lista própria no computador, nativa no toque). */
export { Select } from './select';

export function Field({ label, hint, error, children, className, required }: { label?: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; className?: string; required?: boolean }) {
  return (
    <label className={cn('flex flex-col gap-1.5 min-w-0', className)}>
      {label && <span className="text-[13px] font-medium text-muted">{label}{required && <span className="text-danger"> *</span>}</span>}
      {children}
      {error ? <span className="text-xs text-danger">{error}</span> : hint ? <span className="text-xs text-faint leading-relaxed">{hint}</span> : null}
    </label>
  );
}

export function Checkbox({ checked, onChange, disabled, label, className, indeterminate }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: ReactNode; className?: string; indeterminate?: boolean }) {
  const box = (
    <RCheckbox.Root
      checked={indeterminate ? 'indeterminate' : checked}
      onCheckedChange={(v) => onChange(v === true)}
      disabled={disabled}
      className="peer size-[18px] shrink-0 rounded-[5px] border border-line-strong bg-surface-2 grid place-items-center data-[state=checked]:bg-accent data-[state=checked]:border-accent data-[state=indeterminate]:bg-accent data-[state=indeterminate]:border-accent disabled:opacity-40 transition-colors"
    >
      <RCheckbox.Indicator className="text-accent-ink">
        {indeterminate ? <Minus className="size-3.5" strokeWidth={3} /> : <Check className="size-3.5" strokeWidth={3} />}
      </RCheckbox.Indicator>
    </RCheckbox.Root>
  );
  if (!label) return box;
  return <label className={cn('flex items-start gap-2.5 text-sm cursor-pointer select-none', className)}>{box}<span className="leading-[18px]">{label}</span></label>;
}

export function Switch({ checked, onChange, label, hint, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; hint?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cn('flex items-start justify-between gap-4', disabled ? 'cursor-not-allowed' : 'cursor-pointer')}>
      <span className="flex flex-col"><span className="text-sm font-medium">{label}</span>{hint && <span className="text-xs text-faint mt-0.5">{hint}</span>}</span>
      <RSwitch.Root checked={checked} disabled={disabled} onCheckedChange={onChange} className="relative h-6 w-10 shrink-0 rounded-full bg-line-strong data-[state=checked]:bg-accent transition-colors disabled:opacity-60">
        <RSwitch.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
      </RSwitch.Root>
    </label>
  );
}

export function Tooltip({ content, children, side = 'top' }: { content: ReactNode; children: ReactNode; side?: 'top' | 'bottom' | 'left' | 'right' }) {
  if (!content) return <>{children}</>;
  return (
    <RTooltip.Root delayDuration={250}>
      <RTooltip.Trigger asChild>{children}</RTooltip.Trigger>
      <RTooltip.Portal>
        <RTooltip.Content side={side} sideOffset={6} className="z-[9000] max-w-xs rounded-md bg-ink px-2.5 py-1.5 text-xs text-bg shadow-lg data-[state=delayed-open]:animate-in">
          {content}
        </RTooltip.Content>
      </RTooltip.Portal>
    </RTooltip.Root>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-5 animate-spin text-faint', className)} />;
}

export function Segmented<T extends string>({ value, onChange, options, className }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode }>; className?: string }) {
  return (
    <div role="radiogroup" className={cn('inline-flex max-w-full overflow-x-auto no-scrollbar rounded-lg bg-surface-2 border border-line p-0.5', className)}>
      {options.map((o) => (
        <button
          type="button" role="radio" aria-checked={value === o.value} key={o.value} onClick={() => onChange(o.value)}
          className={cn('h-8 pointer-coarse:h-9 px-3 rounded-md text-[13px] font-medium whitespace-nowrap transition-colors flex-1', value === o.value ? 'bg-raised text-ink shadow-card' : 'text-muted hover:text-ink')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn('min-w-0 rounded-xl border border-line bg-surface shadow-card', className)}>{children}</div>;
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <h1 className="font-display text-[24px] sm:text-[28px] leading-tight font-semibold">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted max-w-prose">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 max-sm:gap-1 max-sm:w-full">{actions}</div>}
    </div>
  );
}

export function Empty({ icon, title, children, action }: { icon?: ReactNode; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-16 px-6">
      {icon && <div className="mb-4 grid size-12 place-items-center rounded-2xl bg-accent-soft text-accent">{icon}</div>}
      <p className="font-display text-lg font-semibold">{title}</p>
      {children && <p className="mt-1 text-sm text-muted max-w-sm">{children}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}
