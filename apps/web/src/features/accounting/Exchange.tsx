import { LogoLoader } from '@/components/brand/Brand';
import { Fragment, useMemo, useRef, useState, type DragEvent } from 'react';
import { Navigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Check, CheckCheck, CircleCheck, Download, Eye, FileUp, Inbox, MoreHorizontal, Paperclip, Receipt, RotateCcw, Search, Trash2, Upload, X } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { ACCOUNTING_CLIENT_KINDS, ACCOUNTING_KIND_LABEL, MONTHS_PT, addMonthsRef, refLabelPT, todayISO, type AccountingKind } from '@nopaper/shared';
import { Button, Card, Empty, Input, PageHeader, Segmented, Select, Spinner } from '@/components/ui/base';
import { StatusChip } from '@/components/ui/chips';
import { useConfirm } from '@/components/ui/dialog';
import { api, get, put, errMsg, uploadFormWithProgress } from '@/lib/api';
import { useOrg } from '@/lib/session';
import { cn, isTouch, plural } from '@/lib/utils';
import { FileViewer, type FileViewerTarget } from '@/features/bills/FileViewer';
import { useAccountantOnly, useAccountants, useAccountingDocs, type AccountingDoc } from './data';
import { KIND_ICON, acceptFiles, canPreview, docTitle, fileAccept, norm, sentMonth, sizeText, when } from './common';

/**
 * Arquivos que o espaço manda para o contador (notas fiscais e outros). Dois lados da mesma lista:
 * `ClientOutbox` (quem envia: solta os arquivos e acompanha se o contador recebeu) e
 * `AccountantInboxPage` (o contador: caixa "Recebidos", com selo no menu enquanto houver algo não visto).
 */

/** Limite por arquivo no envio ao contador (igual ao padrão do servidor, ACCOUNTING_MAX_UPLOAD_MB). */
const MAX_MB = 200;

function useDocActions() {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['accounting'] });
  return { refresh };
}

