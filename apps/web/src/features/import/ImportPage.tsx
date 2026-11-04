import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { AnimatePresence, motion } from 'motion/react';
import { toast } from 'sonner';
import { AlertTriangle, CheckCircle2, ChevronLeft, FileSpreadsheet, Loader2, RotateCcw, Upload, X } from 'lucide-react';
import {
  IMPORT_FIELDS, IMPORT_FIELD_LABEL, IMPORT_REQUIRED, IMPORT_SKIP_LABEL, buildImportRows, dupKey, formatBRL, formatDateBR, fromCents,
  guessMapping, headersOf, normText, toCents, todayISO, MONTHS_PT_SHORT,
  type BillType, type ImportField, type ImportMapping, type ImportRow, type ImportSheet,
} from '@nopaper/shared';
import { Button, Card, Checkbox, Field, Input, PageHeader, Segmented, Select, Spinner, Switch } from '@/components/ui/base';
import { CategoryChip } from '@/components/ui/chips';
import { useConfirm } from '@/components/ui/dialog';
import { api, errMsg, get, post } from '@/lib/api';
import { useCategories, useFolders } from '@/lib/queries';
import { useCan, useSession } from '@/lib/session';
import { cn, isTouch, plural } from '@/lib/utils';

interface ReadResult { fileName: string; sheets: ImportSheet[] }
interface Batch { id: string; type: BillType; fileName: string; rowCount: number; totalAmount: string; createdAt: string; undoneAt: string | null; createdBy: string | null; remaining: number }

type View = 'categories' | 'preview';
type RowFilter = 'all' | 'warn' | 'skip' | 'dup';

