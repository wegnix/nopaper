import { useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, ChevronDown, FileSpreadsheet, RotateCcw, Upload } from 'lucide-react';
import {
  formatBRL, formatDateBR, guessPayrollStartYear, parsePayrollSheet, payrollTotals, personKey, refLabelPT, sumMoney, todayISO,
  type ImportSheet, type PayrollImportResult,
} from '@nopaper/shared';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { Button, Field, Input, Select, Spinner } from '@/components/ui/base';
import { api, get, post, errMsg } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn, plural } from '@/lib/utils';
import { payrollKey, type Rubric } from './data';

interface ImportRow { id: string; fileName: string; rowCount: number; createdAt: string; months: number; from: string | null; to: string | null }

export function ImportDialog({ open, onClose, rubrics, existingRefs, onDone }: { open: boolean; onClose: () => void; rubrics: Rubric[]; existingRefs: string[]; onDone: (lastRef: string) => void }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const orgId = useSession((s) => s.orgId);
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<{ fileName: string; sheets: ImportSheet[] } | null>(null);
  const [sheet, setSheet] = useState('');
  const [startYear, setStartYear] = useState(0);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const imports = useQuery({ enabled: open, queryKey: payrollKey(orgId, 'imports'), queryFn: () => get<{ items: ImportRow[] }>('/api/payroll/imports').then((r) => r.items) });

  const rows = file?.sheets.find((s) => s.name === sheet)?.rows ?? [];
  const result: PayrollImportResult | null = useMemo(() => (rows.length && startYear ? parsePayrollSheet(rows, startYear) : null), [rows, startYear]);
  const rubricByName = useMemo(() => new Map(rubrics.map((r) => [personKey(r.name), r])), [rubrics]);
  const totalOf = (e: PayrollImportResult['months'][number]['entries'][number]) =>
    payrollTotals(e.payslipNet, e.lines.map((l) => ({ rubricId: rubricByName.get(personKey(l.rubric))?.id ?? '', amount: l.amount })), rubrics).total;
  const missingRubrics = [...new Set((result?.months ?? []).flatMap((m) => m.entries.flatMap((e) => e.lines.map((l) => l.rubric))).filter((n) => !rubricByName.has(personKey(n))))];
  const taken = new Set(existingRefs);
  const toImport = (result?.months ?? []).filter((m) => !taken.has(m.ref));
  const people = new Set(toImport.flatMap((m) => m.entries.map((e) => personKey(e.name))));

  const pick = async (f: File) => {
    setReading(true);
    try {
      const fd = new FormData(); fd.append('file', f);
      const r = await api<{ fileName: string; sheets: ImportSheet[] }>('POST', '/api/import/read', fd);
      const s = r.sheets.find((x) => /folha/i.test(x.name)) ?? r.sheets[0];
      setFile(r); setSheet(s.name); setStartYear(guessPayrollStartYear(s.rows, todayISO()));
    } catch (e) { toast.error(errMsg(e)); } finally { setReading(false); if (fileRef.current) fileRef.current.value = ''; }
  };
  const run = async () => {
    if (!file || !toImport.length) return;
    setBusy(true);
    try {
      const body = { fileName: file.fileName, months: toImport.map((m) => ({ ref: m.ref, entries: m.entries.map((e) => ({ name: e.name, payslipNet: e.payslipNet, lines: e.lines, notes: e.notes })) })) };
      const r = await post<{ months: number; entries: number; createdEmployees: number }>('/api/payroll/import', body);
      qc.invalidateQueries({ queryKey: ['bills'] });
      toast.success(`${plural(r.months, 'mês importado', 'meses importados')} · ${plural(r.entries, 'lançamento', 'lançamentos')} · ${plural(r.createdEmployees, 'funcionário novo', 'funcionários novos')}`);
      const last = toImport.reduce((a, m) => (m.ref > a ? m.ref : a), '');
      setFile(null); onDone(last); onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const undo = async (b: ImportRow) => {
    const ok = await confirm({ title: `Desfazer a importação de "${b.fileName}"?`, tone: 'danger', confirmLabel: 'Desfazer',
      body: `Apaga os ${b.months} mês(es) importados (${b.from ? refLabelPT(b.from) : ''} a ${b.to ? refLabelPT(b.to) : ''}) e os funcionários criados por ela que não tenham outros meses.` });
    if (!ok) return;
    try { await api('DELETE', `/api/payroll/imports/${b.id}`); qc.invalidateQueries({ queryKey: ['bills'] }); toast.success('Importação desfeita'); } catch (e) { toast.error(errMsg(e)); }
  };
  const close = () => { setFile(null); onClose(); };

  return (
    <Dialog open={open} onClose={close} size="lg" title="Importar histórico da folha"
      description="Planilha com um bloco por mês (“Mês Agosto”, cabeçalho, funcionários, TOTAL). Os meses entram só como histórico: não geram contas a pagar."
      footer={file ? <>
        <Button variant="ghost" className="mr-auto" onClick={() => setFile(null)}>Trocar arquivo</Button>
        <Button variant="ghost" onClick={close}>Cancelar</Button>
        <Button variant="primary" loading={busy} disabled={!toImport.length || missingRubrics.length > 0} onClick={run}>Importar {plural(toImport.length, 'mês', 'meses')}</Button>
      </> : <Button variant="ghost" onClick={close}>Fechar</Button>}>
      <input ref={fileRef} type="file" accept=".xlsx" className="hidden" onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])} />
      {!file ? (
        <div className="flex flex-col gap-5">
          <button type="button" onClick={() => fileRef.current?.click()} disabled={reading}
            className="flex flex-col items-center gap-3 rounded-xl border-2 border-dashed border-line px-6 py-10 text-center transition hover:border-accent hover:bg-accent-soft/30">
            {reading ? <Spinner className="size-6" /> : <span className="grid size-12 place-items-center rounded-2xl bg-accent-soft text-accent"><Upload className="size-5" /></span>}
            <span className="font-medium">{reading ? 'Lendo a planilha…' : 'Escolher a planilha (.xlsx)'}</span>
            <span className="text-xs text-faint">Só a aba da folha é usada. Arquivo .xls antigo: salve como .xlsx antes.</span>
          </button>
          {!!imports.data?.length && (
            <div>
              <h3 className="mb-2 text-sm font-medium text-muted">Importações anteriores</h3>
              <ul className="divide-y divide-line rounded-xl border border-line">
                {imports.data.map((b) => (
                  <li key={b.id} className="flex items-center gap-3 px-3 py-2.5">
                    <FileSpreadsheet className="size-4 shrink-0 text-faint" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm">{b.fileName}</span>
                      <span className="block text-xs text-faint">{formatDateBR(b.createdAt.slice(0, 10))} · {plural(b.months, 'mês', 'meses')}{b.from && b.to ? ` (${refLabelPT(b.from)} a ${refLabelPT(b.to)})` : ''}</span>
                    </span>
                    <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" />} onClick={() => undo(b)}>Desfazer</Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_160px]">
            <Field label="Aba">
              <Select value={sheet} onChange={(e) => { setSheet(e.target.value); setStartYear(guessPayrollStartYear(file.sheets.find((s) => s.name === e.target.value)?.rows ?? [], todayISO())); }}>
                {file.sheets.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
              </Select>
            </Field>
            <Field label="Ano do 1º mês" hint="O ano não está na planilha.">
              <Input type="number" min={2000} max={2100} value={startYear || ''} onChange={(e) => setStartYear(Number(e.target.value))} />
            </Field>
          </div>
          {!result?.months.length ? (
            <p className="rounded-lg bg-surface-2 px-3 py-6 text-center text-sm text-muted">Nenhum bloco “Mês …” encontrado nesta aba.</p>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Período" value={`${result.months[0].label} – ${result.months.at(-1)!.label}`} />
                <Stat label="Meses novos" value={String(toImport.length)} sub={result.months.length - toImport.length ? `${result.months.length - toImport.length} já existem` : undefined} />
                <Stat label="Funcionários" value={String(people.size)} />
                <Stat label="Total pago" value={formatBRL(sumMoney(toImport.flatMap((m) => m.entries.map(totalOf))))} />
              </div>
              {(result.warnings.length > 0 || missingRubrics.length > 0) && (
                <ul className="flex flex-col gap-1 rounded-lg bg-warn/10 px-3 py-2 text-sm text-warn">
                  {missingRubrics.map((n) => <li key={n} className="flex gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" /> Rubrica “{n}” não existe (foi apagada ou renomeada). Crie-a em Configurar → Rubricas.</li>)}
                  {result.warnings.map((w) => <li key={w} className="flex gap-2"><AlertTriangle className="mt-0.5 size-4 shrink-0" /> {w}</li>)}
                </ul>
              )}
              <ul className="max-h-[46dvh] divide-y divide-line overflow-y-auto rounded-xl border border-line">
                {[...result.months].reverse().map((m) => {
                  const skip = taken.has(m.ref);
                  const open = expanded === m.ref;
                  return (
                    <li key={m.ref} className={cn(skip && 'opacity-50')}>
                      <button type="button" onClick={() => setExpanded(open ? null : m.ref)} className="flex w-full items-center gap-3 px-3 py-2.5 text-left hover:bg-surface-2/50">
                        <span className="w-20 shrink-0 text-sm font-medium tnum">{m.label}</span>
                        <span className="min-w-0 flex-1 truncate text-xs text-muted">
                          {skip ? 'já está na folha — será pulado' : plural(m.entries.length, 'funcionário', 'funcionários')}
                          {m.warnings.length > 0 && <span className="text-warn"> · {plural(m.warnings.length, 'aviso', 'avisos')}</span>}
                        </span>
                        <span className="shrink-0 text-sm tnum">{formatBRL(sumMoney(m.entries.map(totalOf)))}</span>
                        <ChevronDown className={cn('size-4 shrink-0 text-faint transition-transform', open && 'rotate-180')} />
                      </button>
                      {open && (
                        <div className="bg-surface-2/40 px-3 pb-3 pt-1 text-xs">
                          {m.warnings.map((w) => <p key={w} className="text-warn">{w}</p>)}
                          <table className="mt-1 w-full">
                            <thead className="text-faint"><tr><th className="py-1 text-left font-normal">Funcionário</th><th className="text-right font-normal">Holerite</th><th className="text-right font-normal">A pagar</th></tr></thead>
                            <tbody>
                              {m.entries.map((e) => (
                                <tr key={e.name} className="border-t border-line/60 align-top">
                                  <td className="py-1 pr-2">{e.name}{e.notes && <span className="block whitespace-pre-line text-faint">{e.notes}</span>}{e.lines.filter((l) => l.note).map((l) => <span key={l.note} className="block text-faint">{l.note}</span>)}</td>
                                  <td className="py-1 text-right tnum">{formatBRL(e.payslipNet)}</td>
                                  <td className="py-1 text-right tnum">{formatBRL(totalOf(e))}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
              <p className="text-xs text-faint">O valor a pagar de cada pessoa fica igual ao “Salário a pagar” da planilha; quando a linha tem hora extra ou outra diferença somada à mão, ela entra como “Outros proventos/descontos” com a anotação. Hora extra paga à parte vai para as observações. Funcionários que não estão no último mês entram como desligados.</p>
            </>
          )}
        </div>
      )}
    </Dialog>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-line bg-surface-2/50 px-3 py-2">
      <p className="text-xs text-muted">{label}</p>
      <p className="truncate font-display font-semibold tnum">{value}</p>
      {sub && <p className="text-xs text-faint">{sub}</p>}
    </div>
  );
}
