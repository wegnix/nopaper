import { useEffect, useState } from 'react';
import { BANK_NAMES, normBank } from '@nopaper/shared';
import { Field } from './base';
import { Combobox } from './combobox';

const BANKS = Object.entries(BANK_NAMES).sort((a, b) => a[1].localeCompare(b[1], 'pt-BR'));
const bankText = (code: string | null) => (code ? `${BANK_NAMES[code] ?? 'Banco'} (${code})` : '');
const BANK_OPTIONS = BANKS.map(([code]) => bankText(code));

const codeOf = (t: string): string | null => {
  const v = t.trim();
  if (!v) return null;
  const m = /\((\d{1,4})\)\s*$/.exec(v) ?? /^(\d{1,4})$/.exec(v);
  if (m) return normBank(m[1]);
  const byName = BANKS.find(([, n]) => n.toLowerCase() === v.toLowerCase());
  return byName ? byName[0] : null;
};

/**
 * Banco com busca: digite o nome ou o código (3 números); o escolhido aparece como "Sicoob (756)".
 * Campo próprio em vez do <select> nativo, que alguns navegadores desenham fora do lugar dentro
 * de diálogos animados.
 */
export function BankPicker({ value, onChange, label = 'Banco', className }: { value: string | null; onChange: (code: string | null) => void; label?: string; className?: string }) {
  const [text, setText] = useState(bankText(value));
  useEffect(() => { setText((t) => (codeOf(t) === value ? t : bankText(value))); }, [value]);
  const code = codeOf(text);
  return (
    <Field label={label} className={className} hint={text.trim() && !code ? 'Escolha da lista ou digite o código do banco (3 números).' : code ? undefined : 'Digite o nome ou o código.'}>
      <Combobox value={text} options={BANK_OPTIONS} maxLength={60} placeholder="Ex.: Sicoob, Itaú, 756"
        onChange={(t) => { setText(t); const c = codeOf(t); if (c !== value && (c || !t.trim())) onChange(c); }} />
    </Field>
  );
}