export function ImportPage() {
  const can = useCan();
  const orgId = useSession((s) => s.orgId);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const { data: cats = [] } = useCategories();
  const { data: folders = [] } = useFolders();

  const [file, setFile] = useState<ReadResult | null>(null);
  const [reading, setReading] = useState(false);
  const [sp] = useSearchParams();
  const [type, setType] = useState<BillType>(sp.get('tipo') === 'receber' && can('receivable.create') ? 'receivable' : can('payable.create') ? 'payable' : 'receivable');
  const [sheetSel, setSheetSel] = useState<Record<string, boolean>>({});
  const [mapping, setMapping] = useState<ImportMapping>({});
  const [year, setYear] = useState(Number(todayISO().slice(0, 4)));
  const [fixYear, setFixYear] = useState(true);
  const [fallbackDay, setFallbackDay] = useState(10);
  const [folderId, setFolderId] = useState('');
  const [defaultCat, setDefaultCat] = useState('');
  const [catByDesc, setCatByDesc] = useState<Record<string, string>>({});
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [includeDups, setIncludeDups] = useState(false);
  const [view, setView] = useState<View>('categories');
  const [filter, setFilter] = useState<RowFilter>('all');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ created: number; total: string; type: BillType; year: number } | null>(null);

  const batches = useQuery({ queryKey: ['bills', orgId, 'import-batches'], queryFn: () => get<{ items: Batch[] }>('/api/import/batches').then((r) => r.items) });

  const readFile = async (f: File) => {
    setReading(true);
    try {
      const fd = new FormData(); fd.append('file', f);
      const r = await api<ReadResult>('POST', '/api/import/read', fd);
      const sel: Record<string, boolean> = {};
      let base: ImportMapping = {};
      for (const s of r.sheets) {
        const h = headersOf(s);
        const m = h.headerRow >= 0 ? guessMapping(h.headers) : {};
        sel[s.name] = IMPORT_REQUIRED.every((k) => m[k]);
        if (sel[s.name] && Object.keys(m).length > Object.keys(base).length) base = m;
      }
      setFile(r); setSheetSel(sel); setMapping(base); setCatByDesc({}); setExcluded(new Set()); setDone(null); setView('categories');
    } catch (e) { toast.error(errMsg(e)); } finally { setReading(false); }
  };

  const selected = useMemo(() => (file?.sheets ?? []).filter((s) => sheetSel[s.name]), [file, sheetSel]);
  const headerOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const s of selected) for (const h of headersOf(s).headers) if (h && !seen.has(normText(h))) seen.set(normText(h), h);
    return [...seen.entries()];
  }, [selected]);

  const rows = useMemo<ImportRow[]>(() => {
    if (!file) return [];
    const opts = { year, fixYear, fallbackDay, today: todayISO() };
    return selected.flatMap((s) => buildImportRows(s, mapping, opts)).filter((r) => r.skip !== 'empty');
  }, [file, selected, mapping, year, fixYear, fallbackDay]);
  const valid = useMemo(() => rows.filter((r) => !r.skip), [rows]);

  // duplicatas + sugestões de categoria pelo histórico
  const checkKey = useMemo(() => valid.map((r) => dupKey(r.description, r.dueDate!, r.amount!)).join('~'), [valid]);
  const check = useQuery({
    enabled: valid.length > 0, queryKey: ['bills', orgId, 'import-check', type, checkKey], staleTime: Infinity, placeholderData: (p) => p,
    queryFn: () => post<{ duplicates: number[]; suggestions: Record<string, string> }>('/api/import/check', {
      type, rows: valid.map((r) => ({ description: r.description, dueDate: r.dueDate, amount: r.amount })),
    }),
  });
  const dupSet = useMemo(() => {
    const s = new Set<string>();
    if (check.data && !check.isPlaceholderData) for (const i of check.data.duplicates) if (valid[i]) s.add(valid[i].key);
    return s;
  }, [check.data, check.isPlaceholderData, valid]);

  const usableCats = useMemo(() => cats.filter((c) => c.kind === 'both' || c.kind === type), [cats, type]);
  const catByLabel = useMemo(() => new Map(usableCats.map((c) => [normText(c.label), c.id])), [usableCats]);
  useEffect(() => { if (defaultCat && !usableCats.some((c) => c.id === defaultCat)) setDefaultCat(''); }, [usableCats, defaultCat]);

  const groups = useMemo(() => {
    const m = new Map<string, { key: string; label: string; count: number; cents: number; fromSheet: string | null }>();
    for (const r of valid) {
      const k = normText(r.description);
      const g = m.get(k) ?? { key: k, label: r.description, count: 0, cents: 0, fromSheet: null };
      g.count++; g.cents += toCents(r.amount!);
      if (r.categoryName && !g.fromSheet) g.fromSheet = catByLabel.get(normText(r.categoryName)) ?? null;
      m.set(k, g);
    }
    return [...m.values()].sort((a, b) => b.cents - a.cents);
  }, [valid, catByLabel]);

  const catFor = (descKey: string, sheetCat: string | null) =>
    catByDesc[descKey] || sheetCat || check.data?.suggestions[descKey] || defaultCat || '';
  const groupCat = (g: (typeof groups)[number]) => catFor(g.key, g.fromSheet);

  const toImport = valid.filter((r) => !excluded.has(r.key) && (includeDups || !dupSet.has(r.key)));
  const missingCat = groups.filter((g) => !groupCat(g)).length;
  const totalCents = toImport.reduce((a, r) => a + toCents(r.amount!), 0);
  const paidCount = toImport.filter((r) => r.paidAt).length;
  const warnCount = toImport.filter((r) => r.warnings.length).length;
  const mappingOk = IMPORT_REQUIRED.every((k) => mapping[k]);

  const commit = async () => {
    if (!file) return;
    setBusy(true);
    try {
      const groupOf = new Map(groups.map((g) => [g.key, groupCat(g)]));
      const res = await post<{ created: number; total: string }>('/api/import/bills', {
        type, fileName: file.fileName, folderId: folderId || null,
        rows: toImport.map((r) => ({
          description: r.description, categoryId: groupOf.get(normText(r.description)), dueDate: r.dueDate, amount: r.amount,
          paidAt: r.paidAt, paidAmount: r.paidAmount, paymentMethod: r.paymentMethod, notes: r.notes, relatedPerson: r.relatedPerson,
        })),
      });
      const years = toImport.map((r) => Number(r.dueDate!.slice(0, 4)));
      setDone({ ...res, type, year: years.sort((a, b) => years.filter((y) => y === b).length - years.filter((y) => y === a).length)[0] ?? year });
      setFile(null);
      qc.invalidateQueries({ queryKey: ['bills'] });
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  const undo = async (b: Batch) => {
    const ok = await confirm({
      title: `Desfazer a importação de "${b.fileName}"?`, tone: 'danger', confirmLabel: 'Desfazer importação',
      body: `${plural(b.remaining, 'conta será apagada', 'contas serão apagadas')}, inclusive as que já foram editadas ou pagas depois da importação, com seus anexos.`,
    });
    if (!ok) return;
    try { const r = await api<{ removed: number }>('DELETE', `/api/import/batches/${b.id}`); toast.success(`${plural(r.removed, 'conta removida', 'contas removidas')}`); qc.invalidateQueries({ queryKey: ['bills'] }); } catch (e) { toast.error(errMsg(e)); }
  };

  const shown = rows.filter((r) => filter === 'all' ? true : filter === 'warn' ? !r.skip && r.warnings.length : filter === 'skip' ? !!r.skip : dupSet.has(r.key));

  return (
    <div className="flex flex-col gap-6 pb-24">
      <div className="flex flex-col gap-2">
        <Link to={type === 'receivable' ? '/receber' : '/pagar'} className="inline-flex w-fit items-center gap-1 text-sm text-muted hover:text-ink"><ChevronLeft className="size-4" />{type === 'receivable' ? 'Contas a receber' : 'Contas a pagar'}</Link>
        <PageHeader title="Importar planilha" description="Traga suas contas de uma planilha .xlsx ou .csv. Nada é gravado antes de você conferir a prévia." />
      </div>

      <AnimatePresence mode="wait">
        {done && !file && (
          <motion.div key="done" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            <Card className="flex flex-wrap items-center gap-4 p-5">
              <CheckCircle2 className="size-8 text-ok" />
              <div className="flex-1">
                <p className="font-display text-lg font-semibold">{plural(done.created, 'conta importada', 'contas importadas')}</p>
                <p className="text-sm text-muted">Total de {formatBRL(done.total)}. Se algo saiu errado, desfaça a importação na lista abaixo.</p>
              </div>
              <Link to={`/${done.type === 'payable' ? 'pagar' : 'receber'}?ano=${done.year}`} className="text-sm font-medium text-accent hover:underline">Ver contas importadas</Link>
            </Card>
          </motion.div>
        )}
      </AnimatePresence>

      {!file ? (
        <>
          <DropZone busy={reading} onFile={readFile} />
          <PastImports batches={batches.data} loading={batches.isLoading} onUndo={undo} />
        </>
      ) : (
        <div className="grid gap-6 xl:grid-cols-[340px_1fr] items-start">
          {/* ---------------------------------------------------------- configuração */}
          <Card className="flex flex-col gap-5 p-5 xl:sticky xl:top-20">
            <div className="flex items-start gap-3">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent"><FileSpreadsheet className="size-5" /></span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{file.fileName}</p>
                <p className="text-xs text-muted">{plural(file.sheets.length, 'aba', 'abas')}</p>
              </div>
              <button className="text-muted hover:text-ink" onClick={() => setFile(null)} aria-label="Trocar arquivo"><X className="size-4" /></button>
            </div>

            {can('payable.create') && can('receivable.create') && (
              <Field label="Importar como">
                <Segmented value={type} onChange={setType} options={[{ value: 'payable', label: 'Contas a pagar' }, { value: 'receivable', label: 'Contas a receber' }]} />
              </Field>
            )}

            <Field label="Abas">
              <div className="flex flex-wrap gap-1.5">
                {file.sheets.map((s) => {
                  const on = !!sheetSel[s.name];
                  return (
                    <button key={s.name} onClick={() => setSheetSel({ ...sheetSel, [s.name]: !on })}
                      className={cn('rounded-lg border px-2.5 py-1 text-xs transition-colors', on ? 'border-accent bg-accent-soft text-accent' : 'border-line text-muted hover:text-ink')}>
                      {s.name}
                    </button>
                  );
                })}
              </div>
            </Field>

            <div className="grid grid-cols-2 gap-3">
              <Field label="Ano das abas" hint="Para abas com nome de mês">
                <Input type="number" min={2000} max={2100} value={year} onChange={(e) => setYear(Number(e.target.value) || year)} />
              </Field>
              <Field label="Dia padrão" hint="Quando não há data">
                <Select value={fallbackDay} onChange={(e) => setFallbackDay(Number(e.target.value))}>
                  {Array.from({ length: 31 }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
                </Select>
              </Field>
            </div>
            <Switch checked={fixYear} onChange={setFixYear} label="Corrigir ano digitado errado" hint="Ex.: 04/02/2025 na aba Fev de 2026 vira 04/02/2026" />

            <div className="flex flex-col gap-3 border-t border-line pt-4">
              <p className="text-sm font-medium">Colunas</p>
              {IMPORT_FIELDS.map((f: ImportField) => (
                <div key={f} className="grid grid-cols-[120px_1fr] items-center gap-2">
                  <label className="text-xs text-muted">{IMPORT_FIELD_LABEL[f]}{IMPORT_REQUIRED.includes(f) && <span className="text-danger"> *</span>}</label>
                  <Select value={mapping[f] ?? ''} onChange={(e) => setMapping({ ...mapping, [f]: e.target.value || undefined })} className="h-9 text-sm">
                    <option value="">— não usar —</option>
                    {headerOptions.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
                  </Select>
                </div>
              ))}
            </div>

            <Field label="Pasta (opcional)">
              <Select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
                <option value="">Sem pasta</option>
                {folders.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
              </Select>
            </Field>
          </Card>

          {/* ---------------------------------------------------------- categorias / prévia */}
          <div className="flex min-w-0 flex-col gap-4">
            {!mappingOk ? (
              <Card className="p-8 text-center text-sm text-muted">Escolha as colunas de <b>Descrição</b>, <b>Vencimento</b> e <b>Valor</b> para ver a prévia.</Card>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-3">
                  <Segmented value={view} onChange={setView} options={[
                    { value: 'categories', label: <span className="inline-flex items-center gap-1.5 whitespace-nowrap">Categorias {missingCat > 0 && <span className="rounded-full bg-warn/15 px-1.5 text-[11px] leading-4 text-warn">{missingCat}</span>}</span> },
                    { value: 'preview', label: `Prévia (${toImport.length})` },
                  ]} />
                  {check.isFetching && <Spinner className="size-4" />}
                </div>

                {view === 'categories' ? (
                  <Card className="overflow-hidden">
                    <div className="flex flex-wrap items-end gap-3 border-b border-line p-4">
                      <Field label="Categoria padrão" hint="Usada nas descrições que você não escolher" className="min-w-[240px] flex-1">
                        <Select value={defaultCat} onChange={(e) => setDefaultCat(e.target.value)}>
                          <option value="">Escolha…</option>
                          {usableCats.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                        </Select>
                      </Field>
                      <p className="pb-2 text-xs text-faint">{plural(groups.length, 'descrição diferente', 'descrições diferentes')}. As já usadas antes vêm com a categoria do histórico.</p>
                    </div>
                    <ul className="divide-y divide-line">
                      {groups.map((g) => {
                        const cid = groupCat(g);
                        return (
                          <li key={g.key} className="flex flex-wrap items-center gap-3 px-4 py-2.5">
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium">{g.label}</p>
                              <p className="text-xs text-faint">{plural(g.count, 'lançamento', 'lançamentos')} · {formatBRL(fromCents(g.cents))}</p>
                            </div>
                            <Select value={cid} onChange={(e) => setCatByDesc({ ...catByDesc, [g.key]: e.target.value })}
                              className={cn('h-9 w-56 text-sm', !cid && 'border-warn/60')}>
                              <option value="">Sem categoria</option>
                              {usableCats.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                            </Select>
                          </li>
                        );
                      })}
                    </ul>
                  </Card>
                ) : (
                  <Card className="overflow-hidden">
                    <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
                      {([['all', `Todas (${rows.length})`], ['warn', `Com aviso (${valid.filter((r) => r.warnings.length).length})`], ['skip', `Ignoradas (${rows.length - valid.length})`], ['dup', `Já existem (${dupSet.size})`]] as const).map(([k, l]) => (
                        <button key={k} onClick={() => setFilter(k)} className={cn('rounded-lg px-2.5 py-1 text-xs', filter === k ? 'bg-accent-soft text-accent' : 'text-muted hover:text-ink')}>{l}</button>
                      ))}
                      {dupSet.size > 0 && <span className="ml-auto"><Checkbox checked={includeDups} onChange={setIncludeDups} label="Importar mesmo as que já existem" /></span>}
                    </div>
                    <div className="max-h-[65vh] overflow-auto">
                      <table className="w-full text-sm">
                        <thead className="sticky top-0 z-10 bg-surface text-left text-xs text-muted">
                          <tr className="border-b border-line">
                            <th className="w-10 p-2" />
                            <th className="p-2 font-medium">Aba</th>
                            <th className="p-2 font-medium">Descrição</th>
                            <th className="p-2 font-medium">Vencimento</th>
                            <th className="p-2 text-right font-medium">Valor</th>
                            <th className="p-2 font-medium">Pagamento</th>
                            <th className="p-2 font-medium">Categoria</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-line">
                          {shown.map((r) => {
                            const dup = dupSet.has(r.key);
                            const off = !!r.skip || excluded.has(r.key) || (dup && !includeDups);
                            return (
                              <tr key={r.key} className={cn('align-top', off && 'opacity-45')}>
                                <td className="p-2">
                                  {!r.skip && <Checkbox checked={!off} disabled={dup && !includeDups} onChange={(v) => { const n = new Set(excluded); if (v) n.delete(r.key); else n.add(r.key); setExcluded(n); }} />}
                                </td>
                                <td className="whitespace-nowrap p-2 text-xs text-faint">{r.sheet} · {r.line}</td>
                                <td className="p-2">
                                  <p className="font-medium">{r.description || <span className="text-faint">—</span>}</p>
                                  {r.skip && <p className="text-xs text-faint">Ignorada: {IMPORT_SKIP_LABEL[r.skip]}</p>}
                                  {dup && <p className="text-xs text-faint">Já existe uma conta igual</p>}
                                  {r.warnings.map((w) => <p key={w} className="flex items-center gap-1 text-xs text-warn"><AlertTriangle className="size-3 shrink-0" />{w}</p>)}
                                </td>
                                <td className="whitespace-nowrap p-2 tnum">{r.dueDate ? formatDateBR(r.dueDate) : '—'}</td>
                                <td className="whitespace-nowrap p-2 text-right tnum">{r.amount ? formatBRL(r.amount) : '—'}</td>
                                <td className="whitespace-nowrap p-2 text-xs">
                                  {r.paidAt ? <span className="text-ok">Pago {formatDateBR(r.paidAt)}</span> : r.skip ? '' : <span className="text-muted">Pendente</span>}
                                  {r.paymentMethod && <p className="max-w-[160px] truncate text-faint">{r.paymentMethod}</p>}
                                </td>
                                <td className="p-2">{!r.skip && <CategoryChip category={cats.find((c) => c.id === catFor(normText(r.description), r.categoryName ? catByLabel.get(normText(r.categoryName)) ?? null : null))} />}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                      {!shown.length && <p className="py-12 text-center text-sm text-muted">Nada aqui.</p>}
                    </div>
                  </Card>
                )}
              </>
            )}
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------ barra de confirmação */}
      <AnimatePresence>
        {file && mappingOk && (
          <motion.div initial={{ y: 80, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 80, opacity: 0 }} transition={{ type: 'spring', damping: 26, stiffness: 300 }}
            className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-raised/95 backdrop-blur lg:left-[256px]">
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 md:px-5 lg:px-6">
              <Stat label="Contas" value={String(toImport.length)} />
              <Stat label="Total" value={formatBRL(fromCents(totalCents))} />
              <Stat label="Já pagas" value={String(paidCount)} />
              {warnCount > 0 && <Stat label="Com aviso" value={String(warnCount)} tone="warn" />}
              <div className="ml-auto flex items-center gap-3">
                {missingCat > 0 && <span className="text-xs text-warn">{plural(missingCat, 'descrição sem categoria', 'descrições sem categoria')}</span>}
                <Button variant="primary" disabled={!toImport.length || missingCat > 0 || busy || check.isFetching} onClick={commit} icon={busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}>
                  Importar {toImport.length} {toImport.length === 1 ? 'conta' : 'contas'}
                </Button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return <div><p className="text-[11px] text-faint">{label}</p><p className={cn('font-display font-semibold tnum', tone === 'warn' && 'text-warn')}>{value}</p></div>;
}

function DropZone({ onFile, busy }: { onFile: (f: File) => void; busy: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files?.[0]; if (f) onFile(f); };
  return (
    <button type="button" disabled={busy} onClick={() => ref.current?.click()}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
      className={cn('group flex flex-col items-center gap-4 rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-colors',
        over ? 'border-accent bg-accent-soft' : 'border-line hover:border-line-strong hover:bg-surface-2/50')}>
      <span className="grid size-14 place-items-center rounded-2xl bg-accent-soft text-accent transition-transform group-hover:-translate-y-0.5">
        {busy ? <Loader2 className="size-6 animate-spin" /> : <FileSpreadsheet className="size-6" />}
      </span>
      <div>
        <p className="font-display text-lg font-semibold">{busy ? 'Lendo a planilha…' : isTouch() ? 'Toque para escolher a planilha' : 'Arraste a planilha aqui ou clique para escolher'}</p>
        <p className="mt-1 text-sm text-muted">.xlsx ou .csv · uma aba por mês funciona bem (Jan, Fev, Mar…)</p>
      </div>
      <input ref={ref} type="file" hidden accept=".xlsx,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); e.target.value = ''; }} />
    </button>
  );
}

function PastImports({ batches, loading, onUndo }: { batches?: Batch[]; loading: boolean; onUndo: (b: Batch) => void }) {
  if (loading) return null;
  if (!batches?.length) return null;
  return (
    <Card className="overflow-hidden">
      <h2 className="border-b border-line px-5 py-3 font-display font-semibold">Importações anteriores</h2>
      <ul className="divide-y divide-line">
        {batches.map((b) => {
          const d = new Date(b.createdAt);
          return (
            <li key={b.id} className={cn('flex flex-wrap items-center gap-3 px-5 py-3', b.undoneAt && 'opacity-55')}>
              <FileSpreadsheet className="size-4 text-faint" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">{b.fileName}</p>
                <p className="text-xs text-faint">
                  {d.getDate()} {MONTHS_PT_SHORT[d.getMonth()]} {d.getFullYear()} · {b.createdBy ?? '—'} · {b.type === 'payable' ? 'a pagar' : 'a receber'} · {plural(b.rowCount, 'conta', 'contas')} · {formatBRL(b.totalAmount)}
                </p>
              </div>
              {b.undoneAt ? <span className="text-xs text-faint">Desfeita</span> : (
                <Button variant="ghost" size="sm" icon={<RotateCcw className="size-4" />} onClick={() => onUndo(b)}>Desfazer</Button>
              )}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

