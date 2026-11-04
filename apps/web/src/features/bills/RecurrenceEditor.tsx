import { formatBRL, isPeriodic, MAX_OCCURRENCES, occurrenceDate, sumMoney, type PeriodicType, type RecurrenceType } from '@nopaper/shared';
import { Infinity as InfinityIcon } from 'lucide-react';
import { Checkbox, Field, Input, Segmented } from '@/components/ui/base';
import { MoneyInput } from './MoneyInput';
import { RECURRENCE_LABEL } from './labels';

export interface RecState {
  type: RecurrenceType;
  indefinite: boolean;
  count: number;
  sameValue: boolean;
  /** Parcelado: número da 1ª parcela lançada. */
  first: number;
  rows: Array<{ date: string; amount: string }>;
}
/** Textos de cada repetição periódica (quantidade, janela da repetição sem fim, intervalo). */
const PERIODIC: Record<PeriodicType, { count: string; window: string; step: string; examples: string }> = {
  weekly: { count: 'Quantas semanas', window: 'as próximas 26 semanas (6 meses) lançadas', step: 'uma semana', examples: 'academia, diarista, feira…' },
  biweekly: { count: 'Quantas quinzenas', window: 'as próximas 13 quinzenas (6 meses) lançadas', step: 'duas semanas', examples: 'diarista quinzenal, mesada…' },
  monthly: { count: 'Quantos meses', window: 'os próximos 24 meses lançados', step: 'um mês', examples: 'aluguel, salário, internet…' },
  yearly: { count: 'Quantos anos', window: 'os próximos 5 anos lançados', step: 'um ano', examples: 'IPVA, seguro, anuidade…' },
};

export const initialRec = (type: RecurrenceType = 'once', indefinite = false): RecState => ({ type, indefinite, count: 12, sameValue: true, first: 1, rows: [] });

/** Recalcula a grade de ocorrências preservando valores/datas já digitados. */
export function syncRows(rec: RecState, dueDate: string, amount: string): RecState['rows'] {
  const n = rec.type === 'installments' ? rec.count : rec.count;
  const out: RecState['rows'] = [];
  for (let i = 0; i < n; i++) {
    const prev = rec.rows[i];
    out.push({
      date: prev?.date ?? (dueDate ? occurrenceDate(rec.type === 'installments' ? 'monthly' : rec.type, dueDate, i) : ''),
      amount: prev?.amount ?? amount,
    });
  }
  return out;
}

export function needsRows(rec: RecState) {
  return rec.type === 'installments' || (isPeriodic(rec.type) && rec.type !== 'yearly' && !rec.indefinite && !rec.sameValue);
}

export function recPayload(rec: RecState, dueDate: string, amount: string) {
  const base = { recurrenceType: rec.type, dueDate, isIndefinite: rec.indefinite && isPeriodic(rec.type) };
  if (rec.type === 'once') return { ...base, amount };
  if (rec.type === 'installments') {
    const rows = syncRows(rec, dueDate, amount);
    return { ...base, installmentAmounts: rows.map((r) => r.amount), installmentDueDates: rows.map((r) => r.date), firstInstallment: rec.first };
  }
  if (rec.indefinite) return { ...base, amount };
  if (needsRows(rec)) {
    const rows = syncRows(rec, dueDate, amount);
    return { ...base, amount: rows[0]?.amount, installmentAmounts: rows.map((r) => r.amount), installmentDueDates: rows.map((r) => r.date) };
  }
  return { ...base, amount, totalOccurrences: rec.count };
}

