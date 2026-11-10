import { Fragment, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Building2, Check, CircleCheck, CircleSlash, Eye, FileText, FileUp, Landmark, MoreHorizontal, Paperclip, Receipt, RotateCcw, Search, Trash2, Upload, UsersRound, Wallet, X,
} from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import {
  ACCOUNTING_KINDS, ACCOUNTING_KIND_HINT, ACCOUNTING_KIND_LABEL, ACCOUNTING_STATUS_LABEL, accountingBillDescription, accountingIsPayable, addMonthsRef,
  MONTHS_PT, formatBRL, formatDateBR, refLabelPT, todayISO, type AccountingKind, type AccountingStatus,
} from '@nopaper/shared';
import { Button, Card, Empty, Field, Input, PageHeader, Segmented, Select, Spinner } from '@/components/ui/base';
import { StatusChip } from '@/components/ui/chips';
import { useConfirm } from '@/components/ui/dialog';
import { api, get, put, errMsg } from '@/lib/api';
import { useCan, useOrg, useSession } from '@/lib/session';
import { cn, isTouch, plural } from '@/lib/utils';
import type { Bill } from '@/lib/types';
import { BillForm } from '@/features/bills/BillForm';
import { FileViewer, type FileViewerTarget } from '@/features/bills/FileViewer';
import { useAccountantOnly, useAccountingDocs, type AccountingDoc } from './data';

const KIND_ICON: Record<AccountingKind, typeof FileText> = {
  payslip: UsersRound, office_fee: Building2, das: Landmark, darf: Landmark, dae: Landmark, state_tax: Landmark, other: FileText,
};
const sizeText = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const when = (iso: string) => { const d = new Date(iso); return `${d.toLocaleDateString('pt-BR')} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`; };
/** Texto sem acento/maiúsculas, para a busca. */
const norm = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
/** Mês do envio (AAAA-MM, no horário de quem está vendo). */
const sentMonth = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
const docTitle = (d: AccountingDoc) => `${ACCOUNTING_KIND_LABEL[d.kind]}${d.competence ? ` – ${refLabelPT(d.competence)}` : ''}`;

/**
 * Área do contador. Quem tem "enviar" (o contador) manda os PDFs do mês e acompanha os próprios
 * envios; quem tem "conferir" vê tudo, lança a conta a pagar (com o arquivo já lido e anexado) ou
 * importa os holerites na folha.
 */
