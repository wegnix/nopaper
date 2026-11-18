import { LogoLoader } from '@/components/brand/Brand';
import { Fragment, useMemo, useRef, useState, type DragEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Building2, Check, CircleCheck, CircleSlash, Eye, FileText, FileUp, Landmark, MoreHorizontal, Paperclip, Receipt, RotateCcw, Search, Trash2, TriangleAlert, Upload, UsersRound, Wallet, X, Palmtree } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import {
  ACCOUNTING_GROUPS, ACCOUNTING_KINDS, ACCOUNTING_KIND_HINT, ACCOUNTING_KIND_LABEL, ACCOUNTING_STATUS_LABEL, accountingBillDescription, accountingCategoryFor, accountingIsPayable, accountingIsPayroll, accountingIsSlips, addMonthsRef,
  type AccountingGroupKey,
  MONTHS_PT, formatBRL, formatDateBR, refLabelPT, todayISO, type AccountingKind, type AccountingStatus,
} from '@nopaper/shared';
import { Button, Card, Empty, Field, Input, PageHeader, Segmented, Select, Spinner } from '@/components/ui/base';
import { StatusChip } from '@/components/ui/chips';
import { useConfirm } from '@/components/ui/dialog';
import { api, get, put, errMsg, uploadFormWithProgress } from '@/lib/api';
import { useCan, useOrg, useSession } from '@/lib/session';
import { cn, isTouch, plural } from '@/lib/utils';
import type { Bill } from '@/lib/types';
import { BillForm } from '@/features/bills/BillForm';
import { useCategories } from '@/lib/queries';
import { FileViewer, type FileViewerTarget } from '@/features/bills/FileViewer';
import { useAccountantOnly, useAccountingDocs, useIsAccountant, type AccountingDoc } from './data';
import { GROUP_ICON, KIND_ICON, docTitle, norm, sentMonth, sizeText, when } from './common';
import { useProgressive } from '@/lib/useProgressive';
import { ClientOutbox } from './Exchange';

/**
 * Área do contador. Quem tem "enviar" (o contador) manda os PDFs do mês e acompanha os próprios
 * envios; quem tem "conferir" vê tudo, lança a conta a pagar (com o arquivo já lido e anexado) ou
 * importa os holerites na folha.
 */