export function RecurrenceEditor({ rec, setRec, dueDate, amount, allowOnce = true }: {
  rec: RecState; setRec: (r: RecState) => void; dueDate: string; amount: string; allowOnce?: boolean;
}) {
  const types = (['once', 'weekly', 'biweekly', 'monthly', 'yearly', 'installments'] as RecurrenceType[]).filter((t) => allowOnce || t !== 'once');
  const per = isPeriodic(rec.type) ? PERIODIC[rec.type] : null;
  const max = rec.type === 'yearly' ? 10 : MAX_OCCURRENCES;
  const rows = needsRows(rec) ? syncRows(rec, dueDate, amount) : [];
  const setRow = (i: number, patch: Partial<{ date: string; amount: string }>) => {
    const r = [...rows];
    r[i] = { ...r[i], ...patch };
    setRec({ ...rec, rows: r });
  };
  return (
    <div className="flex flex-col gap-4">
      <Segmented value={rec.type} onChange={(type) => setRec({ ...rec, type, rows: [], count: type === 'yearly' ? Math.min(rec.count, 5) : rec.count })} options={types.map((t) => ({ value: t, label: RECURRENCE_LABEL[t] }))} className="w-full" />

      {per && (
        <Checkbox
          checked={rec.indefinite} onChange={(indefinite) => setRec({ ...rec, indefinite })}
          label={<span><span className="font-medium inline-flex items-center gap-1"><InfinityIcon className="size-4 text-accent" /> Repetir sem data para acabar</span><span className="block text-xs text-faint mt-0.5">Para {per.examples} O NoPaper mantém {per.window} e cria os seguintes sozinho. Dá para parar quando quiser.</span></span>}
        />
      )}

      {rec.type !== 'once' && !rec.indefinite && (
        <div className="grid sm:grid-cols-2 gap-4 items-end">
          <Field label={rec.type === 'installments' ? (rec.first > 1 ? 'Parcelas que faltam' : 'Número de parcelas') : per?.count}>
            <Input type="number" min={1} max={max} value={rec.count} onChange={(e) => setRec({ ...rec, count: Math.max(1, Math.min(max, Number(e.target.value) || 1)), rows: rec.rows.slice(0, Math.max(1, Math.min(max, Number(e.target.value) || 1))) })} />
          </Field>
          {per && rec.type !== 'yearly' && (
            <Checkbox className="pb-2.5" checked={rec.sameValue} onChange={(sameValue) => setRec({ ...rec, sameValue, rows: [] })} label="Mesmo valor em todas" />
          )}
          {rec.type === 'installments' && (
            <Field label="Começar na parcela nº" hint={rec.first > 1 ? `Lança da ${rec.first}/${rec.first - 1 + rec.count} até a ${rec.first - 1 + rec.count}/${rec.first - 1 + rec.count}.` : 'Se parte já foi paga, informe o nº da próxima.'}>
              <Input type="number" min={1} max={MAX_OCCURRENCES} value={rec.first} onChange={(e) => setRec({ ...rec, first: Math.max(1, Math.min(MAX_OCCURRENCES, Number(e.target.value) || 1)) })} />
            </Field>
          )}
        </div>
      )}

      {rows.length > 0 && (
        <div className="rounded-xl border border-line bg-surface-2/50">
          <div className="flex items-center justify-between px-3 py-2 border-b border-line text-xs text-muted">
            <span>{rec.type === 'installments' ? 'Parcelas' : 'Valor e vencimento de cada uma'}</span>
            <span className="tnum">Total {formatBRL(sumMoney(rows.map((r) => r.amount)))}</span>
          </div>
          <div className="max-h-64 overflow-y-auto p-2 grid sm:grid-cols-2 gap-2">
            {rows.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-14 shrink-0 text-right text-xs text-faint tnum">{rec.type === 'installments' ? `${rec.first + i}/${rec.first - 1 + rows.length}` : `${i + 1}º`}</span>
                <Input type="date" value={r.date} onChange={(e) => setRow(i, { date: e.target.value })} className="h-9 px-2" />
                <MoneyInput value={r.amount} onChange={(v) => setRow(i, { amount: v })} className="h-9" />
              </div>
            ))}
          </div>
          <p className="px-3 pb-2 text-xs text-faint">As datas partem do vencimento informado e somam {per?.step ?? 'um mês'} cada. Ajuste qualquer linha se precisar.</p>
        </div>
      )}
    </div>
  );
}