export function AccountingPage() {
  const can = useCan();
  const org = useOrg();
  const canUpload = can('accounting.upload'), canReview = can('accounting.review');
  const docs = useAccountingDocs();
  const qc = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();
  const accountant = useAccountantOnly();
  const user = useSession((s) => s.user);
  const [filter, setFilter] = useState<AccountingStatus | 'all'>('new');
  const [q, setQ] = useState('');
  const [kindFilter, setKindFilter] = useState<AccountingKind | ''>('');
  const [monthFilter, setMonthFilter] = useState('');
  const [viewer, setViewer] = useState<FileViewerTarget | null>(null);
  /** Conta a pagar sendo criada a partir de um documento. */
  const [billFor, setBillFor] = useState<{ doc: AccountingDoc; file: File } | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  /** Quem confere quase nunca envia: o envio fica recolhido atrás do botão. */
  const [showUpload, setShowUpload] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['accounting'] });

  const all = docs.data ?? [];
  const counts = { new: all.filter((d) => d.status === 'new').length, done: all.filter((d) => d.status === 'done').length, dismissed: all.filter((d) => d.status === 'dismissed').length };
  const sentMonths = useMemo(() => [...new Set(all.map((d) => sentMonth(d.createdAt)))].sort().reverse(), [all]);
  // quem só envia vê tudo o que enviou (o registro dele); quem confere filtra pela situação
  const list = useMemo(() => {
    const t = norm(q.trim());
    return all.filter((d) => (!canReview || filter === 'all' || d.status === filter)
      && (!kindFilter || d.kind === kindFilter) && (!monthFilter || sentMonth(d.createdAt) === monthFilter)
      && (!t || norm(`${docTitle(d)} ${d.originalName} ${d.note ?? ''} ${d.uploadedByName ?? ''} ${d.detected?.amount ?? ''}`).includes(t)));
  }, [all, q, kindFilter, monthFilter, filter, canReview]);
  const filtered = !!q.trim() || !!kindFilter || !!monthFilter;

  const handle = async (d: AccountingDoc, status: AccountingStatus, billId?: string) => {
    try { await put(`/api/accounting/documents/${d.id}`, { status, billId: billId ?? null }); refresh(); if (!billId) toast.success(status === 'done' ? 'Marcado como lançado' : status === 'dismissed' ? 'Documento dispensado' : 'Voltou para novos'); } catch (e) { toast.error(errMsg(e)); }
  };
  const remove = async (d: AccountingDoc) => {
    const ok = canReview
      ? await confirm({ title: `Tirar “${d.originalName}” da lista?`, tone: 'danger', confirmLabel: 'Tirar da lista', body: `O documento sai daqui${d.bill ? ' (a conta a pagar criada a partir dele continua)' : ''}. O contador continua vendo o envio no histórico dele — o registro do que ele mandou não é apagado.` })
      : await confirm({ title: `Remover “${d.originalName}”?`, tone: 'danger', confirmLabel: 'Remover', body: d.status === 'new' && !d.hiddenAt ? 'Ninguém conferiu ainda: o documento é apagado e o cliente também deixa de ver.' : d.hiddenAt ? 'O documento sai do seu histórico e é apagado de vez (o cliente já tinha tirado da lista dele).' : 'O documento sai do seu histórico. O cliente já conferiu e continua com a cópia dele.' });
    if (!ok) return;
    try { await api('DELETE', `/api/accounting/documents/${d.id}`); refresh(); toast.success(canReview ? 'Documento tirado da lista' : 'Documento removido'); } catch (e) { toast.error(errMsg(e)); }
  };
  /** Abre "Nova conta a pagar" com o arquivo do documento (valor, vencimento e código já lidos). */
  const launchBill = async (d: AccountingDoc) => {
    setOpening(d.id);
    try {
      const u = await get<{ url: string }>(`/api/accounting/documents/${d.id}/url`);
      const blob = await (await fetch(u.url)).blob();
      setBillFor({ doc: d, file: new File([blob], d.originalName, { type: d.mime }) });
    } catch (e) { toast.error(errMsg(e)); } finally { setOpening(null); }
  };
  const view = (d: AccountingDoc) => setViewer({ urlPath: `/api/accounting/documents/${d.id}/url`, label: ACCOUNTING_KIND_LABEL[d.kind], title: d.competence ? refLabelPT(d.competence) : d.originalName });

  const statusChip = (d: AccountingDoc) => (d.hiddenAt && d.status === 'new' ? <StatusChip status="pending" label="Retirado pelo cliente" /> : d.status === 'new' ? <StatusChip status="today" label={canReview ? 'Novo' : 'Aguardando conferência'} />
    : d.status === 'done' ? <StatusChip status="paid" label={canReview ? 'Lançado' : 'Conferido'} /> : <StatusChip status="pending" label="Dispensado" />);

  const primary = (d: AccountingDoc) => {
    if (!canReview || d.status !== 'new') return null;
    if (d.kind === 'payslip' && org?.kind === 'company' && can('payroll.edit')) {
      return <Button size="sm" variant="primary" icon={<UsersRound className="size-4" />} onClick={() => navigate(`/folha?holerite=${d.id}`)}>Importar na folha</Button>;
    }
    if (d.kind !== 'payslip' && can('payable.create')) {
      return <Button size="sm" variant={accountingIsPayable(d.kind) ? 'primary' : 'secondary'} loading={opening === d.id} icon={<Wallet className="size-4" />} onClick={() => launchBill(d)}>Lançar conta</Button>;
    }
    return <Button size="sm" variant="secondary" icon={<Check className="size-4" />} onClick={() => handle(d, 'done')}>Marcar como conferido</Button>;
  };
  const menu = (d: AccountingDoc) => {
    const items = [
      canReview && d.status === 'new' && { label: 'Marcar como lançado', icon: Check, on: () => handle(d, 'done') },
      canReview && d.status === 'new' && { label: 'Dispensar', icon: CircleSlash, on: () => handle(d, 'dismissed') },
      canReview && d.status !== 'new' && { label: 'Voltar para novos', icon: RotateCcw, on: () => handle(d, 'new') },
      canReview && { label: 'Tirar da lista', icon: Trash2, on: () => remove(d), danger: true },
      !canReview && d.mine && { label: 'Remover', icon: Trash2, on: () => remove(d), danger: true },
    ].filter(Boolean) as Array<{ label: string; icon: typeof Check; on: () => void; danger?: boolean }>;
    if (!items.length) return null;
    return (
      <DropdownMenu.Root>
        <DropdownMenu.Trigger className="grid size-8 pointer-coarse:size-10 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink" aria-label="Mais ações"><MoreHorizontal className="size-4" /></DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content align="end" sideOffset={4} className="z-[6000] w-52 rounded-xl border border-line bg-raised p-1.5 shadow-2xl text-sm">
            {items.map((i) => (
              <DropdownMenu.Item key={i.label} onSelect={i.on} className={cn('flex items-center gap-2 rounded-lg px-2 py-2 outline-none data-[highlighted]:bg-surface-2 cursor-pointer', i.danger && 'text-danger')}>
                <i.icon className={cn('size-4', !i.danger && 'text-faint')} /> {i.label}
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    );
  };

  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <PageHeader title={accountant ? `Olá, ${user?.name.split(' ')[0] ?? ''}` : 'Contador'}
        actions={canUpload && canReview && !showUpload && <Button variant="secondary" icon={<FileUp className="size-4" />} onClick={() => setShowUpload(true)}>Enviar documento</Button>}
        description={canReview
          ? 'Documentos que o contador envia: holerites, guias de impostos, a mensalidade do escritório e outros. Confira e lance cada um.'
          : `Envie por aqui os documentos de ${org?.name ?? 'seu cliente'}: holerites, guias de impostos, a mensalidade do escritório e outros PDFs. O responsável é avisado na hora, e tudo o que você enviar fica registrado no histórico abaixo.`} />

      {canUpload && (!canReview || showUpload) && <UploadCard company={org?.kind === 'company'} onSent={refresh} onClose={canReview ? () => setShowUpload(false) : undefined} />}

      <Card className="overflow-hidden">
        <div className="flex flex-col gap-3 border-b border-line p-3 sm:p-4 md:px-5">
          <div className="flex flex-wrap items-center gap-3">
            <h2 className="font-display text-lg font-semibold">{canReview ? 'Documentos recebidos' : 'Histórico de envios'}</h2>
            {!canReview && all.length > 0 && <span className="text-sm text-muted">{filtered ? `${list.length} de ${plural(all.length, 'envio', 'envios')}` : plural(all.length, 'envio', 'envios')}</span>}
            {canReview && (
              <Segmented className="sm:ml-auto max-sm:w-full" value={filter} onChange={setFilter} options={[
                { value: 'new', label: `Novos${counts.new ? ` (${counts.new})` : ''}` }, { value: 'done', label: 'Lançados' }, { value: 'dismissed', label: 'Dispensados' }, { value: 'all', label: 'Todos' },
              ]} />
            )}
          </div>
          {all.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-[1fr_200px_170px]">
              <div className="relative min-w-0">
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
                <Input className="pl-9" placeholder="Buscar por nome do arquivo, tipo, observação…" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <Select aria-label="Tipo" value={kindFilter} onChange={(e) => setKindFilter(e.target.value as AccountingKind | '')}>
                <option value="">Todos os tipos</option>
                {ACCOUNTING_KINDS.map((k) => <option key={k} value={k}>{ACCOUNTING_KIND_LABEL[k]}</option>)}
              </Select>
              <Select aria-label="Mês do envio" value={monthFilter} onChange={(e) => setMonthFilter(e.target.value)}>
                <option value="">Qualquer mês</option>
                {sentMonths.map((m) => <option key={m} value={m}>Enviado em {refLabelPT(m)}</option>)}
              </Select>
            </div>
          )}
        </div>
        {docs.isLoading ? <div className="grid place-items-center py-16"><Spinner /></div> : !list.length ? (
          <Empty icon={<FileUp className="size-5" />} title={filtered ? 'Nada encontrado com esses filtros' : canReview ? (filter === 'new' ? 'Nada novo para conferir' : 'Nenhum documento aqui') : 'Você ainda não enviou documentos'}
            action={filtered && <Button variant="secondary" onClick={() => { setQ(''); setKindFilter(''); setMonthFilter(''); }}>Limpar filtros</Button>}>
            {filtered ? null : canReview ? (all.length ? 'Os documentos já conferidos ficam nos outros filtros.' : 'Quando o contador enviar algo, aparece aqui e você é avisado.') : 'Escolha o tipo acima e envie os PDFs. Tudo o que você enviar fica guardado aqui.'}
          </Empty>
        ) : (
          <ul className="divide-y divide-line">
            {list.map((d, idx) => {
              const Icon = KIND_ICON[d.kind];
              const det = d.detected;
              // histórico de quem envia: separado pelo mês em que foi enviado
              const m = sentMonth(d.createdAt);
              const head = !canReview && (idx === 0 || sentMonth(list[idx - 1]!.createdAt) !== m);
              return (
                <Fragment key={d.id}>
                {head && (
                  <li className="flex items-baseline justify-between gap-3 bg-surface-2/50 px-3 py-2 text-xs sm:px-4 md:px-5">
                    <span className="font-medium text-muted">{MONTHS_PT[Number(m.slice(5)) - 1]} de {m.slice(0, 4)}</span>
                    <span className="text-faint">{plural(list.filter((x) => sentMonth(x.createdAt) === m).length, 'envio', 'envios')}</span>
                  </li>
                )}
                <li className="flex flex-col gap-3 p-3 sm:p-4 md:px-5 lg:flex-row lg:items-center">
                  <div className="flex min-w-0 flex-1 items-start gap-3">
                    <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl', d.status === 'new' ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-faint')}><Icon className="size-5" /></span>
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-x-2 gap-y-1"><span className="font-medium">{docTitle(d)}</span>{statusChip(d)}</p>
                      <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted"><Paperclip className="size-3 shrink-0 text-faint" /><span className="truncate">{d.originalName}</span><span className="shrink-0 text-faint">· {sizeText(d.size)}</span></p>
                      <p className="mt-0.5 text-xs text-faint">{canReview && d.uploadedByName ? `${d.uploadedByName} · ` : ''}enviado em {when(d.createdAt)}</p>
                      {(det?.amount || det?.dueDate || det?.slips) && (
                        <p className="mt-1.5 flex flex-wrap gap-1.5 text-xs">
                          {det.amount && <span className="rounded-md bg-surface-2 px-2 py-0.5 tnum">{formatBRL(det.amount)}</span>}
                          {det.dueDate && <span className={cn('rounded-md bg-surface-2 px-2 py-0.5 tnum', d.status === 'new' && det.dueDate < todayISO() && 'bg-danger/10 text-danger')}>vence {formatDateBR(det.dueDate)}</span>}
                          {det.slips ? <span className="rounded-md bg-surface-2 px-2 py-0.5">{plural(det.slips, 'holerite', 'holerites')}{det.slipsRef ? ` de ${refLabelPT(det.slipsRef)}` : ''}</span> : null}
                        </p>
                      )}
                      {d.note && <p className="mt-1.5 rounded-lg bg-surface-2/60 px-2.5 py-1.5 text-xs text-muted">“{d.note}”</p>}
                      {!canReview && d.hiddenAt && <p className="mt-1.5 text-xs text-faint">O cliente tirou este documento da lista dele em {when(d.hiddenAt)}. O seu registro do envio continua aqui.</p>}
                      {!canReview && d.status !== 'new' && d.handledAt && <p className="mt-1.5 text-xs text-faint">{d.status === 'done' ? 'Conferido' : 'Dispensado'} pelo cliente em {when(d.handledAt)}.</p>}
                      {d.status !== 'new' && canReview && (
                        <p className="mt-1.5 text-xs text-faint">
                          {ACCOUNTING_STATUS_LABEL[d.status]}{d.handledByName ? ` por ${d.handledByName}` : ''}{d.handledAt ? ` em ${when(d.handledAt)}` : ''}
                          {d.bill && <> · <Link className="text-accent hover:underline" to={`/pagar?ano=${d.bill.dueDate.slice(0, 4)}&mes=${Number(d.bill.dueDate.slice(5, 7))}&situacao=`}>{d.bill.description} ({formatBRL(d.bill.amount)}{d.bill.status === 'paid' ? ', paga' : ''})</Link></>}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 max-lg:pl-[52px] max-lg:justify-start">
                    {primary(d)}
                    <Button size="sm" variant="ghost" icon={<Eye className="size-4" />} onClick={() => view(d)}>Ver</Button>
                    {menu(d)}
                  </div>
                </li>
                </Fragment>
              );
            })}
          </ul>
        )}
      </Card>

      <FileViewer target={viewer} onClose={() => setViewer(null)} />
      <BillForm type="payable" bill={null} open={!!billFor} onClose={() => setBillFor(null)} onRestructure={() => undefined} onStopRecurrence={() => undefined} onView={() => undefined}
        seed={billFor ? { file: billFor.file, description: accountingBillDescription(billFor.doc.kind, billFor.doc.competence), notes: billFor.doc.note ?? '', slot: accountingIsPayable(billFor.doc.kind) ? 'boleto' : undefined } : null}
        onCreated={(b: Bill) => { if (billFor) void handle(billFor.doc, 'done', b.id); }} />
    </div>
  );
}