/** Lista comum aos dois lados: busca, filtro por mês do envio, agrupada por mês. */
function DocList({ docs, loading, side, emptyTitle, emptyText, onView, actions }: {
  docs: AccountingDoc[]; loading: boolean; side: 'sender' | 'recipient'; emptyTitle: string; emptyText: string;
  onView: (d: AccountingDoc) => void; actions: (d: AccountingDoc) => React.ReactNode;
}) {
  const [q, setQ] = useState('');
  const [month, setMonth] = useState('');
  const months = useMemo(() => [...new Set(docs.map((d) => sentMonth(d.createdAt)))].sort().reverse(), [docs]);
  const list = useMemo(() => {
    const t = norm(q.trim());
    return docs.filter((d) => (!month || sentMonth(d.createdAt) === month) && (!t || norm(`${docTitle(d)} ${d.originalName} ${d.note ?? ''} ${d.uploadedByName ?? ''}`).includes(t)));
  }, [docs, q, month]);
  const filtered = !!q.trim() || !!month;
  const chip = (d: AccountingDoc) => (side === 'recipient'
    ? (d.status === 'new' ? <StatusChip status="today" label="Novo" /> : <StatusChip status="paid" label="Recebido" />)
    : d.hiddenAt && d.status === 'new' ? <StatusChip status="pending" label="Retirado pelo contador" />
      : d.status === 'new' ? <StatusChip status="today" label="Aguardando o contador" /> : <StatusChip status="paid" label="Recebido pelo contador" />);
  return (
    <>
      {docs.length > 0 && (
        <div className="grid gap-2 border-b border-line p-3 sm:grid-cols-[1fr_190px] sm:p-4 md:px-5">
          <div className="relative min-w-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
            <Input className="pl-9" placeholder="Buscar por nome do arquivo, tipo, observação…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <Select aria-label="Mês do envio" value={month} onChange={(e) => setMonth(e.target.value)}>
            <option value="">Qualquer mês</option>
            {months.map((m) => <option key={m} value={m}>Enviado em {refLabelPT(m)}</option>)}
          </Select>
        </div>
      )}
      {loading ? <div className="grid place-items-center py-16"><Spinner /></div> : !list.length ? (
        <Empty icon={<Inbox className="size-5" />} title={filtered ? 'Nada encontrado com esses filtros' : emptyTitle}
          action={filtered && <Button variant="secondary" onClick={() => { setQ(''); setMonth(''); }}>Limpar filtros</Button>}>{filtered ? null : emptyText}</Empty>
      ) : (
        <ul className="divide-y divide-line">
          {list.map((d, idx) => {
            const Icon = KIND_ICON[d.kind];
            const m = sentMonth(d.createdAt);
            const head = idx === 0 || sentMonth(list[idx - 1]!.createdAt) !== m;
            const fresh = d.status === 'new' && side === 'recipient';
            return (
              <Fragment key={d.id}>
                {head && (
                  <li className="flex items-baseline justify-between gap-3 bg-surface-2/50 px-3 py-2 text-xs sm:px-4 md:px-5">
                    <span className="font-medium text-muted">{MONTHS_PT[Number(m.slice(5)) - 1]} de {m.slice(0, 4)}</span>
                    <span className="text-faint">{plural(list.filter((x) => sentMonth(x.createdAt) === m).length, 'arquivo', 'arquivos')}</span>
                  </li>
                )}
                <li className="flex flex-col gap-3 p-3 sm:p-4 md:px-5 lg:flex-row lg:items-center">
                  <button type="button" onClick={() => onView(d)} className="flex min-w-0 flex-1 items-start gap-3 text-left">
                    <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl', fresh ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-faint')}><Icon className="size-5" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className={cn('font-medium', fresh && 'text-ink')}>{docTitle(d)}</span>{chip(d)}</span>
                      <span className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted"><Paperclip className="size-3 shrink-0 text-faint" /><span className="truncate">{d.originalName}</span><span className="shrink-0 text-faint">· {sizeText(d.size)}</span></span>
                      <span className="mt-0.5 block text-xs text-faint">{d.uploadedByName ? `${d.uploadedByName} · ` : ''}enviado em {when(d.createdAt)}{side === 'sender' && d.recipientName ? ` · para ${d.recipientName}` : ''}</span>
                      {d.note && <span className="mt-1.5 block rounded-lg bg-surface-2/60 px-2.5 py-1.5 text-xs text-muted">“{d.note}”</span>}
                      {side === 'sender' && d.status === 'done' && d.handledAt && <span className="mt-1.5 block text-xs text-faint">Recebido{d.handledByName ? ` por ${d.handledByName}` : ''} em {when(d.handledAt)}.</span>}
                      {side === 'sender' && d.hiddenAt && d.status === 'done' && <span className="mt-0.5 block text-xs text-faint">O contador já tirou da lista dele; o registro do envio continua aqui.</span>}
                    </span>
                  </button>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 max-lg:justify-start max-lg:pl-[52px]">{actions(d)}</div>
                </li>
              </Fragment>
            );
          })}
        </ul>
      )}
    </>
  );
}

