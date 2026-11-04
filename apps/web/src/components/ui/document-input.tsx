import { useState } from 'react';
import { CheckCircle2 } from 'lucide-react';
import { documentError, documentKind, formatDocument, normalizeDocument } from '@nopaper/shared';
import { Field, Input } from './base';

/**
 * CPF/CNPJ com máscara automática (pontos, barra e traço) e validação dos dígitos.
 * Aceita o CNPJ alfanumérico. O erro aparece ao sair do campo ou quando o número fica completo.
 */
export function DocumentField({ value, onChange, label = 'CPF / CNPJ', className }: {
  value: string; onChange: (v: string) => void; label?: string; className?: string;
}) {
  const [touched, setTouched] = useState(false);
  const n = normalizeDocument(value);
  const kind = documentKind(value);
  const complete = kind === 'cpf' ? n.length === 11 : n.length === 14;
  const err = documentError(value);
  const showErr = !!err && (touched || complete);
  const ok = !!n && !err;
  return (
    <Field label={label} className={className} error={showErr ? err : null}
      hint={ok ? <span className="inline-flex items-center gap-1 text-ok"><CheckCircle2 className="size-3.5" />{kind === 'cpf' ? 'CPF válido' : 'CNPJ válido'}</span> : 'Só os números: pontos e traço entram sozinhos.'}>
      <Input
        value={value} inputMode={/[A-Z]/i.test(n) ? 'text' : 'numeric'} autoComplete="off" spellCheck={false} maxLength={18}
        placeholder="000.000.000-00 ou 00.000.000/0000-00" aria-invalid={showErr || undefined}
        className={showErr ? 'border-danger focus:ring-danger/30' : undefined}
        onChange={(e) => onChange(formatDocument(e.target.value))} onBlur={() => setTouched(true)}
      />
    </Field>
  );
}