/** Envio: tipo → competência → arquivos (vários de uma vez). */
function UploadCard({ company, onSent, onClose }: { company: boolean; onSent: () => void; onClose?: () => void }) {
  const kinds = ACCOUNTING_KINDS.filter((k) => company || k !== 'payslip');
  const [kind, setKind] = useState<AccountingKind | null>(null);
  const thisMonth = todayISO().slice(0, 7);
  /** Padrão: o mês atual — o do envio/pagamento (holerites e guias chegam no mês em que são pagos). */
  const [competence, setCompetence] = useState(thisMonth);
  /** Último envio feito nesta tela (confirmação visível). */
  const [sent, setSent] = useState<{ n: number; label: string; at: string } | null>(null);
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const months = useMemo(() => Array.from({ length: 15 }, (_, i) => addMonthsRef(thisMonth, 1 - i)), [thisMonth]);
  const add = (list: FileList | File[] | null) => {
    const ok = [...(list ?? [])].filter((f) => /pdf|png|jpe?g|webp/i.test(f.type) || /\.(pdf|png|jpe?g|webp)$/i.test(f.name));
    if (ok.length < (list?.length ?? 0)) toast.warning('Só PDF (ou imagem PNG/JPG) é aceito.');
    setFiles((p) => [...p, ...ok.filter((f) => !p.some((x) => x.name === f.name && x.size === f.size))].slice(0, 20));
  };
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); };
  const send = async () => {
    if (!kind || !files.length) return;
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('kind', kind); fd.append('competence', competence); fd.append('note', note);
      for (const f of files) fd.append('file', f);
      const r = await api<{ created: number }>('POST', '/api/accounting/documents', fd);
      toast.success(`${plural(r.created, 'documento enviado', 'documentos enviados')}. O responsável foi avisado.`);
      setSent({ n: r.created, label: `${ACCOUNTING_KIND_LABEL[kind]}${competence ? ` – ${refLabelPT(competence)}` : ''}`, at: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) });
      setFiles([]); setNote(''); setKind(null);
      onSent();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };
  return (
    <Card className="p-3 sm:p-4 md:p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-display text-lg font-semibold">Enviar documentos</h2>
        {onClose && <button type="button" aria-label="Fechar o envio" className="grid size-8 pointer-coarse:size-10 shrink-0 place-items-center rounded-md text-muted hover:bg-surface-2 hover:text-ink" onClick={onClose}><X className="size-4" /></button>}
      </div>
      <p className="mt-0.5 text-sm text-muted">1. Escolha o tipo · 2. Confira o mês · 3. Adicione os arquivos.</p>
      {sent && !kind && (
        <p className="mt-3 flex items-start gap-2 rounded-lg bg-ok/10 px-3 py-2.5 text-sm text-ok">
          <CircleCheck className="mt-0.5 size-4 shrink-0" />
          <span>Enviado às {sent.at}: <b className="font-medium">{sent.label}</b> ({plural(sent.n, 'arquivo', 'arquivos')}). O responsável foi avisado e o envio já está no histórico abaixo.</span>
        </p>
      )}
      <div role="radiogroup" aria-label="Tipo do documento" className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-7">
        {kinds.map((k) => {
          const Icon = KIND_ICON[k], on = kind === k;
          return (
            <button key={k} type="button" role="radio" aria-checked={on} onClick={() => { setKind(k); setSent(null); }}
              className={cn('flex min-w-0 flex-col items-start gap-1.5 rounded-xl border p-3 text-left transition', on ? 'border-accent bg-accent-soft/50 shadow-card' : 'border-line hover:border-line-strong hover:bg-surface-2/50')}>
              <Icon className={cn('size-5', on ? 'text-accent' : 'text-faint')} />
              <span className="text-sm font-medium leading-tight">{ACCOUNTING_KIND_LABEL[k]}</span>
              <span className="text-xs leading-snug text-faint">{ACCOUNTING_KIND_HINT[k]}</span>
            </button>
          );
        })}
      </div>
      {kind && (
        <div className="mt-4 flex flex-col gap-4">
          <div className="grid gap-4 sm:grid-cols-[220px_1fr]">
            <Field label="Mês" hint="O mês em que o documento está sendo enviado e será pago — não a competência.">
              <Select value={competence} onChange={(e) => setCompetence(e.target.value)}>
                <option value="">Sem mês</option>
                {months.map((m) => <option key={m} value={m}>{refLabelPT(m)}</option>)}
              </Select>
            </Field>
            <Field label="Observação (opcional)"><Input maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: vence dia 20; guia recalculada…" /></Field>
          </div>
          <input ref={inputRef} type="file" multiple accept="application/pdf,.pdf,image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
          <button type="button" onClick={() => inputRef.current?.click()} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
            className={cn('flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition', over ? 'border-accent bg-accent-soft/40' : 'border-line hover:border-accent hover:bg-accent-soft/30')}>
            <span className="grid size-11 place-items-center rounded-2xl bg-accent-soft text-accent"><Upload className="size-5" /></span>
            <span className="font-medium">{isTouch() ? 'Toque para escolher os arquivos' : 'Arraste os arquivos aqui ou clique para escolher'}</span>
            <span className="text-xs text-faint">{kind === 'payslip' ? 'O PDF original do sistema de folha, com os holerites de todos.' : 'PDF de preferência (lemos valor, vencimento e código de barras). Até 20 arquivos por envio.'}</span>
          </button>
          {files.length > 0 && (
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
          )}
          <div className="flex flex-wrap items-center justify-end gap-3">
            <span className="mr-auto text-xs text-faint">{files.length ? `${ACCOUNTING_KIND_LABEL[kind]}${competence ? ` – ${refLabelPT(competence)}` : ''} · ${plural(files.length, 'arquivo', 'arquivos')}` : 'Nenhum arquivo escolhido ainda.'}</span>
            <Button variant="primary" className="max-sm:w-full" loading={busy} disabled={!files.length} icon={<FileUp className="size-4" />} onClick={send}>Enviar {files.length > 1 ? `${files.length} arquivos` : 'documento'}</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
