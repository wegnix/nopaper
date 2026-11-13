import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Check, FileText, Ghost, Lock, Minus, Plus, Upload, UserPlus, UserRound } from 'lucide-react';
import { MoneyInput } from '@/features/bills/MoneyInput';
import {
  PAYSLIP_ADJUST_NOTE, addMonthsRef, formatBRL, fromCents, isProLabore, payrollTotals, payslipEmployeeFor, payslipOk, payslipRubricFor, payslipRubricName, personKey, refLabelPT, titleCaseName, toCents,
  type PayrollCosts, type PayrollPayslipsSettings, type Payslip, type PayslipItem, type PayslipReport, type SpaceCheck,
} from '@nopaper/shared';
import { Dialog } from '@/components/ui/dialog';
import { Button, Select, Spinner } from '@/components/ui/base';
import { api, post, put, errMsg } from '@/lib/api';
import { cn, plural } from '@/lib/utils';
import { useMonth, type Employee, type Entry, type Period, type PeriodSummary, type Rubric } from './data';
import { AccountantPayslipDocs } from './AccountantDocs';
import { WrongSpaceAlert, WrongSpaceNote, useSpaceGuard } from '@/components/WrongSpace';

interface ApplyResult {
  applied: Array<{ employee: string; net: string; total: string; created: boolean }>;
  skipped: Array<{ employee: string; reason: string }>;
  unchanged: number; createdEmployees: string[]; createdRubrics: string[];
}
/** Escolha de quem recebe o holerite: funcionário do cadastro, cadastro novo (normal ou só holerite) ou não lançar. */
type Link = { employeeId: string } | { create: 'normal' | 'ghost' } | null;
const NEW = '__new', GHOST = '__ghost';
const newRubricId = (key: string) => `new:${key}`;
/** "ATENDENTE DE FARMACIA - BALCON" → "Atendente de farmacia - balcon". */
const sentence = (v: string | null) => (v ? v.charAt(0).toUpperCase() + v.slice(1).toLowerCase() : null);

/**
 * Importar holerites: lê o PDF do contador e mostra, para cada holerite, o funcionário e o que muda
 * no mês. Só grava em "Lançar". Quem não está no cadastro pode entrar como "só holerite" (tem o
 * documento, mas não recebe pela empresa).
 */
