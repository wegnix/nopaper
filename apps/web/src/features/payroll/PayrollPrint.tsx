import { createPortal } from 'react-dom';
import { MONTHS_PT, formatBRL, formatDateBR, fromCents, sumMoney, toCents, type PayrollTotals } from '@nopaper/shared';
import { useOrg, useSession } from '@/lib/session';
import type { Employee, Entry, Period, Rubric } from './data';

/**
 * Folha do mês para imprimir (A4 paisagem), no formato da planilha antiga:
 * Funcionário | Líquido holerite | extras do mês (Meta global, Meta individual, Vitaminas…) |
 * Total salário | Descontos | Salário a pagar | Por fora.
 * As colunas de extras são as rubricas "fora do holerite" que somam e têm valor no mês, na ordem
 * definida em Configurar → Rubricas. Mesmo esquema do relatório: portal `.print-doc` no body.
 */
export function PayrollPrint({ period, rows, rubrics }: {
  period: Period; rows: Array<{ e: Entry; emp: Employee | undefined; t: PayrollTotals }>; rubrics: Rubric[];
}) {
  const org = useOrg();
  const user = useSession((s) => s.user);
  const extraCols = rubrics.filter((r) => r.section === 'extra' && r.kind === 'earning' && rows.some(({ e }) => e.lines.some((l) => l.rubricId === r.id && toCents(l.amount) !== 0)));
  const amountOf = (e: Entry, rubricId: string) => sumMoney(e.lines.filter((l) => l.rubricId === rubricId).map((l) => l.amount));
  const gross = (t: PayrollTotals) => fromCents(toCents(t.payslipNet) + toCents(t.extraEarnings));
  const money = (v: string) => (toCents(v) ? formatBRL(v) : '—');
  const sum = (f: (r: (typeof rows)[number]) => string) => sumMoney(rows.map(f));
  const [y, m] = period.ref.split('-').map(Number);
  const now = new Date();
  const generated = `${now.toLocaleDateString('pt-BR')} às ${now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;

  return createPortal(
    <div className="print-doc pd-payroll" aria-hidden>
      {/* só esta impressão é em paisagem (a regra vem depois da do index.css e a substitui) */}
      <style>{'@media print { @page { size: A4 landscape; margin: 10mm 10mm 12mm; } }'}</style>
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
          <tr>
            <th>Funcionário</th>
            <th className="num">Líquido holerite</th>
            {extraCols.map((r) => <th key={r.id} className="num">{r.name}</th>)}
            <th className="num">Total salário</th>
            <th className="num">Descontos</th>
            <th className="num pd-strong">Salário a pagar</th>
            <th className="num">Por fora</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ e, emp, t }) => (
            <tr key={e.id}>
              <td>{emp?.name ?? '—'}</td>
              <td className="num">{money(t.payslipNet)}</td>
              {extraCols.map((r) => <td key={r.id} className="num">{money(amountOf(e, r.id))}</td>)}
              <td className="num">{money(gross(t))}</td>
              <td className="num pd-neg">{toCents(t.extraDeductions) ? `− ${formatBRL(t.extraDeductions)}` : '—'}</td>
              <td className="num pd-strong">{formatBRL(t.total)}</td>
              <td className="num">{money(t.offPayroll)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td>Total ({rows.length})</td>
            <td className="num">{formatBRL(sum((r) => r.t.payslipNet))}</td>
            {extraCols.map((c) => <td key={c.id} className="num">{formatBRL(sum((r) => amountOf(r.e, c.id)))}</td>)}
            <td className="num">{formatBRL(sum((r) => gross(r.t)))}</td>
            <td className="num pd-neg">{toCents(sum((r) => r.t.extraDeductions)) ? `− ${formatBRL(sum((r) => r.t.extraDeductions))}` : '—'}</td>
            <td className="num pd-strong">{formatBRL(sum((r) => r.t.total))}</td>
            <td className="num">{formatBRL(sum((r) => r.t.offPayroll))}</td>
          </tr>
        </tfoot>
      </table>
      <p className="pd-foot">Total salário = líquido do holerite + extras. Salário a pagar = total salário − descontos. Por fora = o que passa do líquido do holerite.</p>
    </div>,
    document.body,
  );
}