export function AccountingPage() {
  const can = useCan();
  const org = useOrg();
  const canUpload = can('accounting.upload'), canReview = can('accounting.review');
  // quem só envia ao contador (sem conferir) não tem a lista do que o contador mandou
  const docs = useAccountingDocs('to_client', canUpload || canReview);
  const qc = useQueryClient();
  const confirm = useConfirm();
  const navigate = useNavigate();
  // `accountant` = está do lado do contador (envia e acompanha os próprios envios); `only` = não vê mais nada do espaço
  const accountant = useIsAccountant();
  const only = useAccountantOnly();
  const user = useSession((s) => s.user);
  const [filter, setFilter] = useState<AccountingStatus | 'all'>('new');
  const [q, setQ] = useState('');
  const [kindFilter, setKindFilter] = useState<AccountingKind | ''>('');
  const [monthFilter, setMonthFilter] = useState('');
  const [viewer, setViewer] = useState<FileViewerTarget | null>(null);
  /** Conta a pagar sendo criada a partir de um documento. */
  const [billFor, setBillFor] = useState<{ doc: AccountingDoc; file: File; categoryId: string | null } | null>(null);
  const categories = useCategories();
  const [opening, setOpening] = useState<string | null>(null);
  const canSend = can('accounting.send') && !accountant;
  /** Lado do espaço: o que chegou do contador × o que foi enviado para ele. */
  const [box, setBox] = useState<'in' | 'out'>(canReview ? 'in' : 'out');
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
  // lista longa (anos de documentos): desenha os primeiros e completa conforme a pessoa rola
  const prog = useProgressive(list, `${filter}|${q}|${kindFilter}|${monthFilter}`);
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
      // categoria: a que foi usada nos últimos documentos do mesmo tipo/grupo, ou a que combina pelo nome
      const cats = (categories.data ?? []).filter((c) => c.kind !== 'receivable');
      const categoryId = accountingCategoryFor(d.kind, cats, all.filter((x) => x.bill).map((x) => ({ kind: x.kind, categoryId: x.bill!.categoryId })), cats[0]?.id);
      setBillFor({ doc: d, file: new File([blob], d.originalName, { type: d.mime }), categoryId });
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
    // recibos de 13º e de férias: só vão para a assinatura (importar na folha trocaria os valores do holerite do mês)
    if ((d.kind === 'thirteenth' || d.kind === 'vacation_slip') && org?.kind === 'company' && can('payroll.edit')) {
      return <Button size="sm" variant="primary" icon={<UsersRound className="size-4" />} onClick={() => navigate('/folha')} title="Na Folha, abra o mês e use o botão Assinaturas: este arquivo aparece em “Enviados pelo contador”.">Enviar para assinatura</Button>;
    }
    if (d.kind === 'vacation' && org?.kind === 'company' && can('payroll.edit')) {
      return <Button size="sm" variant="primary" icon={<Palmtree className="size-4" />} onClick={() => navigate(`/folha?aba=ferias&relatorio=${d.id}`)}>Abrir nas férias</Button>;
    }
    if (!accountingIsPayroll(d.kind) && can('payable.create')) {
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
      <PageHeader title={only ? `Olá, ${user?.name.split(' ')[0] ?? ''}` : 'Contador'}
        actions={canSend && box === 'in' && <Button variant="secondary" icon={<FileUp className="size-4" />} onClick={() => setBox('out')}>Enviar ao contador</Button>}
        description={!accountant && (!canReview || box === 'out') ? 'Envie notas fiscais e outros arquivos para o contador e acompanhe se ele já recebeu.' : canReview
          ? 'Documentos que o contador envia: holerites, guias de impostos, a mensalidade do escritório e outros. Confira e lance cada um.'
          : `Envie por aqui os documentos de ${org?.name ?? 'seu cliente'}: ${org?.kind === 'company' ? 'holerites, ' : ''}guias de impostos, a mensalidade do escritório e outros PDFs. O responsável é avisado na hora, e tudo o que você enviar fica registrado no histórico abaixo.`} />

      {accountant && <UploadCard company={org?.kind === 'company'} onSent={refresh} history={all} />}

      {canSend && canReview && (
        <Segmented className="self-start max-sm:self-stretch" value={box} onChange={setBox} options={[
          { value: 'in', label: `Recebidos do contador${counts.new ? ` (${counts.new})` : ''}` }, { value: 'out', label: 'Enviados ao contador' },
        ]} />
      )}
      {canSend && box === 'out' && <ClientOutbox />}

      {(accountant || (canReview && box === 'in')) && <Card className="overflow-hidden">
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
          <div className="relative">
          <ul className="divide-y divide-line">
            {prog.visible.map((d, idx) => {
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
                      {(det?.amount || det?.dueDate || det?.slips || det?.barcode || det?.pix) && (
                        <p className="mt-1.5 flex flex-wrap gap-1.5 text-xs">
                          {det.amount && <span className="rounded-md bg-surface-2 px-2 py-0.5 tnum">{formatBRL(det.amount)}</span>}
                          {det.dueDate && <span className={cn('rounded-md bg-surface-2 px-2 py-0.5 tnum', d.status === 'new' && det.dueDate < todayISO() && 'bg-danger/10 text-danger')}>vence {formatDateBR(det.dueDate)}</span>}
                          {det.barcode && <span className="rounded-md bg-surface-2 px-2 py-0.5">código de barras</span>}
                          {det.pix && <span className="rounded-md bg-surface-2 px-2 py-0.5">PIX</span>}
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
          {prog.sentinel}
          {prog.hidden > 0 && <p className="border-t border-line px-4 py-2 text-center text-xs text-faint" aria-live="polite">Carregando mais {prog.hidden.toLocaleString('pt-BR')}…</p>}
          </div>
        )}
      </Card>}

      <FileViewer target={viewer} onClose={() => setViewer(null)} />
      <BillForm type="payable" bill={null} open={!!billFor} onClose={() => setBillFor(null)} onRestructure={() => undefined} onStopRecurrence={() => undefined} onView={() => undefined}
        seed={billFor ? { file: billFor.file, description: accountingBillDescription(billFor.doc.kind, billFor.doc.competence), notes: billFor.doc.note ?? '', slot: accountingIsPayable(billFor.doc.kind) ? 'boleto' : undefined, categoryId: billFor.categoryId } : null}
        onCreated={(b: Bill) => { if (billFor) void handle(billFor.doc, 'done', b.id); }} />
    </div>
  );
}

/** Limite por arquivo no envio do contador (igual ao padrão do servidor, MAX_UPLOAD_MB). */
const MAX_MB = 15;

/** Arquivo na lista de envio: cada um guarda o tipo escolhido quando entrou (dá para trocar na lista). */
type Pending = { file: File; kind: AccountingKind };

/** Envio: tipo → arquivos (vários, de tipos diferentes) → um pedido por tipo. */
function UploadCard({ company, onSent, history }: { company: boolean; onSent: () => void; history: AccountingDoc[] }) {
  // grupo → tipo. A folha só existe em espaço Empresa; grupo de um tipo só (Outros) já escolhe o tipo.
  const groups = ACCOUNTING_GROUPS.filter((g) => company || g.key !== 'payroll');
  const [group, setGroup] = useState<AccountingGroupKey | null>(null);
  const [kind, setKind] = useState<AccountingKind | null>(null);
  const groupKinds = (groups.find((g) => g.key === group)?.kinds ?? []) as readonly AccountingKind[];
  const pickGroup = (g: (typeof ACCOUNTING_GROUPS)[number]) => { setGroup(g.key); setKind(g.kinds.length === 1 ? g.kinds[0] : null); setSent(null); };
  const thisMonth = todayISO().slice(0, 7);
  /** Padrão: o mês atual — o do envio/pagamento (holerites e guias chegam no mês em que são pagos). */
  const [competence, setCompetence] = useState(thisMonth);
  /** Último envio feito nesta tela (confirmação visível). */
  const [sent, setSent] = useState<{ n: number; label: string; at: string } | null>(null);
  const allKinds = groups.flatMap((g) => g.kinds as readonly AccountingKind[]);
  const [note, setNote] = useState('');
  const [files, setFiles] = useState<Pending[]>([]);
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Progresso do envio (0–100). */
  const [pct, setPct] = useState(0);
  /** Envio anterior do mesmo arquivo (mesmo nome e tamanho), para avisar antes de mandar de novo. */
  const sentBefore = (f: File) => history.find((d) => d.originalName === f.name && d.size === f.size);
  const inputRef = useRef<HTMLInputElement>(null);
  const months = useMemo(() => Array.from({ length: 15 }, (_, i) => addMonthsRef(thisMonth, 1 - i)), [thisMonth]);
  const isPdf = (f: File) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
  const add = (list: FileList | File[] | null) => {
    if (!kind) return;
    const all = [...(list ?? [])];
    const pdfOnly = accountingIsSlips(kind);
    const ok = all.filter((f) => pdfOnly ? isPdf(f) : (/pdf|png|jpe?g|webp/i.test(f.type) || /\.(pdf|png|jpe?g|webp)$/i.test(f.name)));
    if (ok.length < all.length) toast.warning(pdfOnly ? `${ACCOUNTING_KIND_LABEL[kind]}: só PDF é aceito.` : 'Só PDF (ou imagem PNG/JPG) é aceito.');
    const big = ok.filter((f) => f.size > MAX_MB * 1024 * 1024), empty = ok.filter((f) => !f.size);
    if (big.length) toast.warning(`${big.map((f) => f.name).join(', ')}: maior que ${MAX_MB} MB, não dá para enviar. Reduza o arquivo ou divida em partes.`);
    if (empty.length) toast.warning(`${empty.map((f) => f.name).join(', ')}: o arquivo está vazio.`);
    const fresh = ok.filter((f) => !big.includes(f) && !empty.includes(f)).filter((f) => !files.some((x) => x.file.name === f.name && x.file.size === f.size));
    if (fresh.length < ok.length - big.length - empty.length) toast.info('Arquivo que já estava na lista ficou com o tipo de antes (dá para trocar na lista).');
    if (files.length + fresh.length > 20) toast.warning('Até 20 arquivos por envio.');
    setFiles((p) => [...p, ...fresh.map((file) => ({ file, kind }))].slice(0, 20));
  };
  /** Troca o tipo de um arquivo da lista (recibos e holerites só aceitam PDF). */
  const changeKind = (i: number, k: AccountingKind) => {
    if (accountingIsSlips(k) && !isPdf(files[i].file)) { toast.warning(`${ACCOUNTING_KIND_LABEL[k]}: só PDF é aceito.`); return; }
    setFiles((p) => p.map((x, j) => (j === i ? { ...x, kind: k } : x)));
  };
  /** Tipos na ordem em que aparecem na lista, com a contagem. */
  const byKind = useMemo(() => {
    const m = new Map<AccountingKind, File[]>();
    for (const x of files) m.set(x.kind, [...(m.get(x.kind) ?? []), x.file]);
    return [...m.entries()];
  }, [files]);
  const kindsText = byKind.map(([k, fs]) => `${ACCOUNTING_KIND_LABEL[k]}${byKind.length > 1 || fs.length > 1 ? ` (${fs.length})` : ''}`).join(' · ');
  const drop = (e: DragEvent) => { e.preventDefault(); setOver(false); add(e.dataTransfer.files); };
  const send = async () => {
    if (!files.length) return;
    setBusy(true); setPct(0);
    try {
      // um pedido só, com o tipo de cada arquivo: ou entra tudo ou nada, e o responsável recebe um aviso só
      const build = () => {
        const fd = new FormData();
        fd.append('kind', files[0].kind); fd.append('kinds', JSON.stringify(files.map((x) => x.kind))); fd.append('competence', competence); fd.append('note', note);
        for (const x of files) fd.append('file', x.file);
        return fd;
      };
      const r = await uploadFormWithProgress<{ created: number; unread?: string[]; storage?: { near: boolean } }>('/api/accounting/documents', build, setPct);
      if (r.storage?.near) toast.warning('Este espaço está perto do limite de armazenamento. Avise o responsável.');
      if (r.unread?.length) toast.warning(`Não reconhecemos recibos de funcionários em ${r.unread.map((n) => `“${n}”`).join(', ')}. O envio foi feito; confira se é o PDF certo (o original do sistema de folha).`, { duration: 12000 });
      toast.success(`${plural(r.created, 'documento enviado', 'documentos enviados')}. O responsável foi avisado.`);
      setSent({ n: r.created, label: `${byKind.map(([k]) => ACCOUNTING_KIND_LABEL[k]).join(', ')}${competence ? ` – ${refLabelPT(competence)}` : ''}`, at: new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) });
      setFiles([]); setNote(''); setKind(null); setGroup(null);
      onSent();
    } catch (e) {
      toast.error(`${errMsg(e)} Nenhum arquivo foi enviado: corrija e envie de novo.`, { duration: 10000 });
    } finally { setBusy(false); }
  };
  return (
    <Card className="p-3 sm:p-4 md:p-5">
      <div className="flex items-start justify-between gap-3">
        <h2 className="font-display text-lg font-semibold">Enviar documentos</h2>
      </div>
      <p className="mt-0.5 text-sm text-muted">1. Escolha o grupo e o tipo · 2. Confira o mês · 3. Adicione os arquivos.</p>
      {sent && !kind && !files.length && (
        <p className="mt-3 flex items-start gap-2 rounded-lg bg-ok/10 px-3 py-2.5 text-sm text-ok">
          <CircleCheck className="mt-0.5 size-4 shrink-0" />
          <span>Enviado às {sent.at}: <b className="font-medium">{sent.label}</b> ({plural(sent.n, 'arquivo', 'arquivos')}). O responsável foi avisado e o envio já está no histórico abaixo.</span>
        </p>
      )}
      <div role="radiogroup" aria-label="Grupo do documento" className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        {groups.map((g) => {
          const Icon = GROUP_ICON[g.key], on = group === g.key;
          return (
            <button key={g.key} type="button" role="radio" aria-checked={on} onClick={() => pickGroup(g)}
              className={cn('flex min-w-0 items-start gap-3 rounded-xl border p-3 text-left transition sm:p-4', on ? 'border-accent bg-accent-soft/50 shadow-card' : 'border-line hover:border-line-strong hover:bg-surface-2/50')}>
              <span className={cn('grid size-10 shrink-0 place-items-center rounded-xl', on ? 'bg-accent text-accent-ink' : 'bg-surface-2 text-muted')}><Icon className="size-5" /></span>
              <span className="min-w-0">
                <span className="block font-medium leading-tight">{g.label}</span>
                <span className="mt-0.5 block text-xs leading-snug text-faint">{g.hint}</span>
              </span>
            </button>
          );
        })}
      </div>
      {group && groupKinds.length > 1 && (
        <div className="mt-3 rounded-xl border border-line bg-surface-2/40 p-3">
          <p className="mb-2 text-[13px] font-medium text-muted">Qual documento de {ACCOUNTING_GROUPS.find((g) => g.key === group)!.label.toLowerCase()}?</p>
          <div role="radiogroup" aria-label="Tipo do documento" className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            {groupKinds.map((k) => {
              const Icon = KIND_ICON[k], on = kind === k;
              return (
                <button key={k} type="button" role="radio" aria-checked={on} onClick={() => { setKind(k); setSent(null); }}
                  className={cn('flex min-w-0 flex-col items-start gap-1.5 rounded-xl border bg-surface p-3 text-left transition', on ? 'border-accent bg-accent-soft/50 shadow-card' : 'border-line hover:border-line-strong')}>
                  <Icon className={cn('size-5', on ? 'text-accent' : 'text-faint')} />
                  <span className="text-sm font-medium leading-tight">{ACCOUNTING_KIND_LABEL[k]}</span>
                  <span className="text-xs leading-snug text-faint">{ACCOUNTING_KIND_HINT[k]}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
      {(kind || files.length > 0) && (
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
          {kind ? <>
          <input ref={inputRef} type="file" multiple accept="application/pdf,.pdf,image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => { add(e.target.files); e.target.value = ''; }} />
          <button type="button" onClick={() => inputRef.current?.click()} onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)} onDrop={drop}
            className={cn('flex w-full flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition', over ? 'border-accent bg-accent-soft/40' : 'border-line hover:border-accent hover:bg-accent-soft/30')}>
            <span className="grid size-11 place-items-center rounded-2xl bg-accent-soft text-accent"><Upload className="size-5" /></span>
            <span className="font-medium">{isTouch() ? 'Toque para escolher os arquivos' : 'Arraste os arquivos aqui ou clique para escolher'}</span>
            <span className="text-xs text-faint">{accountingIsSlips(kind) ? 'O PDF original do sistema de folha, com os recibos de todos os funcionários.' : kind === 'payroll_report' ? 'O relatório de férias (“Períodos Aquisitivos Abertos” ou “Férias Vencidas e a Vencer”) é reconhecido sozinho e já aparece na folha da empresa.' : !accountingIsPayable(kind) ? `PDF de preferência. Até ${MAX_MB} MB por arquivo, 20 arquivos por envio.` : `PDF de preferência (lemos valor, vencimento, código de barras e PIX). Até ${MAX_MB} MB por arquivo, 20 arquivos por envio.`}</span>
            <span className="text-xs font-medium text-accent">Os arquivos adicionados agora entram como “{ACCOUNTING_KIND_LABEL[kind]}”.</span>
          </button>
          </> : <p className="rounded-lg bg-surface-2/60 px-3 py-2.5 text-sm text-muted">Para juntar arquivos de outro tipo, escolha o grupo e o tipo acima. Os que já estão na lista mantêm o tipo de cada um.</p>}
          {files.length > 0 && (
            <div className="rounded-xl border-2 border-accent/50 bg-accent-soft/30 p-3 sm:p-4" aria-live="polite">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="flex items-center gap-2 font-medium"><Paperclip className="size-4 text-accent" />{plural(files.length, 'arquivo pronto', 'arquivos prontos')} para enviar</p>
                <span className="text-sm text-muted tnum">{sizeText(files.reduce((n, x) => n + x.file.size, 0))} no total</span>
              </div>
              <ul className="mt-3 flex flex-col gap-2">
                {files.map(({ file: f, kind: k }, i) => {
                  const Icon = KIND_ICON[k];
                  return (
                  <li key={`${f.name}-${f.size}`} className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 shadow-card sm:flex-nowrap">
                    <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent"><Icon className="size-5" /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block break-words text-[15px] font-medium leading-snug">{f.name}</span>
                      <span className="block text-xs text-muted tnum">{sizeText(f.size)} · {isPdf(f) ? 'PDF' : 'imagem'}</span>
                      {sentBefore(f) && <span className="mt-1 flex items-start gap-1.5 text-xs text-warn"><TriangleAlert className="mt-px size-3.5 shrink-0" />Você já enviou um arquivo igual em {when(sentBefore(f)!.createdAt)} ({ACCOUNTING_KIND_LABEL[sentBefore(f)!.kind]}). Se for repetido, tire da lista.</span>}
                    </span>
                    <div className="order-last w-full sm:order-none sm:w-56 sm:shrink-0">
                      <Select aria-label={`Tipo de ${f.name}`} value={k} onChange={(e) => changeKind(i, e.target.value as AccountingKind)}>
                        {groups.map((g) => (
                          <optgroup key={g.key} label={g.label}>
                            {(g.kinds as readonly AccountingKind[]).filter((x) => allKinds.includes(x)).map((x) => <option key={x} value={x}>{ACCOUNTING_KIND_LABEL[x]}</option>)}
                          </optgroup>
                        ))}
                      </Select>
                    </div>
                    <button type="button" aria-label={`Tirar ${f.name}`} title="Tirar da lista" className="grid size-9 pointer-coarse:size-10 shrink-0 place-items-center rounded-md text-muted hover:bg-danger/10 hover:text-danger" onClick={() => setFiles(files.filter((_, j) => j !== i))}><X className="size-4" /></button>
                  </li>
                  );
                })}
              </ul>
            </div>
          )}
          {busy && (
            <div className="flex items-center gap-3">
              <LogoLoader size={64} progress={pct / 100} label="Progresso do envio" />
              <div className="h-2 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2"><div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${pct}%` }} /></div>
              <span className="w-24 shrink-0 text-right text-xs text-muted tnum">{pct < 100 ? `enviando ${pct}%` : 'conferindo…'}</span>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-end gap-3">
            <span className="mr-auto text-xs text-faint">{files.length ? `${kindsText}${competence ? ` – ${refLabelPT(competence)}` : ''} · ${plural(files.length, 'arquivo', 'arquivos')}` : 'Nenhum arquivo escolhido ainda.'}</span>
            <Button variant="primary" className="max-sm:w-full" loading={busy} disabled={!files.length} icon={<FileUp className="size-4" />} onClick={send}>Enviar {files.length > 1 ? `${files.length} arquivos` : 'documento'}</Button>
          </div>
        </div>
      )}
    </Card>
  );
}