export function PayslipsDialog({ open, onClose, periods, currentRef, employees, rubrics, costs, payslips, payMonth, canManage, onDone, docId }: {
  /** Documento da área do contador para ler no lugar de escolher um arquivo; ao lançar, ele fica como "lançado". */
  docId?: string | null;
  open: boolean; onClose: () => void; periods: PeriodSummary[]; currentRef: string; employees: Employee[]; rubrics: Rubric[];
  costs: PayrollCosts; payslips: PayrollPayslipsSettings; payMonth: 'same' | 'next'; canManage: boolean; onDone: (ref: string) => void;
}) {
  const qc = useQueryClient();
  const [ref, setRef] = useState(currentRef);
  const month = useMonth(ref);
  const period: Period | null = month.data?.period ?? null;
  const entries = month.data?.entries ?? [];
  const fileRef = useRef<HTMLInputElement>(null);
  /** Documento da área do contador que está sendo lido (veio pelo link "Importar na folha" ou foi escolhido aqui). */
  const [doc, setDoc] = useState<string | null>(docId ?? null);
  const [file, setFile] = useState<{ fileName: string; report: PayslipReport; spaceCheck?: SpaceCheck | null } | null>(null);
  const guard = useSpaceGuard(file?.spaceCheck);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [links, setLinks] = useState<Record<string, Link>>({});
  const [choice, setChoice] = useState<Record<string, string>>({});
  /** Líquido combinado de quem recebe um valor diferente do holerite ('' = vale o holerite). Sem chave = ainda não mexeu. */
  const [agreed, setAgreed] = useState<Record<string, string>>({});
  /** Cartões com o campo "valor combinado" aberto. */
  const [openAgreed, setOpenAgreed] = useState<Record<string, boolean>>({});
  const [adjust, setAdjust] = useState<{ earning: string; deduction: string }>({ earning: '', deduction: '' });
  useEffect(() => { if (open) { setDoc(docId ?? null); setFile(null); setLinks({}); setChoice({}); setAgreed({}); setOpenAgreed({}); setRef(currentRef); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);
  // veio da área do contador: lê o documento enviado assim que a janela abre (e os meses carregam)
  const autoLoaded = useRef<string | null>(null);
  useEffect(() => {
    if (!open) { autoLoaded.current = null; return; }
    if (docId && periods.length && autoLoaded.current !== docId) { autoLoaded.current = docId; void pick(null, docId); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, docId, periods.length]);
  const hasRef = (r: string) => periods.some((p) => p.ref === r);
  /**
   * Folha que recebe um holerite: o salário é pago no mês seguinte à competência. Se a folha do espaço
   * é contada pelo mês do pagamento (Configurar → pagamento "no próprio mês"), é a do mês seguinte;
   * se é contada pela competência (pagamento "no mês seguinte"), é a do mesmo mês.
   */
  const folhaOf = (competence: string) => (payMonth === 'same' ? addMonthsRef(competence, 1) : competence);
  const rmap = useMemo(() => new Map(rubrics.map((r) => [r.id, r])), [rubrics]);
  const empById = useMemo(() => new Map(employees.map((e) => [e.id, e])), [employees]);
  const extraOf = (kind: 'earning' | 'deduction') => rubrics.filter((r) => r.section === 'extra' && r.kind === kind && r.active);
  const adjustId = (kind: 'earning' | 'deduction') => adjust[kind] || extraOf(kind).find((r) => personKey(r.name) === (kind === 'earning' ? 'outros proventos' : 'outros descontos'))?.id || '';

  const pick = async (f: File | null, fromDoc: string | null = null) => {
    setReading(true); setDoc(fromDoc);
    try {
      const fd = new FormData(); if (f) fd.append('file', f);
      const r = f ? await api<{ fileName: string; report: PayslipReport; spaceCheck?: SpaceCheck | null }>('POST', '/api/payroll/payslips/read', fd)
        : await post<{ fileName: string; report: PayslipReport; spaceCheck?: SpaceCheck | null }>(`/api/accounting/documents/${fromDoc}/payslips`);
      setLinks({}); setChoice({}); setAgreed({}); setOpenAgreed({});
      setFile(r);
      const rr = r.report.ref ? folhaOf(r.report.ref) : null;
      setRef(rr && hasRef(rr) ? rr : hasRef(currentRef) ? currentRef : periods[0]?.ref ?? currentRef);
    } catch (e) { toast.error(errMsg(e)); } finally { setReading(false); if (fileRef.current) fileRef.current.value = ''; }
  };

  const slips = file?.report.slips ?? [];
  // ---- rubrica de cada linha do holerite
  const items = useMemo(() => {
    const m = new Map<string, PayslipItem>();
    for (const s of slips) for (const i of s.items) if (!m.has(i.key)) m.set(i.key, i);
    return [...m.values()];
  }, [slips]);
  const auto = (i: PayslipItem) => payslipRubricFor(i, rubrics, payslips.map)?.id ?? null;
  const rubricOf = (i: PayslipItem) => choice[i.key] ?? auto(i) ?? NEW;
  const rubricLabel = (i: PayslipItem) => { const v = rubricOf(i); return v === NEW ? payslipRubricName(i) : rmap.get(v)?.name ?? '—'; };
  const newRubrics = items.filter((i) => rubricOf(i) === NEW);
  const rubricLike = useMemo(() => [...rubrics, ...items.map((i) => ({ id: newRubricId(i.key), section: 'payslip', kind: i.kind, laborCharges: !isProLabore(payslipRubricName(i)) })),
    { id: 'adj:earning', section: 'extra', kind: 'earning' }, { id: 'adj:deduction', section: 'extra', kind: 'deduction' }], [rubrics, items]);

  // ---- funcionário de cada holerite
  const suggested = useMemo(() => {
    const m = new Map<string, { id: string; by: 'code' | 'name' }>();
    for (const s of slips) {
      const g = payslipEmployeeFor(s, employees.filter((e) => e.active || e.payslipCode === s.code));
      // ligar pelo nome grava a matrícula no cadastro: só para quem gerencia a folha
      if (g && (g.by === 'code' || canManage)) m.set(s.code, { id: g.employee.id, by: g.by });
    }
    // o mesmo funcionário sugerido pelo nome para dois holerites: nenhum dos dois
    for (const [code, g] of m) if (g.by === 'name' && [...m].some(([c, o]) => c !== code && o.id === g.id)) m.delete(code);
    return m;
  }, [slips, employees, canManage]);
  const linkOf = (s: Payslip): Link => (s.code in links ? links[s.code]! : suggested.has(s.code) ? { employeeId: suggested.get(s.code)!.id } : null);

  const rows = slips.map((s) => {
    const link = linkOf(s);
    const emp = link && 'employeeId' in link ? empById.get(link.employeeId) ?? null : null;
    const creating = link && 'create' in link ? link.create : null;
    const ghost = creating ? creating === 'ghost' : !!emp?.payslipOnly;
    const entry = emp ? entries.find((e) => e.employeeId === emp.id) ?? null : null;
    const paid = entry?.bill?.status === 'paid';
    const slipLines = s.items.map((i) => { const v = rubricOf(i); return { rubricId: v === NEW ? newRubricId(i.key) : v, amount: i.amount }; });
    const others = (entry?.lines ?? []).filter((l) => rmap.get(l.rubricId)?.section !== 'payslip');
    // diferença "combinado × holerite" que já está no lançamento (linha por fora com a nota)
    const prior = others.filter((l) => l.note === PAYSLIP_ADJUST_NOTE).reduce((a, l) => a + (rmap.get(l.rubricId)?.kind === 'deduction' ? -1 : 1) * toCents(l.amount), 0);
    const kept = others.filter((l) => l.note !== PAYSLIP_ADJUST_NOTE);
    const typed = entry && !entry.lines.some((l) => rmap.get(l.rubricId)?.section === 'payslip') ? toCents(entry.payslipNet) : null;
    // líquido digitado à mão (sem detalhar) e diferente do holerite: a pessoa decide qual vale
    const decide = !ghost && !paid && typed !== null && typed !== 0 && typed !== toCents(s.net) && agreed[s.code] === undefined;
    const agreedVal = ghost ? '' : agreed[s.code] ?? (prior ? fromCents(toCents(s.net) + prior) : '');
    const diff = agreedVal && toCents(agreedVal) > 0 ? toCents(agreedVal) - toCents(s.net) : 0;
    const adj = diff ? [{ rubricId: diff > 0 ? 'adj:earning' : 'adj:deduction', amount: fromCents(Math.abs(diff)) }] : [];
    const tNew = payrollTotals('0', [...kept, ...slipLines, ...adj], rubricLike, costs, { payslipOnly: ghost });
    const tOld = entry ? payrollTotals(entry.payslipNet, entry.lines, rmap, costs, { payslipOnly: ghost }) : null;
    const byRubric = (ls: Array<{ rubricId: string; amount: string }>) => JSON.stringify([...ls.reduce((m, l) => m.set(l.rubricId, (m.get(l.rubricId) ?? 0) + toCents(l.amount)), new Map<string, number>())].sort());
    const same = !!entry && entry.payslipNetDeclared !== null && toCents(entry.payslipNetDeclared) === toCents(s.net)
      && byRubric(entry.lines.filter((l) => rmap.get(l.rubricId)?.section === 'payslip')) === byRubric(slipLines) && prior === diff;
    return { s, link, emp, creating, ghost, entry, paid, tNew, tOld, same, decide, typed, agreedVal, diff, ok: payslipOk(s), by: !(s.code in links) ? suggested.get(s.code)?.by ?? null : null };
  });
  const target = rows.filter((r) => (r.emp || r.creating) && r.ok);
  const toApply = target.filter((r) => !r.paid && !r.same);
  const undecided = toApply.filter((r) => r.decide);
  const keepers = toApply.filter((r) => r.diff !== 0);
  const needAdjust = (['earning', 'deduction'] as const).filter((k) => keepers.some((r) => (r.diff > 0) === (k === 'earning')));
  const adjustMissing = needAdjust.some((k) => !adjustId(k));
  const usedBy = (empId: string, code: string) => rows.some((r) => r.s.code !== code && r.emp?.id === empId);
  const nameTaken = (s: Payslip) => employees.some((e) => personKey(e.name) === personKey(s.name));
  const reportRef = file?.report.ref ?? null;
  const folhaRef = reportRef ? folhaOf(reportRef) : null;

  const run = async () => {
    if (!file || !period) return;
    setBusy(true);
    try {
      const used = new Map<string, PayslipItem>();
      for (const r of toApply) for (const i of r.s.items) used.set(i.key, i);
      const r = await post<ApplyResult>(`/api/payroll/periods/${period.id}/payslips`, {
        fileName: file.fileName,
        slips: toApply.map((r) => ({
          code: r.s.code, name: r.s.name, net: r.s.net,
          items: r.s.items.map((i) => ({ key: i.key, name: i.name.slice(0, 80), ref: i.ref, kind: i.kind, amount: i.amount })),
          ...(r.emp ? { employeeId: r.emp.id } : { create: { name: titleCaseName(r.s.name), role: sentence(r.s.role)?.slice(0, 64) ?? null, admissionDate: r.s.admissionDate, document: r.s.document, payslipOnly: r.creating === 'ghost' } }),
          agreedNet: r.ghost ? null : r.diff ? r.agreedVal : r.s.net,
        })),
        // só as escolhas que o servidor não faria sozinho (rubrica nova ou diferente da ligação salva/sugerida)
        rubrics: [...used.values()].flatMap((i): Array<{ key: string; createName?: string; rubricId?: string }> => {
          const v = rubricOf(i);
          if (v === NEW) return [{ key: i.key, createName: payslipRubricName(i) }];
          return v !== auto(i) ? [{ key: i.key, rubricId: v }] : [];
        }),
        adjustEarningId: adjustId('earning') || null, adjustDeductionId: adjustId('deduction') || null,
      });
      if (doc) await put(`/api/accounting/documents/${doc}`, { status: 'done' }).then(() => qc.invalidateQueries({ queryKey: ['accounting'] })).catch(() => undefined);
      qc.invalidateQueries({ queryKey: ['bills'] });
      toast.success(r.applied.length ? `Holerites lançados: ${plural(r.applied.length, 'funcionário', 'funcionários')}` : 'Nada mudou: os holerites já estavam lançados');
      if (r.createdEmployees.length) toast.info(`Cadastrado${r.createdEmployees.length > 1 ? 's' : ''}: ${r.createdEmployees.join(', ')}`);
      if (r.createdRubrics.length) toast.info(`Rubrica${r.createdRubrics.length > 1 ? 's criadas' : ' criada'}: ${r.createdRubrics.join(', ')}`);
      if (r.skipped.length) toast.warning(`Ficaram de fora: ${r.skipped.map((s) => `${s.employee} (${s.reason})`).join(', ')}`);
      onDone(period.ref);
      onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  /** Tira o "só holerite" do cadastro (a pessoa passa a ter valor a pagar e conta). */
  const unghost = async (e: Employee) => {
    try {
      await put(`/api/payroll/employees/${e.id}`, {
        name: e.name, document: e.document ?? '', role: e.role, admissionDate: e.admissionDate, terminationDate: e.terminationDate, active: e.active, pixKey: e.pixKey,
        phone: e.phone, sellerCode: e.sellerCode, payslipCode: e.payslipCode, bankInfo: e.bankInfo, bankCode: e.bankCode, bankBranch: e.bankBranch, bankAccount: e.bankAccount, bankAccountKind: e.bankAccountKind, notes: e.notes, payslipOnly: false,
      });
      await qc.invalidateQueries({ queryKey: ['bills'] });
      toast.success(`${e.name} agora recebe pela empresa`);
    } catch (err) { toast.error(errMsg(err)); }
  };
  const linkValue = (r: (typeof rows)[number]) => (r.emp ? r.emp.id : r.creating === 'ghost' ? GHOST : r.creating === 'normal' ? NEW : '');
  const setLink = (code: string, v: string) => setLinks({ ...links, [code]: v === '' ? null : v === NEW ? { create: 'normal' } : v === GHOST ? { create: 'ghost' } : { employeeId: v } });
  const blocked = guard.blocked || !period || !toApply.length || undecided.length > 0 || adjustMissing;

  return (
    <Dialog open={open} onClose={onClose} size="xl" title="Importar holerites"
      description="Envie o PDF dos holerites que o contador manda. Cada holerite entra detalhado no lançamento do funcionário (salário, INSS, descontos…) já conferido com o valor líquido. Metas, comissões e descontos por fora não mudam."
      footer={file && !guard.blocked ? <>
        <Button variant="ghost" className="mr-auto" onClick={() => setFile(null)}>Trocar arquivo</Button>
        <Button variant="ghost" onClick={onClose}>Fechar</Button>
        <Button variant="primary" loading={busy} disabled={blocked} onClick={run}>
          {undecided.length ? `Falta decidir ${plural(undecided.length, 'diferença', 'diferenças')}` : !toApply.length && target.length ? 'Tudo já lançado' : `Lançar ${plural(toApply.length, 'holerite', 'holerites')}`}
        </Button>
      </> : <Button variant="ghost" onClick={onClose}>Fechar</Button>}>
      <input ref={fileRef} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
      {!file ? (
        <div className="flex flex-col gap-4">
          {/* o que o contador já mandou pelo NoPaper: usa direto, sem baixar e subir de novo */}
          <AccountantPayslipDocs enabled={open && !docId} folhaRef={currentRef} payMonth={payMonth} busy={reading ? doc ?? 'x' : null} action="Usar este" onPick={(d) => pick(null, d.id)} />
          <button type="button" onClick={() => fileRef.current?.click()} disabled={reading}
            className="flex w-full flex-col items-center gap-3 rounded-xl border-2 border-dashed border-line px-6 py-10 text-center transition hover:border-accent hover:bg-accent-soft/30">
            {reading ? <Spinner className="size-6" /> : <span className="grid size-12 place-items-center rounded-2xl bg-accent-soft text-accent"><Upload className="size-5" /></span>}
            <span className="font-medium">{reading ? 'Lendo os holerites…' : 'Escolher o PDF dos holerites no computador'}</span>
            <span className="text-xs text-faint">Um arquivo com os holerites de todos do mês (as duas vias de cada um contam uma vez só).</span>
          </button>
        </div>
      ) : guard.blocked ? (
        <WrongSpaceAlert check={guard.check!} subject="Estes holerites" risk="os salários, descontos e o valor líquido destes holerites entram na folha deste espaço, por cima do que estiver lançado."
          onOtherFile={() => setFile(null)} onContinue={guard.accept} />
      ) : (
        <div className="flex flex-col gap-4">
          {guard.accepted && <WrongSpaceNote check={guard.check!} />}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg bg-surface-2/60 px-3.5 py-2.5 text-sm">
            <span className="inline-flex min-w-0 items-center gap-1.5"><FileText className="size-4 shrink-0 text-faint" /><span className="truncate">{file.fileName}</span></span>
            {file.report.company && <span className="min-w-0 truncate text-muted">{file.report.company}</span>}
            {reportRef && <span className="text-muted">Competência <b className="text-ink">{refLabelPT(reportRef)}</b></span>}
            <span className="text-muted">{plural(slips.length, 'holerite', 'holerites')}</span>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <span className="text-sm font-medium">Lançar na folha de</span>
            {periods.length ? (
              <Select aria-label="Mês da folha" className="h-9 w-auto min-w-40" value={hasRef(ref) ? ref : ''} onChange={(e) => setRef(e.target.value)}>
                {!hasRef(ref) && <option value="">Escolha o mês…</option>}
                {periods.map((p) => <option key={p.ref} value={p.ref}>{refLabelPT(p.ref)}</option>)}
              </Select>
            ) : <span className="text-sm text-warn">nenhum mês aberto</span>}
            {month.isFetching && <Spinner className="size-4" />}
          </div>
          {reportRef && folhaRef && folhaRef !== reportRef && folhaRef === ref && <p className="text-xs text-faint">Competência {refLabelPT(reportRef)}, paga no mês seguinte: entra na folha de {refLabelPT(folhaRef)}.</p>}
          {folhaRef && !hasRef(folhaRef) && <Warn>A folha de {refLabelPT(folhaRef)}{folhaRef !== reportRef ? ` (onde se paga a competência ${refLabelPT(reportRef!)})` : ' (competência dos holerites)'} ainda não foi aberta. Abra o mês na Folha de pagamento ou escolha outro mês acima.</Warn>}
          {reportRef && folhaRef && hasRef(folhaRef) && hasRef(ref) && folhaRef !== ref && <Warn>Os holerites são da competência {refLabelPT(reportRef)}, que entra na folha de {refLabelPT(folhaRef)}, e você escolheu a folha de {refLabelPT(ref)}. Confira se é o mês certo.</Warn>}
          {file.report.warnings.map((w) => <Warn key={w}>{w}</Warn>)}

          <details className="group rounded-xl border border-line" open={newRubrics.length > 0}>
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1 px-3.5 py-2.5 text-sm [&::-webkit-details-marker]:hidden">
              <span className="font-medium">Linhas do holerite → rubricas</span>
              <span className={cn('text-xs', newRubrics.length ? 'text-warn' : 'text-faint')}>
                {newRubrics.length ? `${plural(newRubrics.length, 'rubrica nova será criada', 'rubricas novas serão criadas')}: ${newRubrics.map(payslipRubricName).join(', ')}` : `${plural(items.length, 'linha reconhecida', 'linhas reconhecidas')}`}
              </span>
              <span className="ml-auto text-xs text-accent group-open:hidden">ver</span>
            </summary>
            <ul className="divide-y divide-line/60 border-t border-line px-3.5">
              {items.map((i) => (
                <li key={i.key} className="flex flex-col gap-1.5 py-2 sm:flex-row sm:items-center sm:gap-3">
                  <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                    {i.kind === 'deduction' ? <Minus className="size-3.5 shrink-0 text-danger" aria-label="desconto" /> : <Plus className="size-3.5 shrink-0 text-ok" aria-label="vencimento" />}
                    <span className="truncate">{i.name}</span>
                    {i.code && <span className="tnum shrink-0 text-xs text-faint">cód. {i.code}</span>}
                  </span>
                  <Select aria-label={`Rubrica de ${i.name}`} className="h-9 min-w-0 sm:w-64" disabled={!canManage} value={rubricOf(i)} onChange={(e) => setChoice({ ...choice, [i.key]: e.target.value })}>
                    {rubrics.filter((r) => r.section === 'payslip' && r.kind === i.kind).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                    <option value={NEW}>Criar a rubrica “{payslipRubricName(i)}”</option>
                  </Select>
                </li>
              ))}
            </ul>
            <p className="border-t border-line px-3.5 py-2 text-xs text-faint">A escolha fica salva e vale para os próximos meses.{!canManage && ' Só quem gerencia a folha pode mudar.'}</p>
          </details>

          {needAdjust.length > 0 && (
            <div className="flex flex-col gap-2 rounded-xl border border-line bg-surface-2/40 px-3.5 py-3 text-sm">
              <p className="text-muted">Para quem recebe um valor diferente do holerite, a diferença entra por fora em:</p>
              <div className="flex flex-wrap gap-2">
                {needAdjust.map((k) => (
                  <Select key={k} aria-label={k === 'earning' ? 'Rubrica do valor acima do holerite' : 'Rubrica do valor abaixo do holerite'} className="h-9 min-w-0 flex-1 sm:w-72 sm:flex-none" value={adjustId(k)} onChange={(e) => setAdjust({ ...adjust, [k]: e.target.value })}>
                    <option value="">{k === 'earning' ? 'Escolha o extra (paga acima do holerite)…' : 'Escolha o desconto (paga abaixo do holerite)…'}</option>
                    {extraOf(k).map((r) => <option key={r.id} value={r.id}>{k === 'earning' ? '+ ' : '− '}{r.name}</option>)}
                  </Select>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-3 lg:grid-cols-2">
            {rows.map((r) => (
              <div key={r.s.code} className={cn('flex min-w-0 flex-col rounded-xl border border-line bg-surface p-3.5 shadow-card', (!r.link || r.paid) && 'bg-surface-2/40')}>
                <div className="flex items-start gap-3">
                  <span className={cn('grid size-9 shrink-0 place-items-center rounded-full', r.ghost ? 'bg-surface-2 text-muted' : r.link ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-faint')}>
                    {r.ghost ? <Ghost className="size-4" /> : <UserRound className="size-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="font-medium leading-snug sm:truncate">{titleCaseName(r.s.name)}</p>
                    <p className="truncate text-xs text-faint">Matrícula {r.s.code} · {r.s.title}{r.s.role ? ` · ${sentence(r.s.role)}` : ''}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="font-display text-lg font-semibold tnum">{formatBRL(r.s.net)}</p>
                    <p className="text-xs text-faint">líquido</p>
                  </div>
                </div>

                <div className="mt-3 flex flex-col gap-1">
                  <Select aria-label={`Funcionário do holerite de ${r.s.name}`} className="h-9" disabled={!canManage} value={linkValue(r)} onChange={(e) => setLink(r.s.code, e.target.value)}>
                    <option value="">Não lançar este holerite</option>
                    <optgroup label="Funcionário do cadastro">
                      {employees.filter((e) => (e.active || e.id === r.emp?.id) && !usedBy(e.id, r.s.code)).map((e) => <option key={e.id} value={e.id}>{e.name}{e.payslipOnly ? ' (só holerite)' : ''}</option>)}
                    </optgroup>
                    {!nameTaken(r.s) && (
                      <optgroup label={`Cadastrar ${titleCaseName(r.s.name)}`}>
                        <option value={GHOST}>Só holerite (não recebe pela empresa)</option>
                        <option value={NEW}>Funcionário novo (recebe salário)</option>
                      </optgroup>
                    )}
                  </Select>
                  {r.by === 'name' && <p className="text-xs text-warn">Sugerido pelo nome — confira. A matrícula fica salva no cadastro ao lançar.</p>}
                  {!r.link && canManage && !nameTaken(r.s) && (
                    <div className="mt-1 flex flex-wrap gap-2">
                      <Button size="sm" variant="secondary" icon={<Ghost className="size-3.5" />} onClick={() => setLink(r.s.code, GHOST)}>Só holerite (não recebe)</Button>
                      <Button size="sm" variant="ghost" icon={<UserPlus className="size-3.5" />} onClick={() => setLink(r.s.code, NEW)}>Cadastrar funcionário</Button>
                    </div>
                  )}
                  {!r.link && !canManage && <p className="text-xs text-faint">Sem funcionário ligado. Peça a quem gerencia a folha para informar a matrícula {r.s.code} no cadastro.</p>}
                </div>

                <ul className="mt-3 flex flex-col gap-1 border-t border-line/70 pt-2.5 text-sm">
                  {r.s.items.map((i, n) => (
                    <li key={n} className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate">{rubricLabel(i)}{i.ref && <span className="text-xs text-faint"> · {i.ref}</span>}</span>
                      <span className={cn('tnum shrink-0', i.kind === 'deduction' && 'text-danger')}>{i.kind === 'deduction' ? '− ' : ''}{formatBRL(i.amount)}</span>
                    </li>
                  ))}
                </ul>

                {r.s.warnings.map((w) => <p key={w} className="mt-2 flex items-start gap-1.5 text-xs text-danger"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" />{w}</p>)}
                {r.link && r.ok && (
                  <div className="mt-2.5 text-xs">
                    {r.paid ? <span className="inline-flex items-center gap-1 text-warn"><Lock className="size-3.5" />Salário já pago: não muda (reverta o pagamento para lançar).</span>
                      : r.same ? <span className="inline-flex items-center gap-1 text-ok"><Check className="size-3.5" />Já está lançado com esses valores.</span>
                        : r.ghost ? <span className="text-muted">Só holerite: fica registrado no mês, sem valor a pagar, sem conta e sem custo para a empresa.</span>
                          : !r.tOld ? <span className="text-accent">Entra na folha do mês: a pagar {formatBRL(r.tNew.total)}.</span>
                            : r.decide ? null
                              : toCents(r.tOld.total) === toCents(r.tNew.total) ? <span className="text-muted">Passa a ter o holerite detalhado. A pagar continua {formatBRL(r.tNew.total)}.</span>
                                : <span className="text-warn">A pagar: {formatBRL(r.tOld.total)} → <b>{formatBRL(r.tNew.total)}</b>.</span>}
                  </div>
                )}
                {r.link && r.ok && r.decide && r.typed !== null && (
                  <div className="mt-2.5 flex flex-col gap-2 rounded-lg bg-warn/10 px-3 py-2.5 text-xs">
                    <p className="text-warn">
                      Na folha o líquido digitado é <b className="tnum">{formatBRL(r.typed / 100)}</b> e o holerite diz <b className="tnum">{formatBRL(r.s.net)}</b>. O que vale para o pagamento?
                    </p>
                    <div role="radiogroup" className="grid gap-1.5 sm:grid-cols-2">
                      {([['', 'Usar o holerite', r.s.net], [fromCents(r.typed), 'Manter o combinado', fromCents(r.typed)]] as const).map(([v, label, base]) => (
                        <button key={label} type="button" role="radio" aria-checked={false} onClick={() => { setAgreed({ ...agreed, [r.s.code]: v }); if (v) setOpenAgreed({ ...openAgreed, [r.s.code]: true }); }}
                          className="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-2 text-left text-[13px] text-muted transition-colors hover:border-accent hover:text-ink pointer-coarse:py-2.5">
                          <span className="font-medium">{label}</span><span className="tnum whitespace-nowrap">líquido {formatBRL(base)}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {r.link && r.ok && !r.ghost && !r.paid && !r.decide && (
                  openAgreed[r.s.code] || r.diff !== 0 ? (
                    <div className="mt-2.5 flex flex-col gap-1.5 rounded-lg bg-surface-2/60 px-3 py-2.5">
                      <div className="grid grid-cols-[1fr_140px] items-center gap-3">
                        <span className="min-w-0 text-sm">
                          <span className="font-medium">Líquido combinado</span>
                          <span className="block text-xs text-faint">O que a pessoa recebe no lugar do líquido do holerite. Vazio = vale o holerite.</span>
                        </span>
                        <MoneyInput aria-label={`Líquido combinado de ${r.s.name}`} value={r.agreedVal} onChange={(v) => setAgreed({ ...agreed, [r.s.code]: v })} />
                      </div>
                      {r.diff !== 0 && <p className="text-xs text-muted">Holerite {formatBRL(r.s.net)} {r.diff > 0 ? '+' : '−'} <b className="tnum text-ink">{formatBRL(Math.abs(r.diff) / 100)}</b> por fora ({r.diff > 0 ? 'extra' : 'desconto'}). A pagar: <b className="tnum text-ink">{formatBRL(r.tNew.total)}</b>.</p>}
                    </div>
                  ) : (
                    <button type="button" className="mt-2 self-start text-xs text-accent hover:underline pointer-coarse:py-1.5" onClick={() => setOpenAgreed({ ...openAgreed, [r.s.code]: true })}>Recebe um valor diferente do holerite?</button>
                  )
                )}
                {r.emp?.payslipOnly && canManage && !r.paid && (
                  <button type="button" className="mt-2 self-start text-xs text-accent hover:underline pointer-coarse:py-1.5" onClick={() => unghost(r.emp!)}>{r.emp.name} recebe pela empresa? Tirar o “só holerite”</button>
                )}
              </div>
            ))}
          </div>
          {rows.some((r) => r.creating === 'ghost' || (r.emp?.payslipOnly && !r.paid)) && (
            <p className="flex items-start gap-2 text-xs text-faint"><Ghost className="mt-0.5 size-3.5 shrink-0" />“Só holerite” é para quem tem holerite mas não recebe pela empresa (sócio que não trabalha, acordo…). Dá para mudar depois no cadastro do funcionário.</p>
          )}
        </div>
      )}
    </Dialog>
  );
}

function Warn({ children }: { children: React.ReactNode }) {
  return <p className="flex items-start gap-2 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn"><AlertTriangle className="mt-0.5 size-4 shrink-0" />{children}</p>;
}
