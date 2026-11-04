import { forwardRef, useEffect, useState, type InputHTMLAttributes } from 'react';
import { parseMoneyInput, toCents } from '@nopaper/shared';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/base';

const fmt = (v: string | null) => (v === null ? '' : (toCents(v) / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

/** Campo monetário: aceita "1.234,56" / "1234.56"; valor emitido é string decimal ("1234.56") ou "". */
export const MoneyInput = forwardRef<HTMLInputElement, Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & { value: string; onChange: (v: string) => void }>(
  function MoneyInput({ value, onChange, className, ...rest }, ref) {
    const [text, setText] = useState(fmt(value ? parseMoneyInput(value) : null));
    const [focused, setFocused] = useState(false);
    useEffect(() => { if (!focused) setText(value ? fmt(parseMoneyInput(value)) : ''); }, [value, focused]);
    return (
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-faint">R$</span>
        <Input
          ref={ref} inputMode="decimal" {...rest}
          className={cn('pl-9 tnum text-right', className)}
          value={text}
          onFocus={() => setFocused(true)}
          onChange={(e) => { setText(e.target.value); onChange(parseMoneyInput(e.target.value) ?? ''); }}
          onBlur={() => { setFocused(false); const p = parseMoneyInput(text); setText(p ? fmt(p) : ''); }}
        />
      </div>
    );
  },
);
