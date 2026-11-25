import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertTriangle, BadgeCheck, LayoutGrid, List, CalendarClock, Download, FileBadge, FileCheck2, FileText, KeyRound, Plus, RefreshCw, RotateCcw, Search, Settings2, ShieldCheck, Trash2, Undo2, X,
} from 'lucide-react';
import {
  BR_STATES, NFE_PAYMENT_LABELS, formatBRL, formatDateBR, formatDocument, fromCents, nfeBillDescription, toCents, todayISO,
  type FiscalConfigView, type FiscalDocumentRow,
} from '@nopaper/shared';
import { Button, Card, Empty, Field, IconButton, Input, PageHeader, Segmented, Select, Spinner, Switch } from '@/components/ui/base';
import { Dialog, SaveFooter, useConfirm, useFormState } from '@/components/ui/dialog';
import { DatePicker } from '@/components/ui/date-picker';
import { MoneyInput } from '@/features/bills/MoneyInput';
import { api, del, errMsg, get, post, put } from '@/lib/api';
import { useCategories, useFolders } from '@/lib/queries';
import { useCan, useOrg, useSession } from '@/lib/session';
import { cn, plural } from '@/lib/utils';
import { useMedia } from '@/lib/useMedia';
import { useProgressive } from '@/lib/useProgressive';

type Config = FiscalConfigView & { orgDocument: string | null };
type Tab = 'new' | 'done' | 'dismissed' | 'other';
const TABS: Array<{ value: Tab; label: string }> = [
  { value: 'new', label: 'A lançar' }, { value: 'done', label: 'Lançadas' }, { value: 'dismissed', label: 'Dispensadas' }, { value: 'other', label: 'Outras' },
];

type View = 'cards' | 'list';
const VIEW_KEY = 'np:fiscal-view';
const readView = (): View => { try { return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'cards'; } catch { return 'cards'; } };

const fiscalKey = (orgId: string | null, ...rest: unknown[]) => ['fiscal', orgId, ...rest];
const dateTime = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—');
const hourLabel = (h: number) => `${String(h).padStart(2, '0')}:00`;

function useFiscalConfig() {
  const orgId = useSession((s) => s.orgId);
  return useQuery({ queryKey: fiscalKey(orgId, 'config'), queryFn: () => get<Config>('/api/fiscal/config') });
}