function RowMenu({ items }: { items: Array<{ label: string; icon: typeof Check; on: () => void; danger?: boolean } | false> }) {
  const list = items.filter(Boolean) as Array<{ label: string; icon: typeof Check; on: () => void; danger?: boolean }>;
  if (!list.length) return null;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="grid size-8 pointer-coarse:size-10 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink" aria-label="Mais ações"><MoreHorizontal className="size-4" /></DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className="z-[6000] w-56 rounded-xl border border-line bg-raised p-1.5 shadow-2xl text-sm">
          {list.map((i) => (
            <DropdownMenu.Item key={i.label} onSelect={i.on} className={cn('flex items-center gap-2 rounded-lg px-2 py-2 outline-none data-[highlighted]:bg-surface-2 cursor-pointer', i.danger && 'text-danger')}>
              <i.icon className={cn('size-4', !i.danger && 'text-faint')} /> {i.label}
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

// ------------------------------------------------------------------ lado do espaço
/** Enviar ao contador: solte os arquivos, diga o que são e pronto. Abaixo, o que já foi enviado. */
export function ClientOutbox() {
  const docs = useAccountingDocs('to_accountant');
  const { refresh } = useDocActions();
  const confirm = useConfirm();
  const [viewer, setViewer] = useState<FileViewerTarget | null>(null);
  const thisMonth = todayISO().slice(0, 7);
  const [kind, setKind] = useState<AccountingKind>('invoice');
  const [competence, setCompetence] = useState(thisMonth);
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  // mais de um contador no espaço: quem envia escolhe para qual (cada um só vê o que é dele)
  const accountants = useAccountants(true).data ?? [];
  const [recipient, setRecipient] = useState('');
  const needRecipient = accountants.length > 1;
  /** Progresso do envio (0–100). */
  const [pct, setPct] = useState(0);
  const [sent, setSent] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const months = useMemo(() => Array.from({ length: 15 }, (_, i) => addMonthsRef(thisMonth, 1 - i)), [thisMonth]);
  const add = (list: FileList | File[] | null) => {
    const r = acceptFiles(list, files, true);
    if (r.rejected) toast.warning('Formato não aceito. Envie PDF, imagem, XML ou arquivo compactado (ZIP, RAR, 7z).');
    const big = r.files.filter((f) => f.size > MAX_MB * 1024 * 1024);
    if (big.length) toast.warning(`${big.map((f) => f.name).join(', ')}: maior que ${MAX_MB} MB, não dá para enviar.`);
    setFiles(r.files.filter((f) => !big.includes(f))); setSent(null);
  };
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); };
  const send = async () => {
    setBusy(true); setPct(0);
    try {
      // os campos vão antes dos arquivos (o servidor grava cada arquivo conforme chega)
      const build = () => { const fd = new FormData(); fd.append('kind', kind); fd.append('competence', competence); fd.append('note', note); if (needRecipient) fd.append('recipientId', recipient); for (const f of files) fd.append('file', f); return fd; };
      const r = await uploadFormWithProgress<{ created: number; storage?: { near: boolean } }>('/api/accounting/outbox', build, setPct);
      if (r.storage?.near) toast.warning('O espaço está perto do limite de armazenamento. Apague arquivos antigos ou peça ao administrador da plataforma para aumentar o limite.');
      setSent(`${plural(r.created, 'arquivo enviado', 'arquivos enviados')} ao contador às ${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}. Ele vê em “Recebidos”.`);
      setFiles([]); setNote('');
      refresh();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  const remove = async (d: AccountingDoc) => {
    const body = d.status === 'new' && !d.hiddenAt ? 'O contador ainda não viu: o arquivo é apagado e ele também deixa de ver.' : d.hiddenAt ? 'O arquivo sai desta lista e é apagado de vez (o contador já tinha tirado da lista dele).' : 'O arquivo sai desta lista. O contador já recebeu e continua com a cópia dele.';
    if (!(await confirm({ title: `Remover “${d.originalName}”?`, tone: 'danger', confirmLabel: 'Remover', body }))) return;
    try { await api('DELETE', `/api/accounting/documents/${d.id}`); refresh(); toast.success('Arquivo removido'); } catch (e) { toast.error(errMsg(e)); }
  };
  const download = async (d: AccountingDoc) => { try { const u = await get<{ downloadUrl: string }>(`/api/accounting/documents/${d.id}/url`); location.href = u.downloadUrl; } catch (e) { toast.error(errMsg(e)); } };
  // compactados e XML não abrem no navegador: o clique baixa
  const view = (d: AccountingDoc) => (canPreview(d.mime) ? setViewer({ urlPath: `/api/accounting/documents/${d.id}/url`, label: ACCOUNTING_KIND_LABEL[d.kind], title: d.originalName }) : void download(d));
  return (
    <>
      <Card className="p-3 sm:p-4 md:p-5">
        <h2 className="font-display text-lg font-semibold">Enviar ao contador</h2>
        <p className="mt-0.5 text-sm text-muted">Notas fiscais e outros arquivos. Ele recebe na hora, na área dele.</p>
        <input ref={inputRef} type="file" multiple accept={fileAccept(true)} className="hidden" onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
        <button type="button" onClick={() => inputRef.current?.click()} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
          className={cn('mt-4 flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition', over ? 'border-accent bg-accent-soft/40' : 'border-line hover:border-accent hover:bg-accent-soft/30')}>
          <span className="grid size-11 place-items-center rounded-2xl bg-accent-soft text-accent"><Upload className="size-5" /></span>
          <span className="font-medium">{isTouch() ? 'Toque para escolher os arquivos' : 'Arraste os arquivos aqui ou clique para escolher'}</span>
          <span className="text-xs text-faint">PDF, imagem, XML ou compactado (ZIP, RAR, 7z). Até {MAX_MB} MB por arquivo, 20 arquivos por envio.</span>
        </button>
        {sent && !files.length && <p className="mt-3 flex items-start gap-2 rounded-lg bg-ok/10 px-3 py-2.5 text-sm text-ok"><CircleCheck className="mt-0.5 size-4 shrink-0" />{sent}</p>}
        {files.length > 0 && (
          <div className="mt-4 flex flex-col gap-4">
            <ul className="divide-y divide-line/60 rounded-xl border border-line">
              {files.map((f, i) => (
                <li key={`${f.name}-${f.size}`} className="flex items-center gap-3 px-3 py-2">
                  <Receipt className="size-4 shrink-0 text-faint" />
                  <span className="min-w-0 flex-1 truncate text-sm">{f.name}</span>
                  <span className="shrink-0 text-xs text-faint tnum">{sizeText(f.size)}</span>
                  <button type="button" aria-label={`Tirar ${f.name}`} className="grid size-8 pointer-coarse:size-10 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink" onClick={() => setFiles(files.filter((_, j) => j !== i))}><X className="size-4" /></button>
                </li>
              ))}
            </ul>
            <div className="grid gap-3 sm:grid-cols-[auto_180px_1fr] sm:items-center">
              <Segmented className="max-sm:w-full" value={kind} onChange={setKind} options={ACCOUNTING_CLIENT_KINDS.map((k) => ({ value: k as AccountingKind, label: k === 'other' ? 'Outro' : ACCOUNTING_KIND_LABEL[k] }))} />
              <Select aria-label="Mês" value={competence} onChange={(e) => setCompetence(e.target.value)}>
                <option value="">Sem mês</option>
                {months.map((m) => <option key={m} value={m}>{refLabelPT(m)}</option>)}
              </Select>
              <Input aria-label="Observação" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Observação para o contador (opcional)" />
            </div>
            {needRecipient && (
              <label className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-muted">Para qual contador?</span>
                <Select aria-label="Contador" className="w-auto min-w-52" value={recipient} onChange={(e) => setRecipient(e.target.value)}>
                  <option value="">Escolha…</option>
                  {accountants.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  <option value="all">Todos os contadores</option>
                </Select>
              </label>
            )}
            {busy && (
              <div className="flex items-center gap-3">
                <LogoLoader size={72} progress={pct / 100} label="Progresso do envio" />
                <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} /></div>
                <span className="w-24 shrink-0 text-right text-xs text-muted tnum">{pct < 100 ? `enviando ${pct}%` : 'finalizando…'}</span>
              </div>
            )}
            <div className="flex justify-end"><Button variant="primary" className="max-sm:w-full" loading={busy} disabled={needRecipient && !recipient} icon={<FileUp className="size-4" />} onClick={send}>Enviar {files.length > 1 ? `${files.length} arquivos` : 'arquivo'} ao contador</Button></div>
          </div>
        )}
      </Card>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-baseline gap-3 border-b border-line p-3 sm:p-4 md:px-5">
          <h2 className="font-display text-lg font-semibold">Enviados ao contador</h2>
          {!!docs.data?.length && <span className="text-sm text-muted">{plural(docs.data.length, 'arquivo', 'arquivos')}</span>}
        </div>
        <DocList docs={docs.data ?? []} loading={docs.isLoading} side="sender" emptyTitle="Nada enviado ao contador ainda" emptyText="Solte as notas fiscais acima. O que você enviar fica registrado aqui, com a confirmação de quando ele recebeu." onView={view}
          actions={(d) => <>
            {canPreview(d.mime) ? <Button size="sm" variant="ghost" icon={<Eye className="size-4" />} onClick={() => view(d)}>Ver</Button>
              : <Button size="sm" variant="ghost" icon={<Download className="size-4" />} onClick={() => download(d)}>Baixar</Button>}
            <RowMenu items={[{ label: 'Remover', icon: Trash2, on: () => remove(d), danger: true }]} />
          </>} />
      </Card>
      <FileViewer target={viewer} onClose={() => setViewer(null)} />
    </>
  );
}

// ------------------------------------------------------------------ lado do contador
/** Caixa "Recebidos" do contador: o que o espaço mandou para ele. Abrir ou baixar marca como recebido. */
export function AccountantInboxPage() {
  const accountant = useAccountantOnly();
  const org = useOrg();
  const docs = useAccountingDocs('to_accountant', accountant);
  const { refresh } = useDocActions();
  const confirm = useConfirm();
  const [viewer, setViewer] = useState<FileViewerTarget | null>(null);
  if (!accountant) return <Navigate to="/contador" replace />;
  const all = docs.data ?? [];
  const fresh = all.filter((d) => d.status === 'new');
  const mark = async (d: AccountingDoc, status: 'new' | 'done', quiet = false) => {
    try { await put(`/api/accounting/documents/${d.id}`, { status }); refresh(); if (!quiet) toast.success(status === 'done' ? 'Marcado como recebido' : 'Voltou para não visto'); } catch (e) { if (!quiet) toast.error(errMsg(e)); }
  };
  const markAll = async () => {
    try { await Promise.all(fresh.map((d) => put(`/api/accounting/documents/${d.id}`, { status: 'done' }))); refresh(); toast.success(`${plural(fresh.length, 'arquivo marcado', 'arquivos marcados')} como recebido${fresh.length > 1 ? 's' : ''}`); } catch (e) { toast.error(errMsg(e)); refresh(); }
  };
  // abrir ou baixar já conta como recebido (o cliente vê a confirmação)
  const view = (d: AccountingDoc) => {
    // compactados e XML não abrem no navegador: o clique baixa
    if (!canPreview(d.mime)) return void download(d);
    setViewer({ urlPath: `/api/accounting/documents/${d.id}/url`, label: ACCOUNTING_KIND_LABEL[d.kind], title: d.originalName });
    if (d.status === 'new') void mark(d, 'done', true);
  };
  const download = async (d: AccountingDoc) => {
    try { const u = await get<{ downloadUrl: string }>(`/api/accounting/documents/${d.id}/url`); location.href = u.downloadUrl; if (d.status === 'new') void mark(d, 'done', true); } catch (e) { toast.error(errMsg(e)); }
  };
  const remove = async (d: AccountingDoc) => {
    if (!(await confirm({ title: `Tirar “${d.originalName}” da sua lista?`, tone: 'danger', confirmLabel: 'Tirar da lista', body: 'O arquivo sai dos seus recebidos. O cliente continua com o registro do envio.' }))) return;
    try { await api('DELETE', `/api/accounting/documents/${d.id}`); refresh(); toast.success('Arquivo tirado da lista'); } catch (e) { toast.error(errMsg(e)); }
  };
  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <PageHeader title="Recebidos" description={`Arquivos que ${org?.name ?? 'o cliente'} enviou para você: notas fiscais e outros documentos. Abrir ou baixar já avisa o cliente de que você recebeu.`}
        actions={fresh.length > 1 && <Button variant="secondary" icon={<CheckCheck className="size-4" />} onClick={markAll}>Marcar {fresh.length} como recebidos</Button>} />
      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-baseline gap-3 border-b border-line p-3 sm:p-4 md:px-5">
          <h2 className="font-display text-lg font-semibold">Do cliente</h2>
          {all.length > 0 && <span className="text-sm text-muted">{plural(all.length, 'arquivo', 'arquivos')}{fresh.length ? ` · ${fresh.length === 1 ? '1 novo' : `${fresh.length} novos`}` : ''}</span>}
        </div>
        <DocList docs={all} loading={docs.isLoading} side="recipient" emptyTitle="Nada recebido ainda" emptyText="Quando o cliente enviar notas fiscais ou outros arquivos, eles aparecem aqui, com um aviso no menu." onView={view}
          actions={(d) => <>
            <Button size="sm" variant={d.status === 'new' ? 'primary' : 'secondary'} icon={<Download className="size-4" />} onClick={() => download(d)}>Baixar</Button>
            {canPreview(d.mime) && <Button size="sm" variant="ghost" icon={<Eye className="size-4" />} onClick={() => view(d)}>Ver</Button>}
            <RowMenu items={[
              d.status === 'new' && { label: 'Marcar como recebido', icon: Check, on: () => mark(d, 'done') },
              d.status !== 'new' && { label: 'Marcar como não visto', icon: RotateCcw, on: () => mark(d, 'new') },
              { label: 'Tirar da minha lista', icon: Trash2, on: () => remove(d), danger: true },
            ]} />
          </>} />
      </Card>
      <FileViewer target={viewer} onClose={() => setViewer(null)} />
    </div>
  );
}
