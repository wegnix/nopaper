import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ChevronRight, MessageCircle, Search, Trash2, UserPlus, UsersRound } from 'lucide-react';
import { MONTHS_PT_SHORT, formatBRL, formatDateBR, formatPhoneBR, fromCents, refLabelPT, toCents, whatsappLink } from '@nopaper/shared';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { Button, Card, Empty, Field, Input, Segmented, Switch, Textarea } from '@/components/ui/base';
import { DocumentField } from '@/components/ui/document-input';
import { api, get, post, put, errMsg } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn, plural } from '@/lib/utils';
import { payrollKey, type Employee } from './data';

const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

export function EmployeesTab({ employees, canManage, onOpenMonth }: { employees: Employee[]; canManage: boolean; onOpenMonth: (ref: string) => void }) {
  const [filter, setFilter] = useState<'active' | 'inactive' | 'all'>('active');
  const [q, setQ] = useState('');
  const [form, setForm] = useState<{ open: boolean; emp: Employee | null }>({ open: false, emp: null });
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const list = employees.filter((e) => (filter === 'all' || (filter === 'active') === e.active) && (!q || norm(`${e.name} ${e.role ?? ''}`).includes(norm(q))));
  const counts = { active: employees.filter((e) => e.active).length, inactive: employees.filter((e) => !e.active).length };
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented value={filter} onChange={setFilter} options={[
          { value: 'active', label: `Ativos (${counts.active})` }, { value: 'inactive', label: `Desligados (${counts.inactive})` }, { value: 'all', label: 'Todos' },
        ]} />
        <div className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <Input className="pl-9" placeholder="Buscar funcionário" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        {canManage && <Button variant="primary" className="sm:ml-auto max-sm:w-full" icon={<UserPlus className="size-4" />} onClick={() => setForm({ open: true, emp: null })}>Novo funcionário</Button>}
      </div>
      {!list.length ? (
        <Card><Empty icon={<UsersRound className="size-5" />} title={employees.length ? 'Ninguém neste filtro' : 'Nenhum funcionário cadastrado'}
          action={canManage && !employees.length && <Button variant="primary" onClick={() => setForm({ open: true, emp: null })}>Cadastrar funcionário</Button>}>
          {!employees.length && 'Cadastre os funcionários ou importe a planilha da folha para trazer o histórico.'}
        </Empty></Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {list.map((e) => (
            <button key={e.id} type="button" onClick={() => setForm({ open: true, emp: e })}
              className="group flex min-w-0 items-center gap-3 rounded-xl border border-line bg-surface p-4 text-left shadow-card transition hover:-translate-y-0.5 hover:border-line-strong">
              <span className={cn('grid size-11 shrink-0 place-items-center rounded-full font-display text-sm font-semibold', e.active ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-faint')}>{initials(e.name)}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{e.name}</span>
                <span className="block truncate text-xs text-muted">{e.role || (e.active ? 'Ativo' : 'Desligado')}{e.admissionDate ? ` · desde ${formatDateBR(e.admissionDate)}` : ''}</span>
                <span className="block truncate text-xs text-faint">{e.months ? `${plural(e.months, 'mês', 'meses')} na folha · último ${refLabelPT(e.lastRef!)}` : 'Ainda sem lançamentos'}</span>
              </span>
            </button>
          ))}
        </div>
      )}
      <EmployeeDialog open={form.open} emp={form.emp} canManage={canManage} onClose={() => setForm({ open: false, emp: null })} onOpenMonth={(r) => { setForm({ open: false, emp: null }); onOpenMonth(r); }} />
    </div>
  );
}

interface HistoryRow { ref: string; billsEnabled: boolean; paidAt: string | null; payslipNet: string; total: string; offPayroll: string; companyCost: string; billStatus: 'pending' | 'paid' | null }

/** Mês já pago: conta paga, ou mês do histórico importado (pago fora do NoPaper). */
const isPaid = (h: HistoryRow) => h.billStatus === 'paid' || (!h.billsEnabled && h.billStatus === null);
const sumC = (rows: HistoryRow[], f: (h: HistoryRow) => string) => rows.reduce((a, h) => a + toCents(f(h)), 0);

function EmployeeDialog({ open, emp, canManage, onClose, onOpenMonth }: { open: boolean; emp: Employee | null; canManage: boolean; onClose: () => void; onOpenMonth: (ref: string) => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const orgId = useSession((s) => s.orgId);
  const blank = { name: '', document: '', role: '', admissionDate: '', terminationDate: '', active: true, pixKey: '', phone: '', bankInfo: '', notes: '' };
  const [f, setF] = useState(blank);
  const [tab, setTab] = useState<'data' | 'history'>('data');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setTab('data');
    setF(emp ? {
      name: emp.name, document: emp.document ?? '', role: emp.role ?? '', admissionDate: emp.admissionDate ?? '', terminationDate: emp.terminationDate ?? '',
      active: emp.active, pixKey: emp.pixKey ?? '', phone: emp.phone ?? '', bankInfo: emp.bankInfo ?? '', notes: emp.notes ?? '',
    } : blank);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, emp?.id]);
  const hist = useQuery({
    enabled: open && !!emp && tab === 'history', queryKey: payrollKey(orgId, 'history', emp?.id),
    queryFn: () => get<{ items: HistoryRow[] }>(`/api/payroll/employees/${emp!.id}/history`).then((r) => r.items),
  });
  const ro = !canManage;
  const save = async () => {
    setBusy(true);
    try {
      if (emp) await put(`/api/payroll/employees/${emp.id}`, f); else await post('/api/payroll/employees', f);
      qc.invalidateQueries({ queryKey: ['bills'] });
      toast.success(emp ? 'Funcionário atualizado' : 'Funcionário cadastrado');
      onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!emp) return;
    if (!(await confirm({ title: `Apagar ${emp.name}?`, tone: 'danger', confirmLabel: 'Apagar', body: 'Só é possível apagar quem não tem meses na folha. Quem saiu da empresa: desative.' }))) return;
    try { await api('DELETE', `/api/payroll/employees/${emp.id}`); qc.invalidateQueries({ queryKey: ['bills'] }); toast.success('Funcionário apagado'); onClose(); } catch (e) { toast.error(errMsg(e)); }
  };
  const wa = whatsappLink(f.phone);
  return (
    <Dialog open={open} onClose={onClose} size="lg" title={emp ? emp.name : 'Novo funcionário'}
      footer={tab === 'data' ? <>
        {emp && canManage && emp.months === 0 && <Button variant="ghost" className="mr-auto text-danger hover:text-danger" icon={<Trash2 className="size-4" />} onClick={remove}>Apagar</Button>}
        <Button variant="ghost" onClick={onClose}>{ro ? 'Fechar' : 'Cancelar'}</Button>
        {!ro && <Button variant="primary" loading={busy} disabled={!f.name.trim()} onClick={save}>Salvar</Button>}
      </> : <Button variant="ghost" onClick={onClose}>Fechar</Button>}>
      {emp && <Segmented className="mb-4" value={tab} onChange={setTab} options={[{ value: 'data', label: 'Dados' }, { value: 'history', label: `Histórico (${emp.months})` }]} />}
      {tab === 'data' ? (
        <fieldset disabled={ro} className="grid gap-4 sm:grid-cols-2">
          <Field label="Nome" required className="sm:col-span-2"><Input autoFocus={!emp} maxLength={120} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <DocumentField label="CPF" value={f.document} onChange={(document) => setF({ ...f, document })} />
          <Field label="Cargo / função"><Input maxLength={64} value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} placeholder="Ex.: Balconista, Farmacêutico" /></Field>
          <Field label="Admissão"><DatePicker clearable placeholder="Não informada" value={f.admissionDate} onChange={(admissionDate) => setF({ ...f, admissionDate })} disabled={ro} /></Field>
          <Field label="Desligamento"><DatePicker clearable placeholder="Ainda trabalha aqui" value={f.terminationDate} min={f.admissionDate || undefined} onChange={(terminationDate) => setF({ ...f, terminationDate, active: terminationDate ? false : f.active })} disabled={ro} /></Field>
          <Field label="Telefone / WhatsApp">
            <div className="flex gap-2">
              <Input type="tel" inputMode="tel" autoComplete="off" maxLength={32} className="min-w-0 flex-1" value={f.phone} placeholder="(11) 91234-5678"
                onChange={(e) => setF({ ...f, phone: e.target.value })} onBlur={() => setF((p) => ({ ...p, phone: p.phone ? formatPhoneBR(p.phone) : '' }))} />
              {wa && <a href={wa} target="_blank" rel="noreferrer" className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-lg border border-line px-3 text-sm font-medium text-ok hover:bg-ok/10 pointer-coarse:h-11" title="Abrir conversa no WhatsApp"><MessageCircle className="size-4" /> WhatsApp</a>}
            </div>
          </Field>
          <Field label="Chave PIX" hint="Vai para a conta a pagar do salário."><Input maxLength={140} value={f.pixKey} onChange={(e) => setF({ ...f, pixKey: e.target.value })} /></Field>
          <Field label="Banco / agência / conta" className="sm:col-span-2"><Input maxLength={255} value={f.bankInfo} onChange={(e) => setF({ ...f, bankInfo: e.target.value })} placeholder="Ex.: Bradesco 237 · ag. 0000 · cc 00000-0" /></Field>
          <Field label="Observações" className="sm:col-span-2"><Textarea maxLength={1000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
          <div className="sm:col-span-2"><Switch checked={f.active} onChange={(active) => setF({ ...f, active })} label="Ativo" hint="Só os ativos entram automaticamente ao abrir um mês novo. O histórico de quem saiu continua." /></div>
        </fieldset>
      ) : hist.isLoading ? <p className="py-10 text-center text-sm text-muted">Carregando…</p> : !hist.data?.length ? (
        <p className="py-10 text-center text-sm text-muted">Sem meses na folha.</p>
      ) : (
        <EmployeeHistory rows={hist.data} onOpenMonth={onOpenMonth} />
      )}
    </Dialog>
  );
}

/** Histórico do funcionário: total pago até hoje, por ano e mês a mês (mais recente primeiro). */
function EmployeeHistory({ rows, onOpenMonth }: { rows: HistoryRow[]; onOpenMonth: (ref: string) => void }) {
  const paid = rows.filter(isPaid);
  const pending = rows.filter((h) => h.billStatus === 'pending');
  const paidC = sumC(paid, (h) => h.total);
  const offC = sumC(paid, (h) => h.offPayroll);
  const years = [...new Set(rows.map((h) => h.ref.slice(0, 4)))];
  const max = Math.max(1, ...rows.map((h) => toCents(h.total)));
  const first = rows.at(-1)!.ref;
  const kpi = (label: string, value: string, sub: string, strong?: boolean) => (
    <div className="min-w-0 rounded-xl border border-line bg-surface-2/40 p-3">
      <p className="truncate text-xs text-muted">{label}</p>
      <p className={cn('mt-1 truncate font-display font-semibold tnum', strong ? 'text-xl text-accent' : 'text-lg')}>{value}</p>
      <p className="text-xs leading-snug text-faint">{sub}</p>
    </div>
  );
  return (
    <div className="flex flex-col gap-5">
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {kpi('Pago até hoje', formatBRL(fromCents(paidC)), `${plural(paid.length, 'mês', 'meses')} desde ${refLabelPT(first)}`, true)}
        {kpi('Média por mês', formatBRL(fromCents(paid.length ? Math.round(paidC / paid.length) : 0)), 'nos meses pagos')}
        {kpi('Pelo holerite', formatBRL(fromCents(paidC - offC)), paidC ? `${Math.round(((paidC - offC) / paidC) * 100)}% do total` : '—')}
        {kpi('Por fora', formatBRL(fromCents(offC)), pending.length ? `a pagar: ${formatBRL(fromCents(sumC(pending, (h) => h.total)))}` : 'nada pendente')}
      </div>
      {years.map((y, yi) => {
        const ys = rows.filter((h) => h.ref.startsWith(y));
        const yp = ys.filter(isPaid);
        const yPend = ys.filter((h) => h.billStatus === 'pending');
        return (
          <details key={y} open={yi === 0} className="group">
            <summary className="flex cursor-pointer list-none flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5 border-b border-line pb-2 [&::-webkit-details-marker]:hidden">
              <h3 className="flex items-center gap-1.5 font-display text-lg font-semibold"><ChevronRight className="size-4 self-center text-faint transition-transform group-open:rotate-90" />{y}</h3>
              <p className="text-sm text-muted">
                Pago <b className="font-semibold text-ink tnum">{formatBRL(fromCents(sumC(yp, (h) => h.total)))}</b>
                <span className="text-faint"> · {plural(yp.length, 'mês', 'meses')}</span>
                {sumC(yp, (h) => h.offPayroll) > 0 && <span className="text-accent tnum"> · por fora {formatBRL(fromCents(sumC(yp, (h) => h.offPayroll)))}</span>}
                {yPend.length > 0 && <span className="text-warn tnum"> · a pagar {formatBRL(fromCents(sumC(yPend, (h) => h.total)))}</span>}
              </p>
            </summary>
            <ul className="divide-y divide-line/60">
              {ys.map((h) => (
                <li key={h.ref}>
                  <button type="button" onClick={() => onOpenMonth(h.ref)} className="grid w-full grid-cols-[44px_1fr_auto] items-center gap-3 rounded-md px-1 py-2.5 text-left hover:bg-surface-2/50">
                    <span className="text-sm font-medium">{MONTHS_PT_SHORT[Number(h.ref.slice(5, 7)) - 1]}</span>
                    <span className="flex h-1.5 overflow-hidden rounded-full bg-surface-2" title={`Holerite ${formatBRL(fromCents(toCents(h.total) - toCents(h.offPayroll)))} · por fora ${formatBRL(h.offPayroll)}`}>
                      <span className="h-full bg-accent/45" style={{ width: `${((toCents(h.total) - toCents(h.offPayroll)) / max) * 100}%` }} />
                      <span className="h-full bg-accent" style={{ width: `${(toCents(h.offPayroll) / max) * 100}%` }} />
                    </span>
                    <span className="text-right">
                      <span className="block text-sm font-medium tnum">{formatBRL(h.total)}</span>
                      <span className="block text-xs text-faint tnum">
                        {toCents(h.offPayroll) > 0 ? `por fora ${formatBRL(h.offPayroll)}` : 'só holerite'}
                        {h.billStatus === 'paid' ? ` · pago${h.paidAt ? ` ${formatDateBR(h.paidAt).slice(0, 5)}` : ''}` : h.billStatus === 'pending' ? ' · pendente' : ' · histórico'}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </details>
        );
      })}
      <p className="flex items-center gap-3 text-xs text-faint"><span className="inline-block h-1.5 w-5 rounded-full bg-accent/45" /> pelo holerite <span className="inline-block h-1.5 w-5 rounded-full bg-accent" /> por fora · “histórico” = mês importado da planilha, já pago</p>
    </div>
  );
}
