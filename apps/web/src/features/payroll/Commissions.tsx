import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, BadgePercent, Check, Settings2, FileText, Link2, Plus, Target, Trash2, Upload, UserRound, X } from 'lucide-react';
import {
  COMMISSION_BASES, COMMISSION_BASE_LABEL, commissionByRubric, commissionFormula, formatBRL, formatDateBR, personKey, refLabelPT, sellerCommission, sumMoney, toCents,
  type CommissionGroupRef, type CommissionRule, type PayrollCommissions, type SalesReport,
} from '@nopaper/shared';
import { Dialog } from '@/components/ui/dialog';
import { Button, Field, IconButton, Input, Segmented, Select, Spinner, Switch } from '@/components/ui/base';
import { api, post, errMsg } from '@/lib/api';
import { cn, plural } from '@/lib/utils';
import { useMonth, type CommissionImport, type Employee, type Entry, type Period, type PeriodSummary, type Rubric } from './data';

const newId = () => `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const num = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 4 });
const parseNum = (s: string) => { const n = Number(s.trim().replace(/\./g, '').replace(',', '.')); return s.trim() && Number.isFinite(n) && n >= 0 ? n : null; };
const sortGroups = (gs: CommissionGroupRef[]) => [...gs].sort((a, b) => Number(a.code) - Number(b.code) || a.code.localeCompare(b.code));

/** Campo numérico em pt-BR ("3,5"): só aplica ao sair do campo, se for um número válido. */
function NumInput({ value, onChange, className, ...rest }: { value: number; onChange: (n: number) => void; className?: string; 'aria-label'?: string; placeholder?: string }) {
  const [s, setS] = useState(num(value));
  useEffect(() => setS(num(value)), [value]);
  return (
    <Input inputMode="decimal" className={cn('tnum', className)} value={s} {...rest}
      onChange={(e) => setS(e.target.value)} onBlur={() => { const n = parseNum(s); if (n === null) setS(num(value)); else onChange(n); }} />
  );
}

// ------------------------------------------------------------------ Configurar → Comissões
export function CommissionsEditor({ value, onChange, knownGroups, rubrics, employees }: {
  value: PayrollCommissions; onChange: (v: PayrollCommissions) => void; knownGroups: CommissionGroupRef[]; rubrics: Rubric[]; employees: Employee[];
}) {
  const targets = rubrics.filter((r) => r.section === 'extra' && r.kind === 'earning' && r.active);
  const sellers = employees.filter((e) => e.sellerCode).sort((a, b) => Number(a.sellerCode) - Number(b.sellerCode));
  const setRule = (i: number, r: CommissionRule) => onChange({ ...value, rules: value.rules.map((x, k) => (k === i ? r : x)) });
  const add = () => {
    const def = targets.find((r) => personKey(r.name) === 'comissao') ?? targets[0];
    onChange({ ...value, rules: [...value.rules, { id: newId(), name: '', groups: [], base: 'sales', rate: 3, tiers: [], rubricId: def?.id ?? '', active: true }] });
  };
  return (
    <div className="flex flex-col gap-6">
      <p className="text-sm text-muted">
        Todo mês, no botão <b className="text-ink">Importar vendas</b> da Folha de pagamento, envie o relatório de vendas em PDF (“Vendas Vendedor e Grupo Produtos”, totais por vendedor e grupo).
        Cada regra soma os grupos escolhidos e lança o valor na rubrica dela para cada vendedor ligado a um funcionário.
      </p>

      <section className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-2 border-b border-line pb-2">
          <h3 className="font-display font-semibold">Regras</h3>
          <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={add}>Nova regra</Button>
        </div>
        {!targets.length && <p className="rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn">Crie antes uma rubrica de provento “Fora do holerite” (aba Rubricas) para receber as comissões.</p>}
        {!value.rules.length ? (
          <button type="button" onClick={add} className="flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-line px-6 py-8 text-center transition hover:border-accent hover:bg-accent-soft/30">
            <span className="grid size-11 place-items-center rounded-2xl bg-accent-soft text-accent"><BadgePercent className="size-5" /></span>
            <span className="font-medium">Criar a primeira regra</span>
            <span className="text-xs text-faint">Ex.: Genérico + Similar → 3% sobre o valor de vendas → Meta individual.</span>
          </button>
        ) : (
          <ul className="flex flex-col gap-3">
            {value.rules.map((r, i) => (
              <RuleCard key={r.id} rule={r} targets={targets} knownGroups={knownGroups} onChange={(x) => setRule(i, x)}
                onRemove={() => onChange({ ...value, rules: value.rules.filter((_, k) => k !== i) })} />
            ))}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-2 border-t border-line pt-5">
        <h3 className="font-display font-semibold">Quem recebe</h3>
        <p className="text-xs text-faint">Recebe comissão quem tem o <b>código de vendedor</b> no cadastro (aba Funcionários), o mesmo número do relatório. Dá para ligar também na hora de importar o relatório.</p>
        {sellers.length ? (
          <ul className="flex flex-wrap gap-2">
            {sellers.map((e) => (
              <li key={e.id} className={cn('inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-2/60 px-2.5 py-1 text-sm', !e.active && 'opacity-60')}>
                <span className="tnum rounded-full bg-accent-soft px-1.5 text-xs font-semibold text-accent">{e.sellerCode}</span>{e.name}
              </li>
            ))}
          </ul>
        ) : <p className="text-sm text-muted">Ninguém ainda.</p>}
      </section>
    </div>
  );
}

function RuleCard({ rule: r, targets, knownGroups, onChange, onRemove }: {
  rule: CommissionRule; targets: Rubric[]; knownGroups: CommissionGroupRef[]; onChange: (r: CommissionRule) => void; onRemove: () => void;
}) {
  const [code, setCode] = useState('');
  const [editing, setEditing] = useState(!r.groups.length);
  const all = sortGroups([...knownGroups, ...r.groups.filter((g) => !knownGroups.some((k) => k.code === g.code))]);
  const has = (c: string) => r.groups.some((g) => g.code === c);
  const toggle = (g: CommissionGroupRef) => onChange({ ...r, groups: has(g.code) ? r.groups.filter((x) => x.code !== g.code) : sortGroups([...r.groups, g]) });
  const addCode = () => { const c = code.trim(); if (c && !has(c)) onChange({ ...r, groups: sortGroups([...r.groups, { code: c, name: '' }]) }); setCode(''); };
  const unit = r.base === 'quantity' ? 'R$ por unidade' : '%';
  const minUnit = r.base === 'quantity' ? 'unidades' : 'R$ em vendas';
  return (
    <li className={cn('rounded-xl border border-line bg-surface-2/40 p-3.5 sm:p-4', !r.active && 'opacity-70')}>
      <div className="flex flex-wrap items-center gap-2">
        <Input aria-label="Nome da regra" className="h-9 min-w-40 flex-1 font-medium" maxLength={60} placeholder="Nome da regra (ex.: Genérico + Similar)" value={r.name} onChange={(e) => onChange({ ...r, name: e.target.value })} />
        <div className="w-[92px]"><Switch checked={r.active} onChange={(active) => onChange({ ...r, active })} label={<span className="text-xs text-muted">{r.active ? 'Ativa' : 'Inativa'}</span>} /></div>
        <IconButton label="Apagar regra" tone="danger" onClick={onRemove}><Trash2 className="size-4" /></IconButton>
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-medium text-muted">Grupos de produtos</span>
          {!!r.groups.length && <Button size="sm" variant="ghost" onClick={() => setEditing(!editing)}>{editing ? 'Pronto' : 'Escolher grupos'}</Button>}
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {(editing ? all : r.groups).map((g) => (
            <button key={g.code} type="button" disabled={!editing} onClick={() => toggle(g)} aria-pressed={has(g.code)}
              className={cn('inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-xs transition pointer-coarse:h-9',
                has(g.code) ? 'border-accent bg-accent text-white' : 'border-line bg-surface text-muted hover:border-line-strong hover:text-ink')}>
              <span className="tnum opacity-75">{g.code}</span>{g.name || 'grupo'}
            </button>
          ))}
          {editing && <span className="inline-flex items-center gap-1">
            <Input aria-label="Código do grupo" inputMode="numeric" className="h-7 w-24 text-xs pointer-coarse:h-9" maxLength={12} placeholder="+ código" value={code}
              onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCode(); } }} onBlur={addCode} />
          </span>}
        </div>
        {editing && !knownGroups.length && <p className="mt-1.5 text-xs text-faint">Use “Ler grupos de um relatório” para escolher pelo nome, ou digite o código do grupo (a coluna “Código” do relatório).</p>}
      </div>

      <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_140px_1fr]">
        <Field label="Como calcula">
          <Select value={r.base} onChange={(e) => onChange({ ...r, base: e.target.value as CommissionRule['base'] })}>
            {COMMISSION_BASES.map((b) => <option key={b} value={b}>{COMMISSION_BASE_LABEL[b]}</option>)}
          </Select>
        </Field>
        <Field label={r.base === 'quantity' ? 'R$ por unidade' : 'Percentual (%)'}>
          <NumInput aria-label="Taxa" value={r.rate} onChange={(rate) => onChange({ ...r, rate })} />
        </Field>
        <Field label="Lança na rubrica">
          <Select value={r.rubricId} onChange={(e) => onChange({ ...r, rubricId: e.target.value })}>
            <option value="">Escolha…</option>
            {targets.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </Select>
        </Field>
      </div>

      <div className="mt-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-[13px] font-medium text-muted">Metas</span>
          <Button size="sm" variant="ghost" icon={<Target className="size-3.5" />}
            onClick={() => onChange({ ...r, tiers: [...r.tiers, { min: r.base === 'quantity' ? 30 : 10000, rate: r.rate }] })}>Adicionar meta</Button>
        </div>
        {r.tiers.length ? (
          <ul className="mt-1 flex flex-col gap-2">
            {r.tiers.map((t, k) => (
              <li key={k} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted">A partir de</span>
                <NumInput aria-label="Meta" className="h-9 w-24" value={t.min} onChange={(min) => min > 0 && onChange({ ...r, tiers: r.tiers.map((x, j) => (j === k ? { ...x, min } : x)) })} />
                <span className="text-muted">{minUnit}, paga</span>
                <NumInput aria-label="Taxa da meta" className="h-9 w-24" value={t.rate} onChange={(rate) => onChange({ ...r, tiers: r.tiers.map((x, j) => (j === k ? { ...x, rate } : x)) })} />
                <span className="text-muted">{unit} sobre tudo</span>
                <IconButton label="Tirar meta" onClick={() => onChange({ ...r, tiers: r.tiers.filter((_, j) => j !== k) })}><X className="size-4" /></IconButton>
              </li>
            ))}
          </ul>
        ) : <p className="mt-0.5 text-xs text-faint">Sem meta: vale sempre a taxa acima.</p>}
      </div>
    </li>
  );
}

// ------------------------------------------------------------------ mês → importar relatório
interface ApplyResult {
  applied: Array<{ employee: string; total: string; created: boolean }>;
  skipped: Array<{ employee: string; reason: string }>;
  missing: string[];
}

export function CommissionsDialog({ open, onClose, periods, currentRef, employees, rubrics, commissions, canManage, canEdit = true, onConfigure, onDone, initial }: {
  open: boolean; onClose: () => void; periods: PeriodSummary[]; currentRef: string; employees: Employee[]; rubrics: Rubric[]; commissions: PayrollCommissions;
  canManage: boolean; canEdit?: boolean; onConfigure: () => void; onDone: (ref: string) => void;
  /** Rever uma importação já feita (sem enviar o PDF de novo). */
  initial?: (CommissionImport & { ref: string }) | null;
}) {
  const qc = useQueryClient();
  /** Mês da folha que recebe as comissões (padrão: o mês das vendas do relatório). */
  const [ref, setRef] = useState(currentRef);
  const month = useMonth(ref);
  const period: Period | null = month.data?.period ?? null;
  const entries = month.data?.entries ?? [];
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ fileName: string; report: SalesReport } | null>(null);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Ligações escolhidas na prévia: código do vendedor → funcionário (null = não recebe). */
  const [links, setLinks] = useState<Record<string, string | null>>({});
  useEffect(() => {
    if (!open) return;
    setLinks({});
    if (initial) { setFile({ fileName: initial.fileName, report: { company: null, from: initial.from, to: initial.to, sellers: initial.sellers, warnings: [] } }); setRef(initial.ref); }
    else setFile(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial?.id]);
  const hasRef = (r: string) => periods.some((p) => p.ref === r);

  const rules = commissions.rules.filter((r) => r.active);
  const rname = useMemo(() => new Map(rubrics.map((r) => [r.id, r.name])), [rubrics]);
  const target = useMemo(() => new Set(rules.map((r) => r.rubricId)), [rules]);
  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);

  const pick = async (f: File) => {
    setReading(true);
    try {
      const fd = new FormData(); fd.append('file', f);
      const r = await api<{ fileName: string; report: SalesReport }>('POST', '/api/payroll/commissions/read', fd);
      setLinks({});
      setFile(r);
      const rr = r.report.to?.slice(0, 7);
      if (!initial) setRef(rr && hasRef(rr) ? rr : hasRef(currentRef) ? currentRef : periods[0]?.ref ?? currentRef);
      qc.invalidateQueries({ queryKey: ['bills'] }); // grupos novos na configuração
    } catch (e) { toast.error(errMsg(e)); } finally { setReading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const linkOf = (code: string) => (code in links ? links[code] : employees.find((e) => e.sellerCode === code)?.id ?? null);
  const rows = (file?.report.sellers ?? []).map((s) => {
    const empId = linkOf(s.code);
    const emp = empId ? empById.get(empId) ?? null : null;
    const c = sellerCommission(s, rules);
    const entry = emp ? entries.find((e) => e.employeeId === emp.id) ?? null : null;
    const before = entry ? sumMoney(entry.lines.filter((l) => target.has(l.rubricId)).map((l) => l.amount)) : '0.00';
    // compara rubrica por rubrica: o total pode ser o mesmo e mudar só a divisão (regra trocou de rubrica)
    const byR = commissionByRubric(c);
    const deltas = [...target].map((rid) => ({
      rubricId: rid,
      from: entry ? entry.lines.filter((l) => l.rubricId === rid).reduce((a, l) => a + toCents(l.amount), 0) : 0,
      to: toCents(byR.get(rid)?.amount ?? '0'),
    })).filter((d) => d.from !== d.to);
    return { s, emp, c, entry, before, deltas, paid: entry?.bill?.status === 'paid' };
  });
  const linked = rows.filter((r) => r.emp);
  const others = rows.filter((r) => !r.emp);
  const changedLinks = Object.entries(links).filter(([code, id]) => (employees.find((e) => e.sellerCode === code)?.id ?? null) !== id);
  /** O que muda ao lançar: valor diferente do que está na folha (ou lançamento novo) + ligações alteradas. */
  const toApply = linked.filter((r) => !r.paid && (r.entry ? r.deltas.length > 0 : toCents(r.c.total) > 0));
  const changes = toApply.length + changedLinks.length;
  const usedBy = (empId: string, code: string) => rows.some((r) => r.s.code !== code && r.emp?.id === empId);
  /** Sugestão (só com clique): funcionário ativo, livre, cujo nome bate com o começo do nome do vendedor. */
  const suggestion = (s: SalesReport['sellers'][number]) => {
    const b = personKey(s.name);
    const m = employees.filter((e) => e.active && !usedBy(e.id, s.code) && !rows.some((r) => r.emp?.id === e.id) && (() => { const a = personKey(e.name); return a === b || b.startsWith(`${a} `) || a.startsWith(`${b} `); })());
    return m.length === 1 ? m[0] : null;
  };
  const reportRef = file?.report.to?.slice(0, 7) ?? null;

  const run = async () => {
    if (!file || !period) return;
    setBusy(true);
    try {
      const changed = changedLinks;
      const r = await post<ApplyResult>(`/api/payroll/periods/${period.id}/commissions`, {
        fileName: file.fileName, from: file.report.from, to: file.report.to,
        sellers: file.report.sellers, links: changed.map(([code, employeeId]) => ({ code, employeeId })),
      });
      qc.invalidateQueries({ queryKey: ['bills'] });
      const total = sumMoney(r.applied.map((a) => a.total));
      toast.success(r.applied.length ? `Comissões lançadas: ${plural(r.applied.length, 'funcionário', 'funcionários')} · ${formatBRL(total)}` : 'Nada mudou: as comissões já estavam lançadas');
      if (r.skipped.length) toast.warning(`Ficaram de fora: ${r.skipped.map((s) => `${s.employee} (${s.reason})`).join(', ')}`);
      if (r.missing.length) toast.info(`Não aparecem no relatório: ${r.missing.join(', ')}`);
      onDone(period.ref);
      onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onClose={onClose} size="xl" title={initial ? `Comissões · ${refLabelPT(initial.ref)}` : 'Importar vendas (comissões)'}
      description={initial
        ? `Importado de “${initial.fileName}” em ${formatDateBR(initial.createdAt.slice(0, 10))}${initial.createdByName ? ` por ${initial.createdByName}` : ''}. Confira; se mudar regras ou ligações, lance de novo.`
        : 'Envie o relatório de vendas em PDF. As comissões entram nas rubricas configuradas do mês escolhido; importar de novo substitui os valores.'}
      footer={file ? <>
        <span className="mr-auto flex flex-wrap gap-1">
          {canEdit && <Button variant="ghost" onClick={() => setFile(null)}>{initial ? 'Enviar outro relatório' : 'Trocar arquivo'}</Button>}
          {canManage && <Button variant="ghost" icon={<Settings2 className="size-4" />} onClick={onConfigure}>Regras</Button>}
        </span>
        <Button variant="ghost" onClick={onClose}>Fechar</Button>
        {canEdit && <Button variant="primary" loading={busy} disabled={!rules.length || !changes || !period} onClick={run}>
          {!changes && linked.length ? 'Tudo já lançado' : initial ? `Lançar ${plural(changes, 'alteração', 'alterações')}` : `Lançar ${plural(changes, 'comissão', 'comissões')}`}
        </Button>}
      </> : <Button variant="ghost" onClick={onClose}>Fechar</Button>}>
      <input ref={fileRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
      {!rules.length && canEdit && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg bg-warn/10 px-3.5 py-3 text-sm text-warn">
          <AlertTriangle className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">Ainda não há regras de comissão ativas.</span>
          {canManage && <Button size="sm" variant="secondary" onClick={onConfigure}>Configurar comissões</Button>}
        </div>
      )}
      {!file ? (
        <button type="button" onClick={() => fileRef.current?.click()} disabled={reading}
          className="flex w-full flex-col items-center gap-3 rounded-xl border-2 border-dashed border-line px-6 py-12 text-center transition hover:border-accent hover:bg-accent-soft/30">
          {reading ? <Spinner className="size-6" /> : <span className="grid size-12 place-items-center rounded-2xl bg-accent-soft text-accent"><Upload className="size-5" /></span>}
          <span className="font-medium">{reading ? 'Lendo o relatório…' : 'Escolher o relatório de vendas (.pdf)'}</span>
          <span className="text-xs text-faint">“Vendas Vendedor e Grupo Produtos”, com totais por vendedor e grupo de produtos, do mês todo.</span>
        </button>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-surface-2/60 px-3.5 py-2.5 text-sm">
            <span className="inline-flex min-w-0 items-center gap-1.5"><FileText className="size-4 shrink-0 text-faint" /><span className="truncate">{file.fileName}</span></span>
            {file.report.from && file.report.to && <span className="text-muted">Vendas de <b className="tnum text-ink">{formatDateBR(file.report.from)}</b> a <b className="tnum text-ink">{formatDateBR(file.report.to)}</b></span>}
            <span className="text-muted">{plural(file.report.sellers.length, 'vendedor', 'vendedores')}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-sm font-medium">Lançar na folha de</span>
            {initial ? <b className="text-sm">{refLabelPT(initial.ref)}</b> : periods.length ? (
              <Select aria-label="Mês da folha" className="h-9 w-auto min-w-40" value={hasRef(ref) ? ref : ''} onChange={(e) => setRef(e.target.value)}>
                {!hasRef(ref) && <option value="">Escolha o mês…</option>}
                {periods.map((p) => <option key={p.ref} value={p.ref}>{refLabelPT(p.ref)}</option>)}
              </Select>
            ) : <span className="text-sm text-warn">nenhum mês aberto</span>}
            {month.isFetching && <Spinner className="size-4" />}
          </div>
          {reportRef && !hasRef(reportRef) && (
            <p className="flex items-start gap-2 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn"><AlertTriangle className="mt-0.5 size-4 shrink-0" />A folha de {refLabelPT(reportRef)} (mês das vendas) ainda não foi aberta. Abra o mês na Folha de pagamento ou escolha outro mês acima.</p>
          )}
          {reportRef && hasRef(reportRef) && hasRef(ref) && reportRef !== ref && (
            <p className="flex items-start gap-2 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn"><AlertTriangle className="mt-0.5 size-4 shrink-0" />O relatório é de {refLabelPT(reportRef)} e você escolheu a folha de {refLabelPT(ref)}. Confira se é o mês certo.</p>
          )}
          {file.report.warnings.map((w) => <p key={w} className="flex items-start gap-2 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{w}</p>)}

          {linked.length ? (
            <div className="grid gap-3 lg:grid-cols-2">
              {linked.map((r) => <SellerCard key={r.s.code} row={r} rname={rname} onUnlink={canManage ? () => setLinks({ ...links, [r.s.code]: null }) : undefined} />)}
            </div>
          ) : (
            <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-muted">Nenhum vendedor do relatório está ligado a um funcionário. {canManage ? 'Escolha abaixo quem recebe comissão.' : 'Peça a quem gerencia a folha para informar o código de vendedor no cadastro.'}</p>
          )}

          {others.length > 0 && (
            <section>
              <h3 className="mb-1 text-sm font-medium text-muted">Não recebem comissão</h3>
              <ul className="divide-y divide-line rounded-xl border border-line">
                {others.map((r) => (
                  <li key={r.s.code} className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3">
                    <span className="flex min-w-0 flex-1 items-center gap-3">
                      <span className="tnum grid h-6 min-w-6 shrink-0 place-items-center rounded-full bg-surface-2 px-1.5 text-xs font-semibold text-muted">{r.s.code}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm">{r.s.name}</span>
                        <span className="block text-xs text-faint tnum">{formatBRL(sumMoney(r.s.groups.map((g) => g.sales)))} em vendas</span>
                      </span>
                    </span>
                    {canManage && (
                      <span className="flex flex-wrap items-center gap-2">
                        {(() => { const sg = suggestion(r.s); return sg && (
                          <Button size="sm" variant="ghost" icon={<Link2 className="size-3.5" />} onClick={() => setLinks({ ...links, [r.s.code]: sg.id })}>Ligar a {sg.name}?</Button>
                        ); })()}
                        <Select aria-label={`Ligar ${r.s.name} a um funcionário`} className="h-9 min-w-0 flex-1 sm:w-56 sm:flex-none" value=""
                          onChange={(e) => e.target.value && setLinks({ ...links, [r.s.code]: e.target.value })}>
                          <option value="">Ligar a um funcionário…</option>
                          {employees.filter((e) => e.active && !usedBy(e.id, r.s.code)).map((e) => <option key={e.id} value={e.id}>{e.name}{e.sellerCode ? ` (hoje: vendedor ${e.sellerCode})` : ''}</option>)}
                        </Select>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          )}
          {Object.keys(links).some((c) => (employees.find((e) => e.sellerCode === c)?.id ?? null) !== links[c]) && (
            <p className="flex items-start gap-2 text-xs text-faint"><Link2 className="mt-0.5 size-3.5 shrink-0" />As ligações novas ficam salvas no cadastro do funcionário (código de vendedor) e valem para os próximos meses.</p>
          )}
        </div>
      )}
    </Dialog>
  );
}

function SellerCard({ row: r, rname, onUnlink }: {
  row: { s: SalesReport['sellers'][number]; emp: Employee | null; c: ReturnType<typeof sellerCommission>; entry: Entry | null; before: string; paid: boolean; deltas: Array<{ rubricId: string; from: number; to: number }> };
  rname: Map<string, string>; onUnlink?: () => void;
}) {
  const byRubric = [...commissionByRubric(r.c)];
  const diff = toCents(r.c.total) - toCents(r.before);
  const money = (c: number) => (c ? formatBRL(c / 100) : '—');
  return (
    <div className={cn('flex min-w-0 flex-col rounded-xl border border-line bg-surface p-3.5 shadow-card', r.paid && 'opacity-70')}>
      <div className="flex items-start gap-3">
        <span className="grid size-9 shrink-0 place-items-center rounded-full bg-accent-soft text-accent"><UserRound className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium">{r.emp!.name}</p>
          <p className="truncate text-xs text-faint">Vendedor {r.s.code} · {r.s.name}</p>
        </div>
        <div className="text-right">
          <p className="font-display text-lg font-semibold tnum">{formatBRL(r.c.total)}</p>
          {r.entry && diff !== 0 && <p className="text-xs text-faint tnum" title="Soma das rubricas de comissão que estão hoje no lançamento deste mês">na folha hoje: {formatBRL(r.before)}</p>}
        </div>
        {onUnlink && <IconButton label="Não recebe comissão" onClick={onUnlink}><X className="size-4" /></IconButton>}
      </div>
      <ul className="mt-3 flex flex-col gap-1.5 border-t border-line/70 pt-2.5 text-sm">
        {byRubric.map(([rid, v]) => v.lines.map((l) => (
          <li key={`${rid}-${l.ruleId}`} className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1">
              <span className="block truncate">{l.ruleName}<span className="text-faint"> → {rname.get(rid) ?? 'rubrica'}</span></span>
              <span className="block truncate text-xs text-faint tnum">
                {l.groups.length ? commissionFormula(l) : 'sem vendas nesses grupos'}
                {l.tierMin !== null && <span className="ml-1 font-medium text-ok">meta batida</span>}
              </span>
            </span>
            <b className={cn('tnum', !toCents(l.amount) && 'font-normal text-faint')}>{formatBRL(l.amount)}</b>
          </li>
        )))}
      </ul>
      <p className="mt-2.5 text-xs">
        {r.paid ? <span className="text-warn">Salário já pago: não muda (reverta o pagamento para lançar).</span>
          : !r.entry ? <span className="text-accent">Entra na folha do mês (ainda não tem lançamento).</span>
            : !r.deltas.length ? <span className="inline-flex items-center gap-1 text-ok"><Check className="size-3.5" />Lançado na folha com esses valores.</span>
              : <span className="text-warn">{diff === 0 ? 'Mesmo total, mas muda a divisão entre as rubricas.' : <>Na folha hoje está {formatBRL(r.before)}: ao lançar, passa a {formatBRL(r.c.total)} ({diff > 0 ? '+' : '−'}{formatBRL(Math.abs(diff) / 100)}).</>}</span>}
      </p>
      {r.entry && !r.paid && r.deltas.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-0.5 rounded-lg bg-warn/10 px-2.5 py-1.5 text-xs">
          {r.deltas.map((d) => (
            <li key={d.rubricId} className="flex justify-between gap-2 tnum">
              <span className="truncate">{rname.get(d.rubricId) ?? 'rubrica'}</span>
              <span className="shrink-0">{money(d.from)} → <b>{money(d.to)}</b></span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
