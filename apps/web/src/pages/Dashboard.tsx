import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { AlertTriangle, ArrowDownLeft, ArrowUpRight, CalendarClock, CreditCard, FileUp } from 'lucide-react';
import { MONTHS_PT, formatBRL, formatDateBR, fromCents, toCents, todayISO, type BillType } from '@nopaper/shared';
import { Card, PageHeader } from '@/components/ui/base';
import { CategoryChip, StatusChip } from '@/components/ui/chips';
import { get, qs } from '@/lib/api';
import { useCategories } from '@/lib/queries';
import { useCan, useSession, useOrg } from '@/lib/session';
import { CountUp } from '@/features/bills/KpiRibbon';
import { useAccountantOnly, useAccountingPending } from '@/features/accounting/data';
import { AccountingPage } from '@/features/accounting/AccountingPage';
import { plural } from '@/lib/utils';
import { displayStatus } from '@/features/bills/labels';
import type { Bill, Card as CardT, Summary } from '@/lib/types';
import { MonthlyChart, type Report } from '@/features/reports/ReportsPage';
import { cn } from '@/lib/utils';

function useSummary(type: BillType, enabled: boolean) {
  const orgId = useSession((s) => s.orgId);
  const t = todayISO();
  const y = Number(t.slice(0, 4)), m = Number(t.slice(5, 7));
  return useQuery({ enabled, queryKey: ['bills', orgId, 'summary', type, y, m], queryFn: () => get<Summary>(`/api/bills/summary?${qs({ type, year: y, month: m })}`) });
}
function useUpcoming(type: BillType, enabled: boolean) {
  const orgId = useSession((s) => s.orgId);
  return useQuery({ enabled, queryKey: ['bills', orgId, 'upcoming', type], queryFn: () => get<{ items: Bill[] }>(`/api/bills?${qs({ type, status: 'due_soon' })}`).then((r) => r.items) });
}
function useOverdue(type: BillType, enabled: boolean) {
  const orgId = useSession((s) => s.orgId);
  return useQuery({ enabled, queryKey: ['bills', orgId, 'overdue-list', type], queryFn: () => get<{ items: Bill[] }>(`/api/bills?${qs({ type, status: 'overdue' })}`).then((r) => r.items) });
}