export function FiscalPage() {
  const can = useCan();
  const org = useOrg();
  const orgId = useSession((s) => s.orgId);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const cfgQ = useFiscalConfig();
  const [tab, setTab] = useState<Tab>('new');
  const [q, setQ] = useState('');
  const [setupOpen, setSetupOpen] = useState(false);
  const [launch, setLaunch] = useState<FiscalDocumentRow | null>(null);
  const [querying, setQuerying] = useState(false);
  const [view, setViewState] = useState<View>(readView);
  const setView = (v: View) => { setViewState(v); try { localStorage.setItem(VIEW_KEY, v); } catch { /* sem armazenamento */ } };
  const docsQ = useQuery({
    queryKey: fiscalKey(orgId, 'docs', tab, q),
    queryFn: () => get<{ items: FiscalDocumentRow[] }>(`/api/fiscal/documents?${tab === 'other' ? 'role=other' : `status=${tab}`}${q ? `&q=${encodeURIComponent(q)}` : ''}`).then((r) => r.items),
    placeholderData: (p) => p,
  });
  const manage = can('fiscal.manage');
  const cfg = cfgQ.data;

  if (org?.kind !== 'company') return <Card><Empty icon={<FileText className="size-5" />} title="Só em espaços do tipo Empresa">As notas fiscais da SEFAZ são consultadas pelo CNPJ da empresa.</Empty></Card>;
  if (cfgQ.isLoading || !cfg) return <div className="grid place-items-center py-24"><Spinner /></div>;

  const refresh = () => qc.invalidateQueries({ queryKey: fiscalKey(orgId) });
  const waitUntil = cfg.nextAllowedAt && new Date(cfg.nextAllowedAt).getTime() > Date.now() ? cfg.nextAllowedAt : null;

  async function queryNow() {
    const ok = await confirm({
      title: 'Consultar a SEFAZ agora?',
      body: <div className="space-y-2 text-sm text-muted">
        <p>A SEFAZ bloqueia por cerca de 1 hora o CNPJ que consulta mais de uma vez na mesma hora — e o bloqueio vale também para o sistema da farmácia (ERP).</p>
        <p>Depois desta consulta, a próxima (automática ou por este botão) só sai daqui a 2 horas. Se a SEFAZ recusar, a consulta automática se desliga sozinha.</p>
      </div>,
      confirmLabel: 'Consultar agora',
    });
    if (!ok) return;
    setQuerying(true);
    try {
      const r = await post<{ result: { status: string; message: string; notes: number; paused: boolean } }>('/api/fiscal/query');
      if (r.result.paused) toast.error(`A SEFAZ recusou: ${r.result.message}. A consulta automática foi desligada.`);
      else if (r.result.status === 'error') toast.error(`Não foi possível consultar: ${r.result.message}`);
      else toast.success(r.result.notes ? `${plural(r.result.notes, 'documento recebido', 'documentos recebidos')}` : 'Nenhuma nota nova na SEFAZ.');
      refresh();
    } catch (e) { toast.error(errMsg(e)); refresh(); } finally { setQuerying(false); }
  }

  async function setStatus(d: FiscalDocumentRow, status: FiscalDocumentRow['status']) {
    try { await put(`/api/fiscal/documents/${d.id}`, { status }); refresh(); } catch (e) { toast.error(errMsg(e)); }
  }
  async function downloadXml(d: FiscalDocumentRow) {
    try {
      const r = await api<Response>('GET', `/api/fiscal/documents/${d.id}/xml`, undefined, { raw: true });
      const url = URL.createObjectURL(await r.blob());
      const a = document.createElement('a');
      a.href = url; a.download = `NFe${d.key}.xml`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    } catch (e) { toast.error(errMsg(e)); }
  }

  const ready = !!cfg.certificate;
  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <PageHeader title="Notas fiscais"
        description="As NF-e emitidas contra o CNPJ da empresa chegam sozinhas da SEFAZ, uma vez por dia. Confira cada nota e lance as contas a pagar a partir das duplicatas."
        actions={<>
          {manage && ready && <Button variant="secondary" icon={<RefreshCw className="size-4" />} loading={querying} disabled={!!waitUntil} onClick={queryNow}>Consultar agora</Button>}
          {manage && <Button variant={ready ? 'ghost' : 'primary'} icon={<Settings2 className="size-4" />} onClick={() => setSetupOpen(true)}>{ready ? 'Configurar' : 'Configurar a consulta'}</Button>}
        </>} />

      <StatusStrip cfg={cfg} waitUntil={waitUntil} manage={manage} onSetup={() => setSetupOpen(true)} />

      {(ready || cfg.docCount > 0) && (
        <Card className="flex flex-col gap-4 p-4 sm:p-5">
          <div className="flex flex-wrap items-center gap-3">
            <div className="-mx-1 max-w-full overflow-x-auto px-1"><Segmented value={tab} onChange={setTab} options={TABS.map((t) => ({ ...t, label: t.value === 'new' && cfg.newCount ? `${t.label} (${cfg.newCount})` : t.label }))} /></div>
            <SearchField onChange={setQ} />
            <Segmented className="ml-auto" value={view} onChange={setView} options={[
              { value: 'cards', label: <span className="flex items-center gap-1.5" title="Cartões"><LayoutGrid className="size-4" /><span className="max-sm:sr-only">Cartões</span></span> },
              { value: 'list', label: <span className="flex items-center gap-1.5" title="Lista"><List className="size-4" /><span className="max-sm:sr-only">Lista</span></span> },
            ]} />
          </div>
          {cfg.startDate && cfg.olderCount > 0 && <p className="-mt-1 text-xs text-faint">{plural(cfg.olderCount, 'nota emitida', 'notas emitidas')} antes de {formatDateBR(cfg.startDate)} fora da lista (muda em Configurar → Notas a partir de).</p>}
          {docsQ.isLoading ? <div className="grid place-items-center py-16"><Spinner /></div>
            : !docsQ.data?.length ? (
              <Empty icon={<FileCheck2 className="size-5" />} title={tab === 'new' ? 'Nenhuma nota a lançar' : 'Nada por aqui'}>
                {tab === 'new' ? (cfg.lastQueryAt ? 'As notas novas aparecem aqui depois da consulta diária.' : 'A primeira consulta traz as notas dos últimos 90 dias.')
                  : tab === 'other' ? 'Notas em que a empresa aparece sem ser a destinatária (transporte, autorizada a baixar o XML…).' : 'Nenhuma nota nesta lista.'}
              </Empty>
            ) : (
              <DocList docs={docsQ.data} view={view} resetKey={`${tab}|${q}|${view}`} canLaunch={can('payable.create')}
                onLaunch={setLaunch} onStatus={setStatus} onXml={downloadXml} />
            )}
        </Card>
      )}

      {manage && <SetupDialog open={setupOpen} onClose={() => setSetupOpen(false)} cfg={cfg} isAdmin={!!org?.isAdmin} onSaved={refresh} />}
      <LaunchDialog doc={launch} defaults={cfg} onClose={() => setLaunch(null)} onDone={refresh} />
    </div>
  );
}

type DocActions = { canLaunch: boolean; onLaunch: (d: FiscalDocumentRow) => void; onStatus: (d: FiscalDocumentRow, s: FiscalDocumentRow['status']) => void; onXml: (d: FiscalDocumentRow) => void };

