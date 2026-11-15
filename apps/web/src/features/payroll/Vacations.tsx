import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, BellRing, CalendarCheck, CalendarClock, ChevronDown, FileUp, Palmtree, Pencil, Plus, Trash2 } from 'lucide-react';
import {
  VACATION_URGENCY_LABEL, addYearsISO, checkVacation, formatDateBR, todayISO, vacationDates,
  type VacationEntry, type VacationPeriod, type VacationReportRow, type VacationSettings, type VacationUrgency,
} from '@nopaper/shared';
import { Button, Card, Empty, Field, IconButton, Input, Select, Spinner, Switch, Textarea } from '@/components/ui/base';
import { DatePicker } from '@/components/ui/date-picker';
import { Dialog, SaveFooter, useConfirm, useFormState } from '@/components/ui/dialog';
import { api, errMsg, get, post, put } from '@/lib/api';
import { useCan, useSession } from '@/lib/session';
import { useAccountingDocs, type AccountingDoc } from '@/features/accounting/data';
import { cn, plural } from '@/lib/utils';
import { payrollKey } from './data';

type Entry = VacationEntry & { id: string; notes: string | null; source: string; needsReview: boolean };
type Period = Omit<VacationPeriod, 'entries'> & { urgency: VacationUrgency; entries: Entry[] };
interface VacEmployee {
  id: string; name: string; role: string | null; admissionDate: string | null; vacationFrom: string | null; configured: boolean; missing: 'admission' | 'start' | null;
  periods: Period[]; urgency: VacationUrgency; nextLimit: string | null; daysToLimit: number | null; toEnjoy: number;
  current: { startDate: string; days: number; ongoing: boolean } | null; needsReview: number;
}
interface Overview { settings: VacationSettings; employees: VacEmployee[] }

const TONE: Record<VacationUrgency, string> = {
  late: 'border-danger/40 bg-danger/10 text-danger', due: 'border-warn/40 bg-warn/15 text-warn', soon: 'border-accent/40 bg-accent-soft text-accent',
  ok: 'border-ok/30 bg-ok/10 text-ok', none: 'border-line bg-surface-2 text-muted',
};
const days = (n: number) => `${String(n).replace('.', ',')} ${n === 1 ? 'dia' : 'dias'}`;
const br = (iso: string | null | undefined) => (iso ? formatDateBR(iso) : '—');
const left = (n: number) => (n < 0 ? `passou há ${plural(-n, 'dia', 'dias')}` : n === 0 ? 'é hoje' : `faltam ${plural(n, 'dia', 'dias')}`);

function Chip({ u, children }: { u: VacationUrgency; children?: React.ReactNode }) {
  return <span className={cn('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium', TONE[u])}>{children ?? VACATION_URGENCY_LABEL[u]}</span>;
}

/** Folha → Férias: quem precisa tirar férias, até quando, e o que já está programado (CLT, arts. 129 a 145). */
/** Relatórios de férias que o contador enviou pela área do contador (PDF, não dispensados), do mais novo para o mais antigo. */
function useAccountantReports(enabled: boolean) {
  const can = useCan();
  const q = useAccountingDocs('to_client', enabled && can('accounting.review'));
  return useMemo(() => (q.data ?? []).filter((d) => d.kind === 'vacation' && d.mime === 'application/pdf' && d.status !== 'dismissed' && !d.hiddenAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt)), [q.data]);
}
const docLine = (d: AccountingDoc) => `${d.detected?.vacationsBase ? `data base ${formatDateBR(d.detected.vacationsBase)} · ` : ''}enviado em ${new Date(d.createdAt).toLocaleDateString('pt-BR')}${d.uploadedByName ? ` por ${d.uploadedByName}` : ''}`;

