import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Search, Trash2, UserPlus, UsersRound } from 'lucide-react';
import { formatBRL, formatDateBR, refLabelPT } from '@nopaper/shared';
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

interface HistoryRow { ref: string; payslipNet: string; total: string; offPayroll: string; companyCost: string; billStatus: 'pending' | 'paid' | null }

function EmployeeDialog({ open, emp, canManage, onClose, onOpenMonth }: { open: boolean; emp: Employee | null; canManage: boolean; onClose: () => void; onOpenMonth: (ref: string) => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const orgId = useSession((s) => s.orgId);
  const blank = { name: '', document: '', role: '', admissionDate: '', terminationDate: '', active: true, pixKey: '', bankInfo: '', notes: '' };
  const [f, setF] = useState(blank);
  const [tab, setTab] = useState<'data' | 'history'>('data');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setTab('data');
    setF(emp ? {
      name: emp.name, document: emp.document ?? '', role: emp.role ?? '', admissionDate: emp.admissionDate ?? '', terminationDate: emp.terminationDate ?? '',
      active: emp.active, pixKey: emp.pixKey ?? '', bankInfo: emp.bankInfo ?? '', notes: emp.notes ?? '',
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
  const max = Math.max(1, ...(hist.data ?? []).map((h) => Number(h.total)));
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
          <Field label="Chave PIX" hint="Vai para a conta a pagar do salário."><Input maxLength={140} value={f.pixKey} onChange={(e) => setF({ ...f, pixKey: e.target.value })} /></Field>
          <Field label="Banco / agência / conta"><Input maxLength={255} value={f.bankInfo} onChange={(e) => setF({ ...f, bankInfo: e.target.value })} placeholder="Ex.: Bradesco 237 · ag. 0000 · cc 00000-0" /></Field>
          <Field label="Observações" className="sm:col-span-2"><Textarea maxLength={1000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></Field>
          <div className="sm:col-span-2"><Switch checked={f.active} onChange={(active) => setF({ ...f, active })} label="Ativo" hint="Só os ativos entram automaticamente ao abrir um mês novo. O histórico de quem saiu continua." /></div>
        </fieldset>
      ) : hist.isLoading ? <p className="py-10 text-center text-sm text-muted">Carregando…</p> : !hist.data?.length ? (
        <p className="py-10 text-center text-sm text-muted">Sem meses na folha.</p>
      ) : (
        <ul className="divide-y divide-line">
          {hist.data.map((h) => (
            <li key={h.ref}>
              <button type="button" onClick={() => onOpenMonth(h.ref)} className="grid w-full grid-cols-[72px_1fr_auto] items-center gap-3 py-2.5 text-left hover:bg-surface-2/50">
                <span className="text-sm font-medium tnum">{refLabelPT(h.ref)}</span>
                <span className="h-1.5 overflow-hidden rounded-full bg-surface-2"><span className="block h-full rounded-full bg-accent/70" style={{ width: `${(Number(h.total) / max) * 100}%` }} /></span>
                <span className="text-right">
                  <span className="block text-sm font-medium tnum">{formatBRL(h.total)}</span>
                  <span className="block text-xs text-faint tnum">{Number(h.offPayroll) > 0 ? `por fora ${formatBRL(h.offPayroll)}` : 'só holerite'}{h.billStatus === 'paid' ? ' · pago' : h.billStatus === 'pending' ? ' · pendente' : ''}</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}