/** Cartões ou lista; montada aos poucos (centenas de notas no 1º dia). Ações com identidade fixa para as linhas com `memo`. */
function DocList({ docs, view, resetKey, ...actions }: { docs: FiscalDocumentRow[]; view: View; resetKey: string } & DocActions) {
  const wide = useMedia('(min-width: 1024px)');
  const ref = useRef(actions);
  ref.current = actions;
  const stable = useMemo<Omit<DocActions, 'canLaunch'>>(() => ({
    onLaunch: (d) => ref.current.onLaunch(d), onStatus: (d, s) => ref.current.onStatus(d, s), onXml: (d) => ref.current.onXml(d),
  }), []);
  const list = useProgressive(docs, resetKey, 40, 40);
  const total = useMemo(() => fromCents(docs.reduce((t, d) => t + (d.total ? toCents(d.total) : 0), 0)), [docs]);
  return (
    <div className="relative flex flex-col gap-2">
      <div className="text-xs text-faint">{plural(docs.length, 'nota', 'notas')} · {formatBRL(total)}</div>
      {view === 'cards' ? (
        <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
          {list.visible.map((d) => <DocCard key={d.id} d={d} canLaunch={actions.canLaunch} {...stable} />)}
        </div>
      ) : wide ? (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="bg-surface-2 text-left text-xs text-muted">
              <tr>
                <th className="px-3 py-2 font-medium">Emissão</th>
                <th className="px-3 py-2 font-medium">Fornecedor</th>
                <th className="px-3 py-2 font-medium">NF</th>
                <th className="px-3 py-2 font-medium">Duplicatas</th>
                <th className="px-3 py-2 font-medium">Pagamento</th>
                <th className="px-3 py-2 text-right font-medium">Total</th>
                <th className="px-3 py-2 text-right font-medium"><span className="sr-only">Ações</span></th>
              </tr>
            </thead>
            <tbody>
              {list.visible.map((d) => <DocTableRow key={d.id} d={d} canLaunch={actions.canLaunch} {...stable} />)}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="divide-y divide-line overflow-hidden rounded-xl border border-line">
          {list.visible.map((d) => <DocLine key={d.id} d={d} canLaunch={actions.canLaunch} {...stable} />)}
        </div>
      )}
      {list.sentinel}
    </div>
  );
}

const dupSummary = (d: FiscalDocumentRow) => (d.duplicates.length
  ? `${d.duplicates.length}× · 1ª ${formatDateBR(d.duplicates[0]?.dueDate)}`
  : d.kind === 'summary' ? 'Só o resumo' : 'Sem duplicata');
const payLabel = (d: FiscalDocumentRow) => d.paymentKinds.map((k) => NFE_PAYMENT_LABELS[k] ?? k).join(', ') || '—';

function SituationTag({ d }: { d: FiscalDocumentRow }) {
  if (d.situation !== 'authorized') return <span className="rounded-full bg-danger/15 px-1.5 py-0.5 text-[11px] font-medium text-danger">{d.situation === 'canceled' ? 'Cancelada' : 'Denegada'}</span>;
  if (d.status === 'done' && d.billIds.length) return <span className="rounded-full bg-ok/15 px-1.5 py-0.5 text-[11px] font-medium text-ok">{plural(d.billIds.length, 'conta', 'contas')}</span>;
  return null;
}

function RowActions({ d, canLaunch, onLaunch, onStatus, onXml }: { d: FiscalDocumentRow } & DocActions) {
  const canceled = d.situation !== 'authorized';
  return (
    <div className="flex items-center justify-end gap-1">
      {d.status === 'new' && !canceled && canLaunch && <Button size="sm" variant="primary" onClick={() => onLaunch(d)}>Lançar</Button>}
      {d.status === 'new' && !canceled && <IconButton label="Já lancei" onClick={() => onStatus(d, 'done')}><FileCheck2 className="size-4" /></IconButton>}
      {d.status === 'new' && <IconButton label="Dispensar" onClick={() => onStatus(d, 'dismissed')}><X className="size-4" /></IconButton>}
      {d.status !== 'new' && !(d.status === 'done' && d.billIds.length) && <IconButton label='Voltar para "a lançar"' onClick={() => onStatus(d, 'new')}><Undo2 className="size-4" /></IconButton>}
      <IconButton label="Baixar o XML" onClick={() => onXml(d)}><Download className="size-4" /></IconButton>
    </div>
  );
}

const DocTableRow = memo(function DocTableRow({ d, ...a }: { d: FiscalDocumentRow } & DocActions) {
  return (
    <tr className={cn('border-t border-line align-middle hover:bg-surface-2/60', d.situation !== 'authorized' && 'bg-danger/5')}>
      <td className="whitespace-nowrap px-3 py-2 tabular-nums">{formatDateBR(d.issuedAt)}</td>
      <td className="max-w-[28rem] px-3 py-2">
        <div className="flex items-center gap-2"><span className="truncate font-medium" title={d.emitterName ?? ''}>{d.emitterName ?? 'Fornecedor'}</span><SituationTag d={d} /></div>
        <div className="text-xs text-faint">{d.emitterDocument ? formatDocument(d.emitterDocument) : ''}</div>
      </td>
      <td className="whitespace-nowrap px-3 py-2 tabular-nums">{d.number ?? '—'}{d.series ? <span className="text-faint">-{d.series}</span> : null}</td>
      <td className="whitespace-nowrap px-3 py-2 text-muted">{dupSummary(d)}</td>
      <td className="max-w-[10rem] truncate px-3 py-2 text-muted" title={payLabel(d)}>{payLabel(d)}</td>
      <td className="whitespace-nowrap px-3 py-2 text-right font-medium tabular-nums">{d.total ? formatBRL(d.total) : '—'}</td>
      <td className="px-3 py-1.5"><RowActions d={d} {...a} /></td>
    </tr>
  );
});