export function DashboardPage() {
  const can = useCan();
  const org = useOrg();
  const user = useSession((s) => s.user);
  const canP = can('payable.view'), canR = can('receivable.view');
  const p = useSummary('payable', canP), r = useSummary('receivable', canR);
  const upP = useUpcoming('payable', canP), ovP = useOverdue('payable', canP);
  const upR = useUpcoming('receivable', canR);
  const { data: cats = [] } = useCategories();
  const catMap = new Map(cats.map((c) => [c.id, c]));
  const today = p.data?.today ?? todayISO();
  const month = MONTHS_PT[Number(today.slice(5, 7)) - 1];
  const balance = fromCents(toCents(r.data?.forecast.total ?? '0') - toCents(p.data?.forecast.total ?? '0'));
  const pendingDocs = useAccountingPending();
  const accountantOnly = useAccountantOnly();
  const hour = new Date().getHours();
  const hello = hour < 12 ? 'Bom dia' : hour < 18 ? 'Boa tarde' : 'Boa noite';

  const canYear = canP && can('reports.view');
  const canCards = can('cards.view');
  const orgId = useSession((s) => s.orgId);
  const thisYear = Number(today.slice(0, 4));
  const year = useQuery({ enabled: canYear, queryKey: ['bills', orgId, 'report', 'payable', thisYear], queryFn: () => get<Report>(`/api/reports/overview?${qs({ type: 'payable', year: thisYear })}`) });
  const cards = useQuery({ enabled: canCards, queryKey: ['bills', orgId, 'cards'], queryFn: () => get<{ items: CardT[] }>('/api/cards').then((x) => x.items) });
  // sem cartão cadastrado, o gráfico do ano ocupa a linha toda (sem coluna vazia ao lado)
  const showCards = canCards && !!cards.data?.length;

  const attention = [...(ovP.data ?? []), ...(upP.data ?? [])].slice(0, 8);

  // contador (só envia documentos): o início dele é a área do contador
  if (accountantOnly) return <AccountingPage />;
  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <PageHeader title={`${hello}, ${user?.name.split(' ')[0]}`} description={`${org?.name} · ${month} de ${today.slice(0, 4)}`} />

      {pendingDocs > 0 && (
        <Link to="/contador" className="flex items-center gap-3 rounded-xl border border-accent/30 bg-accent-soft/50 px-4 py-3 text-sm transition hover:bg-accent-soft">
          <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent text-white"><FileUp className="size-4" /></span>
          <span className="min-w-0 flex-1"><b className="font-medium">O contador enviou {plural(pendingDocs, 'documento', 'documentos')}</b><span className="block text-xs text-muted">Confira e lance na área do contador.</span></span>
          <span className="shrink-0 text-xs font-medium text-accent">abrir</span>
        </Link>
      )}

      <div className="grid gap-3 sm:gap-4 md:grid-cols-2 lg:grid-cols-3">
        {canP && (
          <Card className="p-4 sm:p-5">
            <div className="flex items-center justify-between"><span className="flex items-center gap-2 text-sm text-muted"><ArrowUpRight className="size-4 text-danger" /> A pagar em {month.toLowerCase()}</span><Link to="/pagar" className="text-xs text-accent hover:underline">abrir</Link></div>
            <CountUp value={p.data?.pending.total ?? '0'} className="mt-3 block font-display text-[28px] sm:text-[34px] font-semibold leading-none" />
            <p className="mt-2 text-sm text-muted">de {formatBRL(p.data?.forecast.total ?? 0)} previstos · {formatBRL(p.data?.paid.total ?? 0)} já pagos</p>
            <Progress value={toCents(p.data?.paid.total ?? '0')} total={toCents(p.data?.forecast.total ?? '0')} />
          </Card>
        )}
        {canR && (
          <Card className="p-4 sm:p-5">
            <div className="flex items-center justify-between"><span className="flex items-center gap-2 text-sm text-muted"><ArrowDownLeft className="size-4 text-ok" /> A receber em {month.toLowerCase()}</span><Link to="/receber" className="text-xs text-accent hover:underline">abrir</Link></div>
            <CountUp value={r.data?.pending.total ?? '0'} className="mt-3 block font-display text-[28px] sm:text-[34px] font-semibold leading-none" />
            <p className="mt-2 text-sm text-muted">de {formatBRL(r.data?.forecast.total ?? 0)} previstos · {formatBRL(r.data?.paid.total ?? 0)} já recebidos</p>
            <Progress value={toCents(r.data?.paid.total ?? '0')} total={toCents(r.data?.forecast.total ?? '0')} tone="ok" />
          </Card>
        )}
        {canP && canR && (
          <Card className="p-4 sm:p-5 md:max-lg:col-span-2">
            <span className="text-sm text-muted">Saldo previsto do mês</span>
            <CountUp value={balance} className={`mt-3 block font-display text-[28px] sm:text-[34px] font-semibold leading-none ${balance.startsWith('-') ? 'text-danger' : 'text-ok'}`} />
            <p className="mt-2 text-sm text-muted">receitas previstas menos despesas previstas</p>
          </Card>
        )}
      </div>

      {(canYear || showCards) && (
        <div className={cn('grid gap-3 sm:gap-4', canYear && showCards && 'xl:grid-cols-[1.4fr_1fr]')}>
          {canYear && year.data && (
            <Card className="p-5">
              <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
                <h2 className="mr-auto font-display text-lg font-semibold">Despesas em {year.data.year}</h2>
                <span className="flex items-center gap-1.5 text-xs text-muted"><span className="size-2.5 rounded-sm bg-[var(--np-chart-1)]" />Pago</span>
                <span className="flex items-center gap-1.5 text-xs text-muted"><span className="size-2.5 rounded-sm bg-[var(--np-chart-2)]" />A pagar</span>
                <Link to="/relatorios" className="text-xs text-accent hover:underline">relatórios</Link>
              </div>
              <MonthlyChart months={year.data.months} year={year.data.year} today={year.data.today} height={190}
                labels={{ done: 'Pago', open: 'A pagar' }} onPick={(m) => `/pagar?ano=${year.data!.year}&mes=${m}`} />
            </Card>
          )}
          {showCards && (
            <Card>
              <div className="flex items-center justify-between gap-3 border-b border-line px-4 sm:px-5 py-4">
                <h2 className="font-display text-lg font-semibold">Cartões</h2>
                <Link to="/cartoes" className="text-xs text-accent hover:underline">abrir</Link>
              </div>
              <ul className="divide-y divide-line">
                {(cards.data ?? []).filter((c) => c.active).map((c) => {
                  const lim = c.limitAmount ? toCents(c.limitAmount) : 0;
                  return (
                    <li key={c.id}>
                      <Link to={`/cartoes?cartao=${c.id}`} className="flex items-center gap-3 px-4 sm:px-5 py-3 hover:bg-surface-2/50">
                        <CreditCard className="size-4 text-faint" />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium">{c.name}{c.last4 && <span className="text-faint"> ·· {c.last4}</span>}</p>
                          <p className="text-xs text-faint tnum">fecha {formatDateBR(c.currentClosing).slice(0, 5)} · vence {formatDateBR(c.currentDue).slice(0, 5)}</p>
                          {lim > 0 && <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, (toCents(c.limitUsed) / lim) * 100)}%` }} /></div>}
                        </div>
                        <div className="text-right">
                          <p className="tnum text-sm font-medium">{formatBRL(c.currentTotal)}</p>
                          <p className="text-[11px] text-faint">fatura atual</p>
                        </div>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </Card>
          )}
        </div>
      )}

      <div className="grid gap-3 sm:gap-4 xl:grid-cols-[1.4fr_1fr]">
        {canP && (
          <Card>
            <div className="flex items-center justify-between gap-3 border-b border-line px-4 sm:px-5 py-4">
              <h2 className="font-display text-lg font-semibold">Precisa de atenção</h2>
              {!!ovP.data?.length && <Link to="/pagar?situacao=overdue" className="inline-flex items-center gap-1 text-xs text-danger hover:underline"><AlertTriangle className="size-3.5" /> {ovP.data.length} em atraso</Link>}
            </div>
            {attention.length === 0 ? <p className="px-5 py-10 text-center text-sm text-muted">Nada vencido nem vencendo nos próximos 7 dias.</p> : (
              <ul className="divide-y divide-line">
                {attention.map((b) => (
                  <li key={b.id} className="flex items-center gap-3 px-4 sm:px-5 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{b.description}</p>
                      <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-faint tnum">{formatDateBR(b.dueDate)}<span className="sm:hidden"><StatusChip {...displayStatus(b, today)} /></span></p>
                    </div>
                    <CategoryChip category={catMap.get(b.categoryId)} className="hidden md:inline-flex" />
                    <span className="hidden sm:inline-flex"><StatusChip {...displayStatus(b, today)} /></span>
                    <span className="shrink-0 text-right tnum text-sm font-medium sm:w-28">{formatBRL(b.amount)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
        {canP && (
          <Card>
            <div className="border-b border-line px-4 sm:px-5 py-4"><h2 className="font-display text-lg font-semibold">Despesas por categoria</h2><p className="text-xs text-faint">{month}</p></div>
            <ul className="flex flex-col gap-3 p-4 sm:p-5">
              {(p.data?.byCategory ?? []).slice(0, 8).map((c) => {
                const max = toCents(p.data!.byCategory[0].total) || 1;
                const cat = catMap.get(c.categoryId);
                return (
                  <li key={c.categoryId}>
                    <div className="flex justify-between gap-3 text-sm"><span className="truncate">{cat?.label ?? '—'}</span><span className="shrink-0 tnum text-muted">{formatBRL(c.total)}</span></div>
                    <div className="mt-1.5 h-2 rounded-full bg-surface-2 overflow-hidden"><div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${(toCents(c.total) / max) * 100}%`, background: `var(--np-accent)` , opacity: 0.35 + 0.65 * (toCents(c.total) / max) }} /></div>
                  </li>
                );
              })}
              {!p.data?.byCategory.length && <p className="py-6 text-center text-sm text-muted">Sem contas neste mês.</p>}
            </ul>
          </Card>
        )}
        {canR && !!upR.data?.length && (
          <Card>
            <div className="border-b border-line px-5 py-4 flex items-center gap-2"><CalendarClock className="size-4 text-ok" /><h2 className="font-display text-lg font-semibold">A receber nos próximos 7 dias</h2></div>
            <ul className="divide-y divide-line">
              {upR.data.map((b) => <li key={b.id} className="flex justify-between gap-3 px-5 py-3 text-sm"><span className="truncate">{b.description}</span><span className="tnum">{formatBRL(b.amount)}</span></li>)}
            </ul>
          </Card>
        )}
      </div>
    </div>
  );
}

function Progress({ value, total, tone = 'accent' }: { value: number; total: number; tone?: 'accent' | 'ok' }) {
  const pct = total ? Math.min(100, (value / total) * 100) : 0;
  return (
    <div className="mt-4 h-1.5 rounded-full bg-surface-2 overflow-hidden">
      <div className="h-full rounded-full transition-[width] duration-700" style={{ width: `${pct}%`, background: tone === 'ok' ? 'var(--np-ok)' : 'var(--np-accent)' }} />
    </div>
  );
}
