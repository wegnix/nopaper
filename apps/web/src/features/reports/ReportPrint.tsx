import { createPortal } from 'react-dom';
import { COLOR_PRESETS, isColorKey, MONTHS_PT, MONTHS_PT_SHORT, formatBRL, toCents } from '@nopaper/shared';
import { useOrg, useSession } from '@/lib/session';
import type { Category, Folder } from '@/lib/types';
import { compact, niceMax, pct } from './format';
import type { MonthRow, Report } from './ReportsPage';

/**
 * Versão de impressão do relatório: documento A4 claro (independe do tema da tela),
 * só com cabeçalho, totais e tabelas. Fica fora do #root (portal no body) e só aparece
 * em @media print — o CSS em index.css esconde o resto da página quando ela existe.
 */
export function ReportPrint({ report: r, catMap, folderMap }: { report: Report; catMap: Map<string, Category>; folderMap: Map<string, Folder> }) {
  const org = useOrg();
  const user = useSession((s) => s.user);
  const payable = r.type === 'payable';
  const word = payable ? { done: 'Pago', open: 'A pagar', verb: 'pago' } : { done: 'Recebido', open: 'A receber', verb: 'recebido' };
  const total = toCents(r.totals.total);
  const prev = toCents(r.totals.previousYear);
  const delta = prev ? ((total - prev) / prev) * 100 : null;
  const now = new Date();
  const generated = `${now.toLocaleDateString('pt-BR')} às ${now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  const older = toCents(r.olderOverdue.total);
  const dot = (color?: string) => color ? <i className="pd-dot" style={{ background: COLOR_PRESETS[isColorKey(color) ? color : 'slate'].base }} /> : null;

  return createPortal(
    <div className="print-doc" aria-hidden>
      <header className="pd-head">
        <div>
          <p className="pd-kicker">NoPaper · {org?.name}</p>
          <h1>Relatório de contas a {payable ? 'pagar' : 'receber'} — {r.year}</h1>
        </div>
        <p className="pd-meta">Gerado em {generated}{user ? <><br />por {user.name}</> : null}</p>
      </header>

      <section className="pd-kpis">
        <div>
          <span>Total no ano</span>
          <b>{formatBRL(r.totals.total)}</b>
          <small>{r.totals.count} {r.totals.count === 1 ? 'conta' : 'contas'}{delta !== null && <> · {delta >= 0 ? '+' : ''}{delta.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% vs {r.year - 1}</>}</small>
        </div>
        <div>
          <span>{word.done}</span>
          <b>{formatBRL(r.totals.paid)}</b>
          <small>{pct(toCents(r.totals.paid), total)}% do total</small>
        </div>
        <div>
          <span>{word.open}</span>
          <b>{formatBRL(r.totals.pending)}</b>
          <small>vencimentos até dez/{r.year}</small>
        </div>
        <div>
          <span>Vencido sem baixa</span>
          <b className={toCents(r.totals.overdue) > 0 ? 'pd-neg' : undefined}>{formatBRL(r.totals.overdue)}</b>
          <small>{older > 0 ? `+ ${formatBRL(r.olderOverdue.total)} de anos anteriores` : 'em ' + r.year}</small>
        </div>
      </section>

      <section className="pd-block">
        <h2>Mês a mês</h2>
        <PrintChart months={r.months} labels={word} />
        <MonthTable months={r.months} payable={payable} labels={word} />
      </section>

      <section className="pd-block">
        <h2>Por categoria</h2>
        {r.byCategory.length ? (
          <table>
            <thead><tr><th>Categoria</th><th className="num">Contas</th><th className="num">Total</th><th className="num">% do total</th><th className="num">% {word.verb}</th></tr></thead>
            <tbody>
              {r.byCategory.map((c) => {
                const cat = catMap.get(c.categoryId);
                return (
                  <tr key={c.categoryId}>
                    <td>{dot(cat?.color)}{cat?.label ?? '—'}</td>
                    <td className="num">{c.count}</td>
                    <td className="num">{formatBRL(c.total)}</td>
                    <td className="num">{pct(toCents(c.total), total)}%</td>
                    <td className="num">{pct(toCents(c.paid), toCents(c.total))}%</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot><tr><td>Total</td><td className="num">{r.totals.count}</td><td className="num">{formatBRL(r.totals.total)}</td><td className="num">100%</td><td className="num">{pct(toCents(r.totals.paid), total)}%</td></tr></tfoot>
          </table>
        ) : <p className="pd-empty">Nada no período.</p>}
      </section>

      {r.byFolder.length > 1 && (
        <section className="pd-block">
          <h2>Por pasta</h2>
          <table>
            <thead><tr><th>Pasta</th><th className="num">Contas</th><th className="num">Total</th><th className="num">% do total</th></tr></thead>
            <tbody>
              {r.byFolder.map((f) => {
                const folder = f.folderId ? folderMap.get(f.folderId) : undefined;
                return (
                  <tr key={f.folderId ?? 'none'}>
                    <td>{dot(folder?.color)}{f.folderId ? folder?.label ?? '—' : 'Sem pasta'}</td>
                    <td className="num">{f.count}</td>
                    <td className="num">{formatBRL(f.total)}</td>
                    <td className="num">{pct(toCents(f.total), total)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      <section className="pd-block">
        <h2>Maiores contas do ano</h2>
        {r.top.length ? (
          <table>
            <thead><tr><th className="pd-rank">#</th><th>Descrição</th><th className="num">Lançamentos</th><th className="num">Total</th></tr></thead>
            <tbody>
              {r.top.map((t, i) => (
                <tr key={t.description}><td className="pd-rank">{i + 1}</td><td>{t.description}</td><td className="num">{t.count}</td><td className="num">{formatBRL(t.total)}</td></tr>
              ))}
            </tbody>
          </table>
        ) : <p className="pd-empty">Sem contas em {r.year}.</p>}
      </section>

      {r.cards && r.cards.length > 0 && (() => {
        const cardsTotal = r.cards.reduce((a, c) => a + toCents(c.total), 0);
        return (
          <section className="pd-block">
            <h2>Dentro das faturas de cartão</h2>
            <p className="pd-note">Compras por categoria nas faturas que vencem em {r.year}. Já estão somadas acima como “Fatura”.</p>
            <table>
              <thead><tr><th>Categoria</th><th className="num">Lançamentos</th><th className="num">Total</th><th className="num">%</th></tr></thead>
              <tbody>
                {r.cards.map((c) => {
                  const cat = catMap.get(c.categoryId);
                  return <tr key={c.categoryId}><td>{dot(cat?.color)}{cat?.label ?? '—'}</td><td className="num">{c.count}</td><td className="num">{formatBRL(c.total)}</td><td className="num">{pct(toCents(c.total), cardsTotal)}%</td></tr>;
                })}
              </tbody>
              <tfoot><tr><td>Total</td><td className="num">{r.cards.reduce((a, c) => a + c.count, 0)}</td><td className="num">{formatBRL(cardsTotal / 100)}</td><td className="num">100%</td></tr></tfoot>
            </table>
          </section>
        );
      })()}

      <footer className="pd-foot">NoPaper · {org?.name} · {payable ? 'Contas a pagar' : 'Contas a receber'} {r.year} · gerado em {generated}</footer>
    </div>,
    document.body,
  );
}

function PrintChart({ months, labels }: { months: MonthRow[]; labels: { done: string; open: string } }) {
  const W = 720, H = 170, padL = 58, padB = 20, padT = 6;
  const max = niceMax(Math.max(...months.map((m) => toCents(m.total))));
  const slot = (W - padL) / 12, barW = slot * 0.5;
  const y = (c: number) => padT + (H - padT - padB) * (1 - c / max);
  return (
    <figure className="pd-chart">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Valores por mês">
        {[0, 0.5, 1].map((f) => (
          <g key={f}>
            <line x1={padL} x2={W} y1={y(f * max)} y2={y(f * max)} stroke="#d6dae4" strokeDasharray={f ? '2 3' : undefined} />
            <text x={padL - 8} y={y(f * max)} dy="0.32em" textAnchor="end" fontSize="9" fill="#6b7386">{compact(f * max)}</text>
          </g>
        ))}
        {months.map((m, i) => {
          const x = padL + slot * i + (slot - barW) / 2;
          const paid = toCents(m.paid), pend = toCents(m.pending);
          return (
            <g key={m.month}>
              {paid > 0 && <rect x={x} y={y(paid)} width={barW} height={y(0) - y(paid)} fill="#5b4be8" />}
              {pend > 0 && <rect x={x} y={y(paid + pend)} width={barW} height={y(paid) - y(paid + pend)} fill="#c4bcf6" />}
              <text x={x + barW / 2} y={H - 5} textAnchor="middle" fontSize="9" fill="#6b7386">{MONTHS_PT_SHORT[i]}</text>
            </g>
          );
        })}
      </svg>
      <figcaption><i style={{ background: '#5b4be8' }} />{labels.done}<i style={{ background: '#c4bcf6' }} />{labels.open}</figcaption>
    </figure>
  );
}

function MonthTable({ months, payable, labels }: { months: MonthRow[]; payable: boolean; labels: { done: string; open: string } }) {
  const hasOther = months.some((m) => m.other !== null && toCents(m.other) !== 0);
  const sum = (k: 'total' | 'paid' | 'pending' | 'overdue' | 'other') => months.reduce((a, m) => a + toCents(m[k] ?? '0'), 0);
  const bal = (t: number, o: number) => (payable ? o - t : t - o);
  const count = months.reduce((a, m) => a + m.count, 0);
  return (
    <table>
      <thead>
        <tr>
          <th>Mês</th><th className="num">Contas</th><th className="num">Total</th><th className="num">{labels.done}</th><th className="num">{labels.open}</th><th className="num">Vencido</th>
          {hasOther && <th className="num">{payable ? 'A receber' : 'A pagar'}</th>}
          {hasOther && <th className="num">Saldo</th>}
        </tr>
      </thead>
      <tbody>
        {months.map((m, i) => {
          const b = hasOther ? bal(toCents(m.total), toCents(m.other ?? '0')) : 0;
          return (
            <tr key={m.month}>
              <td>{MONTHS_PT[i]}</td>
              <td className="num">{m.count || '—'}</td>
              <td className="num">{formatBRL(m.total)}</td>
              <td className="num">{formatBRL(m.paid)}</td>
              <td className="num">{formatBRL(m.pending)}</td>
              <td className={toCents(m.overdue) > 0 ? 'num pd-neg' : 'num'}>{toCents(m.overdue) > 0 ? formatBRL(m.overdue) : '—'}</td>
              {hasOther && <td className="num">{formatBRL(m.other ?? '0')}</td>}
              {hasOther && <td className={b < 0 ? 'num pd-neg' : 'num'}>{formatBRL(b / 100)}</td>}
            </tr>
          );
        })}
      </tbody>
      <tfoot>
        <tr>
          <td>Ano</td><td className="num">{count}</td><td className="num">{formatBRL(sum('total') / 100)}</td><td className="num">{formatBRL(sum('paid') / 100)}</td><td className="num">{formatBRL(sum('pending') / 100)}</td>
          <td className={sum('overdue') > 0 ? 'num pd-neg' : 'num'}>{sum('overdue') > 0 ? formatBRL(sum('overdue') / 100) : '—'}</td>
          {hasOther && <td className="num">{formatBRL(sum('other') / 100)}</td>}
          {hasOther && (() => { const b = bal(sum('total'), sum('other')); return <td className={b < 0 ? 'num pd-neg' : 'num'}>{formatBRL(b / 100)}</td>; })()}
        </tr>
      </tfoot>
    </table>
  );
}