const DocLine = memo(function DocLine({ d, ...a }: { d: FiscalDocumentRow } & DocActions) {
  return (
    <div className={cn('flex flex-col gap-1.5 bg-surface px-3 py-2.5', d.situation !== 'authorized' && 'bg-danger/5')}>
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2"><span className="truncate text-sm font-medium">{d.emitterName ?? 'Fornecedor'}</span><SituationTag d={d} /></div>
          <div className="truncate text-xs text-faint">{formatDateBR(d.issuedAt)}{d.number ? ` · NF ${d.number}` : ''} · {dupSummary(d)}</div>
        </div>
        <div className="text-sm font-semibold tabular-nums">{d.total ? formatBRL(d.total) : '—'}</div>
      </div>
      <RowActions d={d} {...a} />
    </div>
  );
});

function SearchField({ onChange }: { onChange: (v: string) => void }) {
  const [v, setV] = useState('');
  const t = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => { clearTimeout(t.current); t.current = setTimeout(() => onChange(v.trim()), 300); return () => clearTimeout(t.current); }, [v, onChange]);
  return (
    <div className="relative min-w-0 flex-1 sm:max-w-sm">
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
      <Input value={v} onChange={(e) => setV(e.target.value)} placeholder="Fornecedor, número, CNPJ ou chave" className="pl-9" aria-label="Buscar notas" />
    </div>
  );
}