export function VacationsTab({ canEdit, canManage, reportDoc, onReportOpened }: { canEdit: boolean; canManage: boolean; /** Documento do contador a abrir (link "Abrir nas férias"). */ reportDoc?: string | null; onReportOpened?: () => void }) {
  const orgId = useSession((s) => s.orgId);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const q = useQuery({ queryKey: payrollKey(orgId, 'vacations'), queryFn: () => get<Overview>('/api/payroll/vacations') });
  const refresh = () => qc.invalidateQueries({ queryKey: payrollKey(orgId, 'vacations') });
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [entry, setEntry] = useState<{ employee: VacEmployee; entry: Entry | null; periodStart?: string } | null>(null);
  const [setup, setSetup] = useState<VacEmployee | null>(null);
  const [report, setReport] = useState<false | { docId: string | null }>(false);
  const fromAccountant = useAccountantReports(canEdit);
  const fresh = fromAccountant.filter((d) => d.status === 'new');
  useEffect(() => { if (reportDoc && canEdit) { setReport({ docId: reportDoc }); onReportOpened?.(); } }, [reportDoc]); // eslint-disable-line react-hooks/exhaustive-deps
  const [settings, setSettings] = useState(false);

  if (q.isLoading) return <div className="grid place-items-center py-20"><Spinner /></div>;
  if (!q.data) return <Card><Empty title="Não foi possível carregar as férias">{q.error ? errMsg(q.error) : null}</Empty></Card>;
  const { employees } = q.data;
  const count = (u: VacationUrgency) => employees.filter((e) => e.configured && e.urgency === u).length;
  const pending = employees.filter((e) => !e.configured);
  const review = employees.filter((e) => e.needsReview > 0);
  const remove = async (e: VacEmployee, x: Entry) => {
    if (!(await confirm({ title: 'Apagar este registro de férias?', tone: 'danger', confirmLabel: 'Apagar', body: `${x.days ? days(x.days) : ''}${x.soldDays ? ` + ${days(x.soldDays)} vendidos` : ''} de ${e.name}${x.startDate ? `, a partir de ${br(x.startDate)}` : ''}. O saldo do período volta a contar esses dias.` }))) return;
    try { await api('DELETE', `/api/payroll/vacations/entries/${x.id}`); refresh(); toast.success('Registro apagado'); } catch (err) { toast.error(errMsg(err)); }
  };

  return (
    <div className="flex flex-col gap-4">
      <Card className="flex flex-wrap items-center gap-x-5 gap-y-3 p-4 sm:p-5">
        <div className="mr-auto min-w-0">
          <h2 className="flex items-center gap-2 font-display text-lg font-semibold"><Palmtree className="size-5 text-accent" />Férias</h2>
          <p className="mt-0.5 max-w-2xl text-sm text-muted">Cada 12 meses de trabalho dão direito a férias, que precisam ser tiradas nos 12 meses seguintes. Os dias que passarem desse prazo são pagos em dobro.</p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {(['late', 'due', 'soon', 'ok'] as const).map((u) => count(u) > 0 && <Chip key={u} u={u}>{count(u)} · {VACATION_URGENCY_LABEL[u].toLowerCase()}</Chip>)}
        </div>
        <div className="flex flex-wrap gap-2 max-sm:w-full">
          {canEdit && <Button variant="secondary" size="sm" icon={<FileUp className="size-4" />} onClick={() => setReport({ docId: null })}>Relatório do contador</Button>}
          {canManage && <Button variant="ghost" size="sm" icon={<BellRing className="size-4" />} onClick={() => setSettings(true)}>Avisos</Button>}
        </div>
      </Card>

      {canEdit && fresh.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-accent/40 bg-accent-soft/40 px-4 py-3 text-sm">
          <FileUp className="size-4 shrink-0 text-accent" />
          <span className="min-w-0 flex-1 basis-64">O contador enviou {fresh.length === 1 ? 'um relatório de férias' : `${fresh.length} relatórios de férias`}: <b>{fresh[0]!.originalName}</b> <span className="text-muted">({docLine(fresh[0]!)})</span>.</span>
          <Button size="sm" variant="primary" onClick={() => setReport({ docId: fresh[0]!.id })}>Conferir e aplicar</Button>
        </div>
      )}
      {review.length > 0 && (
        <p className="flex items-start gap-2 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
          <span>Chegou recibo de férias para {review.map((e) => e.name.split(' ')[0]).join(', ')}. As férias foram registradas sozinhas: confira as datas de cada um, marcadas com “conferir” abaixo.</span>
        </p>
      )}
      {pending.length > 0 && (
        <p className="flex items-start gap-2 rounded-xl border border-line bg-surface-2/60 px-4 py-3 text-sm text-muted">
          <CalendarClock className="mt-0.5 size-4 shrink-0 text-accent" />
          <span>{plural(pending.length, 'funcionário ainda sem', 'funcionários ainda sem')} dados para calcular as férias. {canEdit ? 'O jeito mais rápido é enviar o relatório de férias do contador; ou informe a situação de cada um na lista.' : 'Peça a quem cuida da folha para informar.'}</span>
        </p>
      )}

      {!employees.length ? <Card><Empty icon={<Palmtree className="size-5" />} title="Nenhum funcionário ativo">Cadastre os funcionários na aba Funcionários.</Empty></Card> : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {employees.map((e) => {
              const expanded = open.has(e.id);
              const main = e.periods.find((p) => p.status !== 'accruing' && p.balance > 0) ?? null;
              return (
                <li key={e.id} className="min-w-0">
                  <div className="flex flex-wrap items-start gap-x-4 gap-y-2 px-4 py-3.5 sm:px-5">
                    <button type="button" className="flex min-w-0 flex-1 basis-56 items-start gap-2 text-left" onClick={() => e.configured && setOpen((s) => { const n = new Set(s); if (n.has(e.id)) n.delete(e.id); else n.add(e.id); return n; })} aria-expanded={expanded}>
                      {e.configured && <ChevronDown className={cn('mt-1 size-4 shrink-0 text-faint transition-transform', expanded && 'rotate-180')} />}
                      <span className="min-w-0">
                        <span className="line-clamp-2 break-words font-medium leading-snug">{e.name}</span>
                        <span className="block text-xs text-faint">{[e.role, e.admissionDate && `admissão ${br(e.admissionDate)}`].filter(Boolean).join(' · ') || 'sem data de admissão'}</span>
                      </span>
                    </button>
                    <div className="min-w-0 flex-[2] basis-72 text-sm">
                      {!e.configured ? (
                        <span className="text-muted">{e.missing === 'admission' ? 'Falta a data de admissão.' : 'Falta dizer a partir de qual período controlar (os anteriores já foram tirados).'}</span>
                      ) : e.current?.ongoing ? (
                        <span className="inline-flex items-center gap-1.5 text-ok"><Palmtree className="size-4" />De férias até {br(vacationDates(e.current.startDate, e.current.days).end)}</span>
                      ) : main ? (
                        <span><b>{days(main.balance)}</b> a programar · começar até <b className={cn(main.urgency === 'late' && 'text-danger', main.urgency === 'due' && 'text-warn')}>{br(main.limitStart)}</b> <span className="text-muted">({left(main.daysToLimit ?? 0)})</span></span>
                      ) : e.current ? (
                        <span className="inline-flex items-center gap-1.5 text-muted"><CalendarCheck className="size-4 text-ok" />Férias programadas para {br(e.current.startDate)} ({days(e.current.days)})</span>
                      ) : <span className="text-muted">Nada vencido. Adquirindo o próximo período{e.periods.at(-1) ? `: ${days(e.periods.at(-1)!.accrued)} até agora` : ''}.</span>}
                      {e.configured && main && e.current && !e.current.ongoing && <span className="mt-0.5 block text-xs text-muted">Próximas férias: {br(e.current.startDate)} ({days(e.current.days)})</span>}
                    </div>
                    <div className="flex items-center gap-2 max-sm:w-full max-sm:justify-between">
                      {!e.configured ? <Chip u="none">Sem dados</Chip> : e.urgency === 'none' && e.current ? <Chip u="ok">{e.current.ongoing ? 'De férias' : 'Programado'}</Chip> : <Chip u={e.urgency} />}
                      {canEdit && (e.configured
                        ? <Button size="sm" variant={e.urgency === 'late' || e.urgency === 'due' ? 'primary' : 'secondary'} icon={<Plus className="size-4" />} onClick={() => setEntry({ employee: e, entry: null, periodStart: main?.start })}>Programar</Button>
                        : <Button size="sm" variant="secondary" onClick={() => setSetup(e)}>Informar</Button>)}
                    </div>
                  </div>
                  {expanded && e.configured && (
                    <div className="flex flex-col gap-3 border-t border-line/70 bg-surface-2/40 px-4 py-3 sm:px-5">
                      {e.periods.map((p) => (
                        <div key={p.start} className="rounded-xl border border-line bg-surface p-3">
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                            <p className="text-sm font-medium">Período aquisitivo {br(p.start)} a {br(p.end)}</p>
                            <Chip u={p.urgency}>{p.status === 'accruing' ? 'Adquirindo' : p.status === 'overdue' ? 'Prazo estourado' : p.balance > 0 ? VACATION_URGENCY_LABEL[p.urgency] : 'Programado'}</Chip>
                            {canEdit && p.status !== 'accruing' && <AbsencesButton employee={e} period={p} onSaved={refresh} />}
                          </div>
                          <p className="mt-1 text-xs leading-relaxed text-muted">
                            {p.status === 'accruing'
                              ? <>Direito a {days(p.entitled)} quando completar, em {br(p.end)}; adquiridos até hoje: {days(p.accrued)}. Depois, tirar até {br(p.concessiveEnd)}.</>
                              : <>Direito: {days(p.entitled)}{p.absences > 0 && ` (${plural(p.absences, 'falta', 'faltas')} injustificadas)`} · gozados: {days(p.taken)} · programados: {days(p.scheduled)}{p.sold > 0 && ` · vendidos: ${days(p.sold)}`} · <b className="text-ink">a programar: {days(p.balance)}</b>. Tirar até {br(p.concessiveEnd)}{p.limitStart && <> (começar até <b className="text-ink">{br(p.limitStart)}</b>)</>}.</>}
                          </p>
                          {p.doubledDays > 0 && <p className="mt-1.5 flex items-start gap-1.5 text-xs font-medium text-danger"><AlertTriangle className="mt-px size-3.5 shrink-0" />{days(p.doubledDays)} {p.doubledDays === 1 ? 'fica' : 'ficam'} fora do prazo e {p.doubledDays === 1 ? 'é pago' : 'são pagos'} em dobro.</p>}
                          {p.entries.length > 0 && (
                            <ul className="mt-2 divide-y divide-line/60 text-sm">
                              {p.entries.map((x) => (
                                <li key={x.id} className="flex items-center gap-2 py-1.5">
                                  <span className="min-w-0 flex-1">
                                    {x.days > 0 ? (x.startDate ? <>{br(x.startDate)} a {br(vacationDates(x.startDate, x.days).end)} · {days(x.days)}{x.startDate > todayISO() && <span className="text-muted"> · programadas</span>}</> : <>{days(x.days)} já gozados <span className="text-muted">(data não informada)</span></>) : x.soldDays ? '' : <span className="text-warn">Recibo de férias recebido: informe as datas</span>}
                                    {x.soldDays > 0 && <span>{x.days > 0 ? ' + ' : ''}{days(x.soldDays)} vendidos</span>}
                                    {x.needsReview && <span className="ml-2 rounded bg-warn/15 px-1.5 py-0.5 text-xs font-medium text-warn">conferir</span>}
                                    {x.notes && <span className="block truncate text-xs text-faint">{x.notes}</span>}
                                  </span>
                                  {canEdit && <IconButton label="Editar" onClick={() => setEntry({ employee: e, entry: x })}><Pencil className="size-4" /></IconButton>}
                                  {canEdit && <IconButton label="Apagar" tone="danger" onClick={() => remove(e, x)}><Trash2 className="size-4" /></IconButton>}
                                </li>
                              ))}
                            </ul>
                          )}
                          {canEdit && p.status !== 'accruing' && p.balance > 0 && <Button size="sm" variant="ghost" className="mt-2" icon={<Plus className="size-4" />} onClick={() => setEntry({ employee: e, entry: null, periodStart: p.start })}>Programar deste período</Button>}
                        </div>
                      ))}
                      {canEdit && <button type="button" className="self-start text-xs text-muted underline hover:text-ink" onClick={() => setSetup(e)}>Mudar a admissão ou de qual período o controle começa</button>}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}

      {entry && <EntryDialog key={entry.entry?.id ?? 'new'} {...entry} onClose={() => setEntry(null)} onSaved={refresh} />}
      {setup && <SetupDialog employee={setup} onClose={() => setSetup(null)} onSaved={refresh} />}
      {report && <ReportDialog docId={report.docId} docs={fromAccountant} onClose={() => setReport(false)} onApplied={refresh} />}
      {settings && <AlertsDialog settings={q.data.settings} onClose={() => setSettings(false)} onSaved={refresh} />}
    </div>
  );
}

/** Faltas injustificadas do período (reduzem os dias de direito: art. 130 da CLT). */
function AbsencesButton({ employee, period, onSaved }: { employee: VacEmployee; period: Period; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [n, setN] = useState(String(period.absences || ''));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try { await put('/api/payroll/vacations/adjust', { employeeId: employee.id, periodStart: period.start, absences: Number(n) || 0, forfeited: false }); onSaved(); toast.success('Faltas gravadas'); setOpen(false); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  if (!open) return <button type="button" className="text-xs text-muted underline hover:text-ink" onClick={() => setOpen(true)}>{period.absences ? `${plural(period.absences, 'falta', 'faltas')}` : 'informar faltas'}</button>;
  return (
    <span className="inline-flex items-center gap-1.5">
      <Input aria-label="Faltas injustificadas no período" inputMode="numeric" className="h-8 w-16 tnum" value={n} onChange={(e) => setN(e.target.value.replace(/\D/g, '').slice(0, 3))} placeholder="0" autoFocus />
      <Button size="sm" variant="secondary" loading={busy} onClick={save}>Gravar</Button>
    </span>
  );
}

function EntryDialog({ employee, entry, periodStart, onClose, onSaved }: { employee: VacEmployee; entry: Entry | null; periodStart?: string; onClose: () => void; onSaved: () => void }) {
  const first = employee.periods.find((p) => p.status !== 'accruing' && p.balance > 0) ?? employee.periods[0];
  const [id, setId] = useState(entry?.id ?? null);
  const [f, setF, form] = useFormState({
    periodStart: entry?.periodStart ?? periodStart ?? first?.start ?? '', startDate: entry?.startDate ?? '', days: String(entry?.days || (entry ? 0 : Math.min(30, Math.floor(first?.balance ?? 30)) || '')),
    soldDays: String(entry?.soldDays || ''), notes: entry?.notes ?? '',
  });
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<string[] | null>(null);
  const today = todayISO();
  const p = employee.periods.find((x) => x.start === f.periodStart);
  const nDays = Number(f.days) || 0, nSold = Number(f.soldDays) || 0;
  const others = useMemo(() => (p?.entries ?? []).filter((x) => x.id !== id), [p, id]);
  const warnings = useMemo(() => (p ? checkVacation(p, { startDate: f.startDate || null, days: nDays, soldDays: nSold }, others, today) : []), [p, f.startDate, nDays, nSold, others, today]);
  const d = f.startDate && nDays > 0 ? vacationDates(f.startDate, nDays) : null;
  const save = async () => {
    setBusy(true);
    const body = { employeeId: employee.id, periodStart: f.periodStart, startDate: f.startDate || null, days: nDays, soldDays: nSold, notes: f.notes };
    try {
      const r = id ? await put<{ id: string; warnings: string[] }>(`/api/payroll/vacations/entries/${id}`, body) : await post<{ id: string; warnings: string[] }>('/api/payroll/vacations/entries', body);
      setId(r.id); setSaved(r.warnings); form.markSaved(f); onSaved();
      toast.success(id ? 'Férias salvas' : 'Férias registradas');
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} dirty={form.dirty} title={`Férias de ${employee.name}`} description="Programe as férias ou registre as que já foram tiradas. Deixe a data em branco para dias já gozados sem data conhecida."
      footer={<SaveFooter dirty={form.dirty} isNew={!id} saving={busy} canSave={!!f.periodStart && nDays + nSold > 0} onSave={save} onClose={onClose} />}>
      <div className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-12">
        <Field label="Período aquisitivo" className="col-span-2 sm:col-span-12" hint={p ? `Direito a ${days(p.entitled)}; a programar: ${days(p.balance)}. Tirar até ${br(p.concessiveEnd)}.` : undefined}>
          <Select value={f.periodStart} onChange={(e) => setF({ ...f, periodStart: e.target.value })}>
            {employee.periods.map((x) => <option key={x.start} value={x.start}>{br(x.start)} a {br(x.end)}{x.status === 'accruing' ? ' (em aquisição)' : ` · ${days(x.balance)} a programar`}</option>)}
          </Select>
        </Field>
        <Field label="Início" className="col-span-2 sm:col-span-5"><DatePicker clearable placeholder="Sem data (já gozados)" value={f.startDate} onChange={(v) => setF({ ...f, startDate: v ?? '' })} /></Field>
        <Field label="Dias de férias" className="sm:col-span-3"><Input inputMode="numeric" className="tnum" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value.replace(/\D/g, '').slice(0, 2) })} placeholder="0" /></Field>
        <Field label="Dias vendidos" className="sm:col-span-4" hint="Abono: até 1/3."><Input inputMode="numeric" className="tnum" value={f.soldDays} onChange={(e) => setF({ ...f, soldDays: e.target.value.replace(/\D/g, '').slice(0, 2) })} placeholder="0" /></Field>
        {d && (
          <dl className="col-span-2 grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-xl border border-line bg-surface-2/50 px-4 py-3 text-sm sm:col-span-12 sm:grid-cols-4">
            <div><dt className="text-xs text-faint">Último dia</dt><dd className="font-medium tnum">{br(d.end)}</dd></div>
            <div><dt className="text-xs text-faint">Volta ao trabalho</dt><dd className="font-medium tnum">{br(d.returnOn)}</dd></div>
            <div><dt className="text-xs text-faint">Avisar por escrito até</dt><dd className={cn('font-medium tnum', d.noticeBy < today && f.startDate > today && 'text-warn')}>{br(d.noticeBy)}</dd></div>
            <div><dt className="text-xs text-faint">Pagar as férias até</dt><dd className="font-medium tnum">{br(d.payBy)}</dd></div>
          </dl>
        )}
        {warnings.length > 0 && (
          <ul className="col-span-2 flex flex-col gap-1.5 rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm sm:col-span-12">
            {warnings.map((w) => <li key={w} className="flex items-start gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" /><span>{w}</span></li>)}
          </ul>
        )}
        {saved && !form.dirty && !warnings.length && <p className="col-span-2 text-sm text-ok sm:col-span-12">Gravado. Dentro das regras da CLT conferidas aqui.</p>}
        <Field label="Observação" className="col-span-2 sm:col-span-12"><Textarea rows={2} maxLength={500} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
        <p className="col-span-2 text-xs leading-relaxed text-faint sm:col-span-12">Os avisos seguem a CLT (arts. 130 a 145). Eles não impedem de gravar: convenção coletiva ou acordo podem prever outra coisa, e feriados locais não são conferidos.</p>
      </div>
    </Dialog>
  );
}

/** Admissão e de qual período aquisitivo o controle começa (os anteriores já foram tirados). */
function SetupDialog({ employee, onClose, onSaved }: { employee: VacEmployee; onClose: () => void; onSaved: () => void }) {
  const [admission, setAdmission] = useState(employee.admissionDate ?? '');
  const [from, setFrom] = useState(employee.vacationFrom ?? '');
  const [busy, setBusy] = useState(false);
  const today = todayISO();
  const options = useMemo(() => {
    if (!admission) return [];
    const out: Array<{ start: string; label: string }> = [];
    for (let n = 0; n < 80; n++) { const s = addYearsISO(admission, n); if (s > today) break; const e = addYearsISO(admission, n + 1); out.push({ start: s, label: `${formatDateBR(s)} a ${formatDateBR(e).replace(/^\d{2}/, (d) => d)}${e > today ? ' (em aquisição)' : ''}` }); }
    return out.slice(-6).reverse();
  }, [admission, today]);
  useEffect(() => { if (options.length && !options.some((o) => o.start === from)) setFrom(options[Math.min(1, options.length - 1)]!.start); }, [options]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async () => {
    setBusy(true);
    try { await put(`/api/payroll/vacations/employees/${employee.id}`, { admissionDate: admission, vacationFrom: from || null }); onSaved(); toast.success('Controle de férias iniciado'); onClose(); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} size="sm" title={employee.name} description="Para calcular as férias o NoPaper precisa da admissão e de saber a partir de qual período controlar."
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={!admission} onClick={save}>Gravar</Button></>}>
      <div className="flex flex-col gap-4">
        <Field label="Data de admissão" required><DatePicker value={admission} max={today} onChange={(v) => setAdmission(v ?? '')} /></Field>
        {options.length > 1 && (
          <Field label="Período mais antigo ainda em aberto" hint="Os períodos anteriores a este são considerados já tirados. Depois dá para registrar os dias já gozados deste.">
            <Select value={from} onChange={(e) => setFrom(e.target.value)}>{options.map((o) => <option key={o.start} value={o.start}>{o.label}</option>)}</Select>
          </Field>
        )}
      </div>
    </Dialog>
  );
}

type ReadRow = VacationReportRow & { employeeId: string | null; matchedBy: 'code' | 'name' | null; currentAdmission: string | null };
/** Relatório "Períodos Aquisitivos Abertos de Férias" do contador: preenche admissão, períodos em aberto e dias já gozados. */
function ReportDialog({ docId, docs, onClose, onApplied }: { docId: string | null; docs: AccountingDoc[]; onClose: () => void; onApplied: () => void }) {
  const input = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  /** Documento do contador em uso (ao aplicar, ele é marcado como lançado). */
  const [doc, setDoc] = useState<string | null>(null);
  const readDoc = async (id: string) => {
    setBusy(true);
    try {
      const r = await post<NonNullable<typeof data>>(`/api/accounting/documents/${id}/vacations`);
      setData(r); setDoc(id); setLink(Object.fromEntries(r.rows.filter((x) => x.employeeId).map((x) => [x.code, x.employeeId!])));
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  useEffect(() => { if (docId) void readDoc(docId); }, [docId]); // eslint-disable-line react-hooks/exhaustive-deps
  const [data, setData] = useState<{ fileName: string; company: string | null; baseDate: string | null; rows: ReadRow[]; employees: Array<{ id: string; name: string }> } | null>(null);
  const [link, setLink] = useState<Record<string, string>>({});
  const read = async (file: File) => {
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('file', file);
      const r = await post<NonNullable<typeof data>>('/api/payroll/vacations/report/read', fd);
      setData(r); setDoc(null); setLink(Object.fromEntries(r.rows.filter((x) => x.employeeId).map((x) => [x.code, x.employeeId!])));
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const people = useMemo(() => [...new Map((data?.rows ?? []).map((r) => [r.code, r])).values()], [data]);
  const ready = (data?.rows ?? []).filter((r) => link[r.code]);
  const dup = Object.values(link).filter(Boolean).some((v, i, a) => a.indexOf(v) !== i);
  const apply = async () => {
    if (!data) return;
    setBusy(true);
    try {
      const r = await post<{ employees: number; entries: number }>('/api/payroll/vacations/report/apply', { baseDate: data.baseDate, rows: ready.map((x) => ({ employeeId: link[x.code], admission: x.admission, periodStart: x.periodStart, paid: x.paid, absences: x.absences })) });
      toast.success(`Férias de ${plural(r.employees, 'funcionário atualizadas', 'funcionários atualizadas')}`);
      // veio da área do contador: o documento fica como lançado lá
      if (doc) await put(`/api/accounting/documents/${doc}`, { status: 'done' }).then(() => qc.invalidateQueries({ queryKey: ['accounting'] })).catch(() => undefined);
      onApplied(); onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} size="lg" title="Relatório de férias do contador" description="Envie o PDF “Períodos Aquisitivos Abertos de Férias”. Ele traz a admissão, os períodos em aberto, o saldo e o limite de cada funcionário."
      footer={<><Button variant="ghost" onClick={onClose}>Fechar</Button>{data && <Button variant="primary" loading={busy} disabled={!ready.length || dup} onClick={apply}>Aplicar a {plural(new Set(ready.map((r) => link[r.code])).size, 'funcionário', 'funcionários')}</Button>}</>}>
      <input ref={input} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void read(f); }} />
      {!data ? (
        <div className="flex flex-col gap-4">
        {docs.length > 0 && (
          <div className="flex flex-col gap-2">
            <p className="text-[13px] font-medium text-muted">Enviados pelo contador</p>
            <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
              {docs.slice(0, 4).map((d) => (
                <li key={d.id}>
                  <button type="button" disabled={busy} onClick={() => readDoc(d.id)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition hover:bg-surface-2 disabled:opacity-60">
                    <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', d.status === 'new' ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-faint')}><Palmtree className="size-4" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2"><span className="truncate text-sm font-medium">{d.originalName}</span>{d.status === 'new' && <span className="rounded-full bg-accent px-2 py-px text-[11px] font-semibold text-accent-ink">novo</span>}</span>
                      <span className="block text-xs text-muted">{d.detected?.vacations ? `${plural(d.detected.vacations, 'período', 'períodos')} · ` : ''}{docLine(d)}</span>
                    </span>
                    <span className="shrink-0 text-[13px] font-medium text-accent">Usar este</span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="text-center text-xs text-faint">ou envie um arquivo do computador</p>
          </div>
        )}
        <button type="button" disabled={busy} onClick={() => input.current?.click()} className="flex w-full flex-col items-center gap-2 rounded-2xl border-2 border-dashed border-line-strong px-6 py-12 text-center transition-colors hover:border-accent hover:bg-accent-soft/40">
          {busy ? <Spinner /> : <FileUp className="size-7 text-accent" />}
          <span className="font-medium">{busy ? 'Lendo o relatório…' : 'Escolher o PDF do relatório'}</span>
          <span className="text-sm text-muted">Nada é gravado até você conferir e aplicar.</span>
        </button>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-muted">{data.company ? <><b className="text-ink">{data.company}</b> · </> : null}{plural(data.rows.length, 'período', 'períodos')} de {plural(people.length, 'funcionário', 'funcionários')}{data.baseDate && <> · data base {formatDateBR(data.baseDate)}</>}. <button type="button" className="underline" onClick={() => { setData(null); setDoc(null); }}>Trocar o arquivo</button></p>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {people.map((p) => {
              const mine = data.rows.filter((r) => r.code === p.code);
              return (
                <li key={p.code} className="flex flex-wrap items-start gap-x-4 gap-y-2 px-3 py-2.5 text-sm">
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="line-clamp-2 break-words font-medium leading-snug">{p.name} <span className="font-normal text-faint">· matrícula {p.code}</span></p>
                    <p className="text-xs text-muted">Admissão {formatDateBR(p.admission)}</p>
                    {mine.map((r) => <p key={r.periodStart} className="text-xs text-muted">{formatDateBR(r.periodStart)} a {formatDateBR(r.periodEnd)}: saldo {days(r.balance)}{r.paid > 0 && `, já gozados ${days(r.paid)}`} · limite {formatDateBR(r.limit)}</p>)}
                  </div>
                  <Select aria-label={`Funcionário de ${p.name}`} className="w-full sm:w-64" value={link[p.code] ?? ''} onChange={(e) => setLink({ ...link, [p.code]: e.target.value })}>
                    <option value="">Não aplicar</option>
                    {data.employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </Select>
                </li>
              );
            })}
          </ul>
          {dup && <p className="text-sm text-danger">O mesmo funcionário foi escolhido para duas pessoas do relatório.</p>}
          <p className="text-xs leading-relaxed text-faint">Ao aplicar: a admissão do cadastro passa a ser a do relatório, o controle começa no período em aberto mais antigo de cada um, e os dias já gozados que o relatório informa são registrados (sem repetir os que já estão aqui). Férias já programadas no NoPaper não são apagadas.</p>
        </div>
      )}
    </Dialog>
  );
}

function AlertsDialog({ settings, onClose, onSaved }: { settings: VacationSettings; onClose: () => void; onSaved: () => void }) {
  const [f, setF, form] = useFormState({ days: settings.alertDays.join(', '), inDigest: settings.inDigest });
  const [busy, setBusy] = useState(false);
  const list = [...new Set(f.days.split(/[^\d]+/).map(Number).filter((n) => n >= 1 && n <= 365))].sort((a, b) => b - a).slice(0, 5);
  const save = async () => {
    setBusy(true);
    try { await put('/api/payroll/vacations/settings', { alertDays: list, inDigest: f.inDigest }); form.markSaved(f); onSaved(); toast.success('Avisos de férias salvos'); }
    catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open onClose={onClose} dirty={form.dirty} size="sm" title="Avisos de férias" description="Com que antecedência o NoPaper avisa que um funcionário precisa tirar férias, contando do último dia para começar sem pagar em dobro."
      footer={<SaveFooter dirty={form.dirty} saving={busy} canSave={list.length > 0} onSave={save} onClose={onClose} />}>
      <div className="flex flex-col gap-4">
        <Field label="Antecedências, em dias" hint={list.length ? `Avisa quando faltarem ${list.join(', ').replace(/, ([^,]*)$/, ' e $1')} dias. A maior marca “Programar”; a menor, “Urgente”.` : 'Informe ao menos um número de dias (ex.: 120, 60, 30).'}>
          <Input inputMode="numeric" value={f.days} onChange={(e) => setF({ ...f, days: e.target.value })} placeholder="120, 60, 30" />
        </Field>
        <div className="rounded-xl border border-line bg-surface-2/50 px-4 py-3">
          <Switch checked={f.inDigest} onChange={(inDigest) => setF({ ...f, inDigest })} label="Incluir no resumo diário (Telegram e e-mail)"
            hint="Entra no dia em que cada antecedência é atingida e, toda segunda-feira, enquanto estiver urgente. Usa os destinatários de Configurações → Alertas." />
        </div>
      </div>
    </Dialog>
  );
}
