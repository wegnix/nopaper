import { createPortal } from 'react-dom';
import { MONTHS_PT, PAYROLL_PRINT_FIXED, formatBRL, formatDateBR, fromCents, printColumnOrder, sumMoney, toCents, type PayrollPrintSettings, type PayrollTotals } from '@nopaper/shared';
import { useOrg, useSession } from '@/lib/session';
import { PrintCompany } from '@/components/PrintCompany';
import type { Employee, Entry, Period, Rubric } from './data';

export type PrintRow = { e: Entry; emp: Employee | undefined; t: PayrollTotals };
type Row = PrintRow;

/** Extras "fora do holerite" (que somam) com valor no mês, na ordem de Configurar → Rubricas. */
export function extraColumnsOf(rows: Row[], rubrics: Rubric[]) {
  return rubrics.filter((r) => r.section === 'extra' && r.kind === 'earning' && rows.some(({ e }) => e.lines.some((l) => l.rubricId === r.id && toCents(l.amount) !== 0)));
}
export const amountOf = (e: Entry, rubricId: string) => sumMoney(e.lines.filter((l) => l.rubricId === rubricId).map((l) => l.amount));

/** Colunas do mês (depois de "Funcionário") na ordem salva: chaves fixas + ids dos extras com valor. */
export function printColumnsOf(extras: Rubric[], order: string[]) {
  return printColumnOrder(['net', ...extras.map((r) => r.id), 'gross', 'deductions', 'total', 'off'], order);
}

/**
 * Folha do mês para imprimir (A4 paisagem), no formato da planilha antiga:
 * Funcionário | Líquido holerite | extras do mês (Meta global, Meta individual, Vitaminas…) |
 * Total salário | Descontos | Salário a pagar | Por fora.
 * `print.order` = ordem das colunas; `print.hidden` = colunas desmarcadas na janela de impressão (chaves fixas ou ids de rubricas). Extra
 * escondido com valor no mês vai para "Outros extras", para a linha continuar fechando no papel.
 * Mesmo esquema do relatório: portal `.print-doc` no body.
 */
export function PayrollPrint({ period, rows, rubrics, print }: { period: Period; rows: Row[]; rubrics: Rubric[]; print: PayrollPrintSettings }) {
  const org = useOrg();
  const user = useSession((s) => s.user);
  const show = (k: string) => !print.hidden.includes(k);
  const extras = extraColumnsOf(rows, rubrics);
  const hiddenExtras = extras.filter((r) => !show(r.id));
  const others = (e: Entry) => sumMoney(hiddenExtras.map((r) => amountOf(e, r.id)));
  const gross = (t: PayrollTotals) => fromCents(toCents(t.payslipNet) + toCents(t.extraEarnings));
  const money = (v: string) => (toCents(v) ? formatBRL(v) : '—');
  const neg = (v: string) => (toCents(v) ? `− ${formatBRL(v)}` : '—');
  const sum = (f: (r: Row) => string) => sumMoney(rows.map(f));
  const [y, m] = period.ref.split('-').map(Number);
  const now = new Date();
  const generated = `${now.toLocaleDateString('pt-BR')} às ${now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  type Col = { key: string; label: string; cell: (r: Row) => string; foot: string; cls?: string };
  const fixedLabel = (k: string) => PAYROLL_PRINT_FIXED.find((f) => f.key === k)!.label;
  const build: Record<string, Col> = {
    net: { key: 'net', label: fixedLabel('net'), cell: (r) => money(r.t.payslipNet), foot: formatBRL(sum((r) => r.t.payslipNet)) },
    gross: { key: 'gross', label: fixedLabel('gross'), cell: (r) => money(gross(r.t)), foot: formatBRL(sum((r) => gross(r.t))) },
    deductions: { key: 'deductions', label: fixedLabel('deductions'), cell: (r) => neg(r.t.extraDeductions), foot: neg(sum((r) => r.t.extraDeductions)), cls: 'pd-neg' },
    total: { key: 'total', label: fixedLabel('total'), cell: (r) => formatBRL(r.t.total), foot: formatBRL(sum((r) => r.t.total)), cls: 'pd-strong' },
    off: { key: 'off', label: fixedLabel('off'), cell: (r) => money(r.t.offPayroll), foot: formatBRL(sum((r) => r.t.offPayroll)) },
    others: { key: 'others', label: 'Outros extras', cell: (r) => money(others(r.e)), foot: formatBRL(sum((r) => others(r.e))) },
  };
  for (const c of extras) build[c.id] = { key: c.id, label: c.name, cell: (r) => money(amountOf(r.e, c.id)), foot: formatBRL(sum((r) => amountOf(r.e, c.id))) };
  const keys = printColumnsOf(extras, print.order);
  // "Outros extras" fica logo depois do último extra da ordem (visível ou não)
  if (hiddenExtras.length) {
    const last = Math.max(...extras.map((r) => keys.indexOf(r.id)));
    keys.splice(last + 1, 0, 'others');
  }
  const cols = keys.filter((k) => k === 'others' || show(k)).map((k) => build[k]!);

  return createPortal(
    <div className="print-doc pd-payroll" aria-hidden>
      {/* só esta impressão é em paisagem (a regra vem depois da do index.css e a substitui) */}
      <style>{'@media print { @page { size: A4 landscape; margin: 10mm 10mm 12mm; } }'}</style>
      <PrintCompany />
      <header className="pd-head">
        <div>
          <p className="pd-kicker">NoPaper · {org?.name}</p>
          <h1>Folha de pagamento — {MONTHS_PT[m - 1]}/{y}</h1>
        </div>
        <p className="pd-meta">
          {period.billsEnabled ? <>Pagamento em {formatDateBR(period.payDate)}<br /></> : null}
          Gerado em {generated}{user ? ` por ${user.name}` : ''}
        </p>
      </header>

      <table className="pd-sheet">
        <thead>
          <tr><th>Funcionário</th>{cols.map((c) => <th key={c.key} className={`num ${c.cls === 'pd-strong' ? 'pd-strong' : ''}`}>{c.label}</th>)}</tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.e.id}><td>{r.emp?.name ?? '—'}</td>{cols.map((c) => <td key={c.key} className={`num ${c.cls ?? ''}`}>{c.cell(r)}</td>)}</tr>
          ))}
        </tbody>
        <tfoot>
          <tr><td>Total ({rows.length})</td>{cols.map((c) => <td key={c.key} className={`num ${c.cls ?? ''}`}>{c.foot}</td>)}</tr>
        </tfoot>
      </table>
      <p className="pd-foot">
        Total salário = líquido do holerite + extras. Salário a pagar = total salário − descontos. Por fora = o que passa do líquido do holerite.
        {hiddenExtras.length > 0 && <> Outros extras: {hiddenExtras.map((r) => r.name).join(', ')}.</>}
      </p>
    </div>,
    document.body,
  );
}