function StatusStrip({ cfg, waitUntil, manage, onSetup }: { cfg: Config; waitUntil: string | null; manage: boolean; onSetup: () => void }) {
  if (!cfg.certificate && cfg.docCount > 0) {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-warn/40 bg-warn/10 p-3.5 text-sm">
        <KeyRound className="mt-0.5 size-4 shrink-0 text-warn" />
        <div className="min-w-0 flex-1">Sem certificado digital: as notas já recebidas continuam aqui, mas nenhuma nota nova chega da SEFAZ.</div>
        {manage && <Button size="sm" variant="secondary" onClick={onSetup}>Enviar certificado</Button>}
      </div>
    );
  }
  if (!cfg.certificate) {
    return (
      <Card className="p-5">
        <Empty icon={<KeyRound className="size-5" />} title="Consulta à SEFAZ ainda não configurada"
          action={manage && <Button variant="primary" icon={<Settings2 className="size-4" />} onClick={onSetup}>Configurar a consulta</Button>}>
          {manage ? 'Envie o certificado digital A1 (e-CNPJ) da empresa, escolha o horário e ligue a consulta. O certificado fica cifrado no servidor e nunca volta para a tela.'
            : 'Peça a um administrador do espaço para configurar a consulta com o certificado digital da empresa.'}
        </Empty>
      </Card>
    );
  }
  const exp = new Date(cfg.certificate.notAfter).getTime();
  const days = Math.ceil((exp - Date.now()) / 86_400_000);
  return (
    <div className="flex flex-col gap-2">
      {cfg.pausedAt && (
        <div className="flex items-start gap-3 rounded-xl border border-warn/40 bg-warn/10 p-3.5 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warn" />
          <div className="min-w-0 flex-1"><b>Consulta automática desligada em {dateTime(cfg.pausedAt)}.</b> {cfg.pausedReason}</div>
          {manage && <Button size="sm" variant="secondary" onClick={onSetup}>Religar</Button>}
        </div>
      )}
      {days <= 30 && (
        <div className="flex items-start gap-3 rounded-xl border border-danger/40 bg-danger/10 p-3.5 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" />
          <div>{days <= 0 ? 'O certificado digital venceu: a consulta parou.' : `O certificado digital vence em ${plural(days, 'dia', 'dias')} (${formatDateBR(cfg.certificate.notAfter.slice(0, 10))}).`} Renove com a certificadora e envie o arquivo novo.</div>
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-3">
        <Info icon={<ShieldCheck className="size-4" />} label="Consulta automática"
          value={cfg.enabled && !cfg.pausedAt ? `Ligada · todo dia às ${hourLabel(cfg.queryHour)}` : 'Desligada'} tone={cfg.enabled && !cfg.pausedAt ? 'ok' : 'muted'} />
        <Info icon={<CalendarClock className="size-4" />} label="Última consulta"
          value={cfg.lastQueryAt ? `${dateTime(cfg.lastQueryAt)}${cfg.lastStatus === 'error' ? ' · falhou' : ''}` : 'Ainda não consultou'}
          sub={cfg.lastStatus === 'error' ? cfg.lastMessage : waitUntil ? `Próxima possível depois de ${dateTime(waitUntil)}` : null} tone={cfg.lastStatus === 'error' ? 'warn' : 'muted'} />
        <Info icon={<BadgeCheck className="size-4" />} label="Certificado" value={cfg.certificate.subject.split(':')[0] ?? cfg.certificate.subject}
          sub={`Válido até ${formatDateBR(cfg.certificate.notAfter.slice(0, 10))}`} tone="muted" />
      </div>
    </div>
  );
}

function Info({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: string; sub?: string | null; tone: 'ok' | 'warn' | 'muted' }) {
  return (
    <Card className="flex min-w-0 items-start gap-3 p-3.5">
      <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg', tone === 'ok' ? 'bg-ok/15 text-ok' : tone === 'warn' ? 'bg-warn/15 text-warn' : 'bg-accent-soft text-accent')}>{icon}</span>
      <div className="min-w-0">
        <div className="text-xs text-faint">{label}</div>
        <div className="truncate text-sm font-medium">{value}</div>
        {sub && <div className="truncate text-xs text-muted" title={sub}>{sub}</div>}
      </div>
    </Card>
  );
}

const DocCard = memo(function DocCard({ d, canLaunch, onLaunch: launch, onStatus: status, onXml: xml }: { d: FiscalDocumentRow } & DocActions) {
  const onLaunch = () => launch(d);
  const onStatus = (s: FiscalDocumentRow['status']) => status(d, s);
  const onXml = () => xml(d);
  const canceled = d.situation !== 'authorized';
  const first = d.duplicates[0]?.dueDate;
  return (
    <div className={cn('flex min-w-0 flex-col gap-3 rounded-xl border bg-surface p-4 shadow-card', canceled ? 'border-danger/40' : 'border-line')}>
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent"><FileBadge className="size-5" /></span>
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 font-medium leading-snug">{d.emitterName ?? 'Fornecedor'}</div>
          <div className="truncate text-xs text-faint">{d.emitterDocument ? formatDocument(d.emitterDocument) : ''}{d.number ? ` · NF ${d.number}${d.series ? `-${d.series}` : ''}` : ''} · {formatDateBR(d.issuedAt)}</div>
        </div>
        <div className="text-right">
          <div className="font-display text-lg font-semibold tabular-nums">{d.total ? formatBRL(d.total) : '—'}</div>
        </div>
      </div>
      <div className="flex flex-wrap gap-1.5 text-xs">
        {canceled && <span className="rounded-full bg-danger/15 px-2 py-0.5 font-medium text-danger">{d.situation === 'canceled' ? 'Cancelada pelo fornecedor' : 'Denegada'}</span>}
        {d.kind === 'summary' && <span className="rounded-full bg-warn/15 px-2 py-0.5 text-warn" title="A SEFAZ só libera o XML completo depois da manifestação do destinatário (o sistema da farmácia costuma fazer).">Só o resumo · duplicatas ainda não liberadas</span>}
        {d.duplicates.length > 0 && <span className="rounded-full bg-surface-2 px-2 py-0.5 text-muted">{plural(d.duplicates.length, 'duplicata', 'duplicatas')} · 1ª em {formatDateBR(first)}</span>}
        {d.paymentKinds.map((k) => <span key={k} className="rounded-full bg-surface-2 px-2 py-0.5 text-muted">{NFE_PAYMENT_LABELS[k] ?? `Pagamento ${k}`}</span>)}
        {d.status === 'done' && d.billIds.length > 0 && (
          <Link to={`/pagar?situacao=&busca=${encodeURIComponent(d.number ? `NF ${d.number}` : d.key)}${first ? `&ano=${first.slice(0, 4)}&mes=${Number(first.slice(5, 7))}` : ''}`}
            className="rounded-full bg-ok/15 px-2 py-0.5 font-medium text-ok hover:underline">{plural(d.billIds.length, 'conta lançada', 'contas lançadas')}</Link>
        )}
      </div>
      {canceled && d.status === 'done' && <p className="text-xs text-danger">A nota foi cancelada depois de lançada: confira e apague as contas, se for o caso.</p>}
      <div className="mt-auto flex flex-wrap items-center gap-2">
        {d.status === 'new' && !canceled && canLaunch && <Button size="sm" variant="primary" icon={<Plus className="size-4" />} onClick={onLaunch}>Lançar contas</Button>}
        {d.status === 'new' && <Button size="sm" variant="ghost" icon={<X className="size-4" />} onClick={() => onStatus('dismissed')}>Dispensar</Button>}
        {d.status === 'new' && !canceled && <Button size="sm" variant="ghost" icon={<FileCheck2 className="size-4" />} onClick={() => onStatus('done')}>Já lancei</Button>}
        {d.status !== 'new' && !(d.status === 'done' && d.billIds.length) && <Button size="sm" variant="ghost" icon={<Undo2 className="size-4" />} onClick={() => onStatus('new')}>Voltar para "a lançar"</Button>}
        <span className="ml-auto" />
        <IconButton label="Baixar o XML" onClick={onXml}><Download className="size-4" /></IconButton>
      </div>
      {d.handledByName && d.status !== 'new' && <div className="-mt-1 text-xs text-faint">{d.status === 'done' ? 'Lançada' : 'Dispensada'} por {d.handledByName} em {dateTime(d.handledAt)}</div>}
    </div>
  );
});

// ------------------------------------------------------------------ configuração
interface SetupForm { enabled: boolean; queryHour: number; startDate: string; uf: string; categoryId: string; folderId: string }

function SetupDialog({ open, onClose, cfg, isAdmin, onSaved }: { open: boolean; onClose: () => void; cfg: Config; isAdmin: boolean; onSaved: () => void }) {
  const cats = (useCategories().data ?? []).filter((c) => c.kind !== 'receivable');
  const folders = useFolders().data ?? [];
  const confirm = useConfirm();
  const init = (): SetupForm => ({ enabled: cfg.enabled && !cfg.pausedAt, queryHour: cfg.queryHour, startDate: cfg.startDate ?? '', uf: cfg.uf ?? '', categoryId: cfg.categoryId ?? '', folderId: cfg.folderId ?? '' });
  const [f, setF, form] = useFormState<SetupForm>(init);
  const set = (patch: Partial<SetupForm>) => setF((p) => ({ ...p, ...patch }));
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) form.load(init()); }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    if (f.enabled && !cfg.enabled) {
      const ok = await confirm({
        title: 'Ligar a consulta automática?',
        body: <p className="text-sm text-muted">O NoPaper vai consultar a SEFAZ uma vez por dia, a partir das {hourLabel(f.queryHour)}. A primeira consulta traz as notas dos últimos 90 dias{f.startDate ? `; na lista entram só as emitidas a partir de ${formatDateBR(f.startDate)}` : ''}. Se a SEFAZ recusar por excesso de consultas, a consulta se desliga sozinha e os administradores recebem um aviso.</p>,
        confirmLabel: 'Ligar',
      });
      if (!ok) return;
    }
    setSaving(true);
    try {
      await put('/api/fiscal/config', { enabled: f.enabled, queryHour: f.queryHour, startDate: f.startDate || null, uf: f.uf, categoryId: f.categoryId || null, folderId: f.folderId || null });
      form.markSaved(f);
      onSaved();
      toast.success('Configuração salva');
    } catch (e) { toast.error(errMsg(e)); } finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onClose={onClose} size="lg" dirty={form.dirty} title="Notas fiscais da SEFAZ"
      description="Consulta das NF-e emitidas contra o CNPJ da empresa (distribuição DF-e do Ambiente Nacional)."
      footer={<SaveFooter dirty={form.dirty} saving={saving} onSave={save} onClose={onClose} canSave={!!f.uf && (!f.enabled || !!cfg.certificate)} />}>
      <div className="flex flex-col gap-5">
        <CertificateSection cfg={cfg} isAdmin={isAdmin} onChanged={onSaved} />
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Switch checked={f.enabled} disabled={!cfg.certificate} onChange={(v) => set({ enabled: v })} label="Consultar a SEFAZ todo dia"
              hint={cfg.certificate ? 'Uma consulta por dia, com 2 horas de folga entre consultas. Se a SEFAZ recusar, desliga sozinha.' : 'Envie o certificado primeiro.'} />
          </div>
          <Field label="Horário da consulta" hint="Depois do horário de compras: as notas do dia já estarão na SEFAZ.">
            <Select value={String(f.queryHour)} onChange={(e) => set({ queryHour: Number(e.target.value) })}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{hourLabel(h)}</option>)}
            </Select>
          </Field>
          <Field label="Notas a partir de" hint="As emitidas antes ficam guardadas, mas fora da lista. Dá para mudar depois.">
            <DatePicker value={f.startDate} onChange={(v) => set({ startDate: v })} clearable placeholder="Todas (últimos 90 dias)" aria-label="Notas a partir de" />
          </Field>
          <Field label="Estado (UF) da empresa" required>
            <Select value={f.uf} onChange={(e) => set({ uf: e.target.value })}>
              <option value="">Escolha</option>
              {BR_STATES.map((s) => <option key={s} value={s}>{s}</option>)}
            </Select>
          </Field>
          <Field label="Categoria padrão das contas" hint="Sugerida ao lançar; dá para trocar em cada nota.">
            <Select value={f.categoryId} onChange={(e) => set({ categoryId: e.target.value })}>
              <option value="">Nenhuma</option>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </Select>
          </Field>
          <Field label="Pasta padrão">
            <Select value={f.folderId} onChange={(e) => set({ folderId: e.target.value })}>
              <option value="">Nenhuma</option>
              {folders.map((x) => <option key={x.id} value={x.id}>{x.label} · {x.name}</option>)}
            </Select>
          </Field>
        </div>
        <p className="rounded-xl bg-surface-2 p-3 text-xs text-muted">
          O NoPaper só lê as notas: não envia manifestação (ciência, confirmação, desconhecimento) — isso continua com o sistema da empresa.
          Notas que a SEFAZ entrega só como resumo ganham o XML completo (com as duplicatas) depois que a empresa manifesta a ciência.
        </p>
      </div>
    </Dialog>
  );
}

