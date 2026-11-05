import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { CalendarCheck, Minus, Pin, Plus, Trash2 } from 'lucide-react';
import { MONTHS_PT, PAYROLL_SECTIONS, PAYROLL_SECTION_LABEL, defaultPayDate, formatDateBR, todayISO, type PayrollKind, type PayrollSection, type PayrollSettings } from '@nopaper/shared';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { DayPicker } from '@/components/ui/day-picker';
import { Button, Field, IconButton, Input, Segmented, Select, Switch } from '@/components/ui/base';
import { api, post, put, errMsg } from '@/lib/api';
import { useCategories, useFolders } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { SECTION_HINT, type Rubric } from './data';

export function SettingsDialog({ open, onClose, settings, rubrics }: { open: boolean; onClose: () => void; settings: PayrollSettings; rubrics: Rubric[] }) {
  const qc = useQueryClient();
  const { data: cats = [] } = useCategories();
  const { data: folders = [] } = useFolders();
  const payCats = cats.filter((c) => c.kind !== 'receivable');
  const [tab, setTab] = useState<'bills' | 'rubrics'>('bills');
  const [f, setF] = useState(settings);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (open) setF(settings); }, [open, settings]);
  const nextRef = todayISO().slice(0, 7);
  const save = async () => {
    setBusy(true);
    try {
      await put('/api/payroll/settings', { ...f, folderId: f.folderId || null, paymentMethod: f.paymentMethod || null });
      qc.invalidateQueries({ queryKey: ['bills'] });
      toast.success('Configuração salva');
      onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Configurar folha de pagamento"
      footer={tab === 'bills' ? <><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={busy} disabled={!f.categoryId} onClick={save}>Salvar</Button></> : <Button variant="ghost" onClick={onClose}>Fechar</Button>}>
      <Segmented className="mb-4" value={tab} onChange={setTab} options={[{ value: 'bills', label: 'Contas a pagar' }, { value: 'rubrics', label: 'Rubricas' }]} />
      {tab === 'bills' ? (
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-4">
            <div>
              <h3 className="font-display font-semibold">Conta de salário</h3>
              <p className="mt-0.5 text-xs text-faint">Como cada salário aparece em Contas a pagar.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Categoria" required>
                <Select value={f.categoryId ?? ''} onChange={(e) => setF({ ...f, categoryId: e.target.value || null })}>
                  <option value="">Escolha…</option>
                  {payCats.map((c) => <option key={c.id} value={c.id}>{c.label}{c.isRestricted ? ' (restrita)' : ''}</option>)}
                </Select>
              </Field>
              <Field label="Pasta">
                <Select value={f.folderId ?? ''} onChange={(e) => setF({ ...f, folderId: e.target.value || null })}>
                  <option value="">Sem pasta</option>
                  {folders.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
                </Select>
              </Field>
              <Field label="Forma de pagamento"><Input maxLength={64} value={f.paymentMethod ?? ''} onChange={(e) => setF({ ...f, paymentMethod: e.target.value })} placeholder="PIX" /></Field>
            </div>
          </section>

          <section className="flex flex-col gap-4 border-t border-line pt-5">
            <div>
              <h3 className="font-display font-semibold">Vencimento</h3>
              <p className="mt-0.5 text-xs text-faint">Data sugerida ao abrir cada mês — dá para mudar no próprio mês.</p>
            </div>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="text-[13px] font-medium text-muted">Dia do pagamento</span>
                <DayPicker aria-label="Dia do pagamento" value={f.payDay} onChange={(payDay) => setF({ ...f, payDay })} special={{ value: 0, label: '5º dia útil' }} />
              </div>
              <div className="flex min-w-0 flex-col gap-1.5">
                <span className="text-[13px] font-medium text-muted">Mês do pagamento</span>
                <Segmented className="w-full" value={f.payMonth} onChange={(payMonth) => setF({ ...f, payMonth })}
                  options={[{ value: 'next', label: 'Seguinte à competência' }, { value: 'same', label: 'Mesmo da competência' }]} />
              </div>
            </div>
            <div className="flex items-start gap-3 rounded-lg bg-accent-soft/50 px-3.5 py-3">
              <CalendarCheck className="mt-0.5 size-4 shrink-0 text-accent" />
              <p className="text-sm">
                A folha de <b>{MONTHS_PT[Number(nextRef.slice(5)) - 1].toLowerCase()}/{nextRef.slice(0, 4)}</b> vence em <b className="tnum">{formatDateBR(defaultPayDate(nextRef, f.payDay, f.payMonth))}</b>.
                {f.payDay === 0 && <span className="mt-0.5 block text-xs text-muted">O 5º dia útil conta de segunda a sábado e não desconta feriados.</span>}
              </p>
            </div>
          </section>

          <p className="text-xs text-faint">Ao salvar, os salários ainda pendentes passam a usar a categoria, a pasta e a forma de pagamento novas. A data vale para os meses abertos daqui em diante.</p>
        </div>
      ) : <RubricsEditor rubrics={rubrics} />}
    </Dialog>
  );
}

function RubricsEditor({ rubrics }: { rubrics: Rubric[] }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const [adding, setAdding] = useState<{ section: PayrollSection; name: string; kind: PayrollKind; fixed: boolean } | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ['bills'] });
  const update = async (r: Rubric, patch: Partial<Rubric>) => {
    try { await put(`/api/payroll/rubrics/${r.id}`, { name: r.name, section: r.section, kind: r.kind, fixed: r.fixed, active: r.active, ...patch }); refresh(); } catch (e) { toast.error(errMsg(e)); }
  };
  const remove = async (r: Rubric) => {
    if (!(await confirm({ title: `Apagar a rubrica "${r.name}"?`, tone: 'danger', confirmLabel: 'Apagar' }))) return;
    try { await api('DELETE', `/api/payroll/rubrics/${r.id}`); refresh(); toast.success('Rubrica apagada'); } catch (e) { toast.error(errMsg(e)); }
  };
  const add = async () => {
    if (!adding?.name.trim()) return;
    try { await post('/api/payroll/rubrics', { ...adding, active: true }); setAdding(null); refresh(); toast.success('Rubrica criada'); } catch (e) { toast.error(errMsg(e)); }
  };
  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-faint">Rubricas com <Pin className="inline size-3" /> são copiadas para o mês seguinte ao abrir a folha (ex.: salário base, INSS). As outras começam em branco todo mês. Uma rubrica já usada pode ser renomeada ou desativada, mas não mudar de grupo.</p>
      {PAYROLL_SECTIONS.map((s) => (
        <section key={s}>
          <div className="flex items-center justify-between gap-2 border-b border-line pb-2">
            <h3 className="font-display font-semibold">{PAYROLL_SECTION_LABEL[s]}</h3>
            <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setAdding({ section: s, name: '', kind: s === 'payslip' ? 'deduction' : 'earning', fixed: false })}>Nova</Button>
          </div>
          <p className="mt-1.5 text-xs text-faint">{SECTION_HINT[s]}</p>
          <ul className="mt-1 divide-y divide-line/60">
            {rubrics.filter((r) => r.section === s).map((r) => <RubricRow key={r.id} r={r} onUpdate={(p) => update(r, p)} onRemove={() => remove(r)} />)}
          </ul>
          {adding?.section === s && (
            <div className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-surface-2/60 p-2">
              <Input autoFocus className="min-w-0 flex-1" maxLength={64} placeholder="Nome da rubrica" value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} onKeyDown={(e) => e.key === 'Enter' && add()} />
              {s !== 'employer' && <Segmented value={adding.kind} onChange={(kind) => setAdding({ ...adding, kind })} options={[{ value: 'earning', label: 'Soma' }, { value: 'deduction', label: 'Desconta' }]} />}
              <Button size="sm" variant="primary" onClick={add} disabled={!adding.name.trim()}>Adicionar</Button>
              <Button size="sm" variant="ghost" onClick={() => setAdding(null)}>Cancelar</Button>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

function RubricRow({ r, onUpdate, onRemove }: { r: Rubric; onUpdate: (p: Partial<Rubric>) => void; onRemove: () => void }) {
  const [name, setName] = useState(r.name);
  useEffect(() => setName(r.name), [r.name]);
  return (
    <li className={cn('flex flex-wrap items-center gap-2 py-2', !r.active && 'opacity-60')}>
      {r.section !== 'employer' && (r.kind === 'deduction' ? <Minus className="size-4 shrink-0 text-danger" aria-label="desconta" /> : <Plus className="size-4 shrink-0 text-ok" aria-label="soma" />)}
      <Input aria-label="Nome" className="h-9 min-w-0 flex-1" maxLength={64} value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== r.name && onUpdate({ name: name.trim() })} />
      <span className="text-xs text-faint tnum">{r.usage ? `${r.usage} uso(s)` : 'sem uso'}</span>
      <IconButton label={r.fixed ? 'Copiada para o mês seguinte (clique para não copiar)' : 'Não é copiada (clique para copiar ao abrir o mês)'} onClick={() => onUpdate({ fixed: !r.fixed })}
        className={r.fixed ? 'text-accent' : undefined}><Pin className="size-4" /></IconButton>
      <div className="w-[92px]"><Switch checked={r.active} onChange={(active) => onUpdate({ active })} label={<span className="text-xs text-muted">{r.active ? 'Ativa' : 'Inativa'}</span>} /></div>
      {!r.usage && <IconButton label="Apagar" tone="danger" onClick={onRemove}><Trash2 className="size-4" /></IconButton>}
    </li>
  );
}