function CertificateSection({ cfg, isAdmin, onChanged }: { cfg: Config; isAdmin: boolean; onChanged: () => void }) {
  const [replace, setReplace] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [certPassword, setCertPassword] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const c = cfg.certificate;
  const showForm = isAdmin && (!c || replace);

  async function upload() {
    if (!file) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('password', password);
      fd.append('certPassword', certPassword);
      fd.append('file', file);
      await api('POST', '/api/fiscal/certificate', fd);
      toast.success('Certificado conferido e guardado com segurança');
      setFile(null); setCertPassword(''); setPassword(''); setReplace(false);
      onChanged();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  }
  async function remove() {
    setBusy(true);
    try {
      await api('DELETE', '/api/fiscal/certificate', { password });
      toast.success('Certificado removido');
      setPassword(''); setRemoving(false);
      onChanged();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  }

  return (
    <div className="rounded-xl border border-line p-4">
      <div className="flex items-start gap-3">
        <span className={cn('grid size-9 shrink-0 place-items-center rounded-lg', c ? 'bg-ok/15 text-ok' : 'bg-accent-soft text-accent')}><KeyRound className="size-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="font-medium">Certificado digital A1 (e-CNPJ)</div>
          {c ? (
            <div className="mt-1 space-y-0.5 text-sm text-muted">
              <div className="break-words">{c.subject}</div>
              <div>Válido de {formatDateBR(c.notBefore.slice(0, 10))} até <b className="text-ink">{formatDateBR(c.notAfter.slice(0, 10))}</b></div>
              {c.uploadedByName && <div className="text-xs text-faint">Enviado por {c.uploadedByName} em {dateTime(c.uploadedAt)}</div>}
            </div>
          ) : <div className="mt-1 text-sm text-muted">Arquivo .pfx ou .p12 da empresa, com a senha. O CNPJ precisa ser o do espaço{cfg.orgDocument ? ` (${cfg.orgDocument})` : ''}.</div>}
        </div>
        {c && isAdmin && !replace && !removing && (
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" icon={<RotateCcw className="size-4" />} onClick={() => setReplace(true)}>Trocar</Button>
            <IconButton label="Remover o certificado" tone="danger" onClick={() => setRemoving(true)}><Trash2 className="size-4" /></IconButton>
          </div>
        )}
      </div>
      {!isAdmin && !c && <p className="mt-3 text-sm text-warn">Só o administrador do espaço envia o certificado.</p>}
      {showForm && (
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <Field label="Arquivo do certificado" className="sm:col-span-2">
            <div className="flex min-w-0 items-center gap-3">
              <Button variant="secondary" icon={<FileBadge className="size-4" />} onClick={() => fileRef.current?.click()}>{file ? 'Trocar arquivo' : 'Escolher arquivo'}</Button>
              <span className={cn('min-w-0 truncate text-sm', file ? 'text-ink' : 'text-faint')}>{file ? file.name : '.pfx ou .p12'}</span>
              <input ref={fileRef} type="file" accept=".pfx,.p12,application/x-pkcs12" className="hidden" onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ''; }} />
            </div>
          </Field>
          <Field label="Senha do certificado"><Input type="password" autoComplete="off" value={certPassword} onChange={(e) => setCertPassword(e.target.value)} /></Field>
          <Field label="Sua senha do NoPaper" hint="Confirma que é você."><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
            <p className="mr-auto text-xs text-muted">O arquivo e a senha ficam cifrados no servidor e nunca voltam para a tela; só o titular e a validade aparecem aqui.</p>
            {replace && <Button variant="ghost" onClick={() => setReplace(false)}>Cancelar</Button>}
            <Button variant="primary" loading={busy} disabled={!file || !certPassword || !password} onClick={upload}>{c ? 'Trocar o certificado' : 'Enviar o certificado'}</Button>
          </div>
        </div>
      )}
      {removing && (
        <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end">
          <Field label="Sua senha do NoPaper" hint="Remover desliga a consulta e apaga o certificado do servidor.">
            <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => { setRemoving(false); setPassword(''); }}>Cancelar</Button>
            <Button variant="danger" loading={busy} disabled={!password} onClick={remove}>Remover</Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ lançar
interface Part { dueDate: string; amount: string }

function LaunchDialog({ doc, defaults, onClose, onDone }: { doc: FiscalDocumentRow | null; defaults: Config; onClose: () => void; onDone: () => void }) {
  const cats = (useCategories().data ?? []).filter((c) => c.kind !== 'receivable');
  const folders = useFolders().data ?? [];
  const [description, setDescription] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [folderId, setFolderId] = useState('');
  const [parts, setParts] = useState<Part[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!doc) return;
    setDescription(nfeBillDescription(doc));
    setCategoryId(defaults.categoryId && cats.some((c) => c.id === defaults.categoryId) ? defaults.categoryId : '');
    setFolderId(defaults.folderId ?? '');
    setParts(doc.duplicates.length
      ? doc.duplicates.map((x) => ({ dueDate: x.dueDate ?? '', amount: x.amount }))
      : [{ dueDate: '', amount: doc.total ?? '' }]);
  }, [doc]); // eslint-disable-line react-hooks/exhaustive-deps

  const sum = useMemo(() => fromCents(parts.reduce((s, p) => s + (p.amount ? toCents(p.amount) : 0), 0)), [parts]);
  const diff = doc?.total ? toCents(doc.total) - toCents(sum) : 0;
  const valid = !!description.trim() && !!categoryId && parts.length > 0 && parts.every((p) => p.dueDate && p.amount && toCents(p.amount) > 0);
  const setPart = (i: number, patch: Partial<Part>) => setParts((ps) => ps.map((p, j) => (j === i ? { ...p, ...patch } : p)));

  async function submit() {
    if (!doc) return;
    setSaving(true);
    try {
      await post(`/api/fiscal/documents/${doc.id}/launch`, { description: description.trim(), categoryId, folderId: folderId || null, relatedPerson: doc.emitterName?.slice(0, 128) ?? null, installments: parts });
      toast.success(parts.length > 1 ? `${parts.length} parcelas lançadas em Contas a pagar` : 'Conta lançada em Contas a pagar');
      onDone(); onClose();
    } catch (e) { toast.error(errMsg(e)); } finally { setSaving(false); }
  }

  return (
    <Dialog open={!!doc} onClose={onClose} size="lg" title="Lançar contas da nota"
      description={doc ? `${doc.emitterName ?? 'Fornecedor'} · NF ${doc.number ?? '—'} · emitida em ${formatDateBR(doc.issuedAt)} · ${doc.total ? formatBRL(doc.total) : ''}` : undefined}
      footer={<><Button variant="ghost" onClick={onClose}>Cancelar</Button><Button variant="primary" loading={saving} disabled={!valid} onClick={submit}>{parts.length > 1 ? `Lançar ${parts.length} parcelas` : 'Lançar conta'}</Button></>}>
      {doc && (
        <div className="flex flex-col gap-4">
          <Field label="Descrição" required><Input value={description} maxLength={255} onChange={(e) => setDescription(e.target.value)} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Categoria" required>
              <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                <option value="">Escolha</option>
                {cats.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </Select>
            </Field>
            <Field label="Pasta">
              <Select value={folderId} onChange={(e) => setFolderId(e.target.value)}>
                <option value="">Nenhuma</option>
                {folders.map((x) => <option key={x.id} value={x.id}>{x.label} · {x.name}</option>)}
              </Select>
            </Field>
          </div>
          <div>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium">{doc.duplicates.length ? 'Duplicatas da nota' : 'Parcelas'}</span>
              <Button size="sm" variant="ghost" icon={<Plus className="size-4" />} onClick={() => setParts((ps) => [...ps, { dueDate: '', amount: '' }])}>Parcela</Button>
            </div>
            {!doc.duplicates.length && <p className="mb-2 text-xs text-muted">{doc.kind === 'summary' ? 'Esta nota veio só como resumo: informe o vencimento.' : 'A nota não traz duplicatas: informe o vencimento.'}</p>}
            <div className="flex flex-col gap-2">
              {parts.map((p, i) => (
                <div key={i} className="grid grid-cols-[auto_1fr_1fr_auto] items-center gap-2">
                  <span className="w-6 text-right text-xs text-faint tabular-nums">{i + 1}</span>
                  <DatePicker value={p.dueDate} onChange={(v) => setPart(i, { dueDate: v })} min={undefined} aria-label={`Vencimento da parcela ${i + 1}`} />
                  <MoneyInput value={p.amount} onChange={(v) => setPart(i, { amount: v })} aria-label={`Valor da parcela ${i + 1}`} />
                  <IconButton label="Tirar parcela" disabled={parts.length === 1} onClick={() => setParts((ps) => ps.filter((_, j) => j !== i))}><X className="size-4" /></IconButton>
                </div>
              ))}
            </div>
            <div className={cn('mt-2 text-right text-sm', diff ? 'text-warn' : 'text-muted')}>
              Soma {formatBRL(sum)}{doc.total ? ` · nota ${formatBRL(doc.total)}` : ''}{diff ? ` · diferença ${formatBRL(fromCents(Math.abs(diff)))}` : ''}
            </div>
            {parts.some((p) => p.dueDate && p.dueDate < todayISO()) && <p className="mt-1 text-xs text-warn">Há parcela com vencimento no passado.</p>}
          </div>
        </div>
      )}
    </Dialog>
  );
}
