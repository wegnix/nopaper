import { useEffect, useMemo, useState } from 'react';
import { useBillNames, useBillPerms, useCan } from '@/lib/session';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Barcode, CheckCircle2, Eye, Infinity as InfinityIcon, Lock, LockOpen, QrCode, Sparkles, Trash2, X } from 'lucide-react';
import {
  ATTACHMENT_SLOTS, ATTACHMENT_SLOT_LABEL, PAYMENT_METHODS, PIX_KEY_TYPE_LABEL, formatBRL, formatDateBR, parseBoleto, parsePix,
  todayISO, type AttachmentSlot, type BillType,
} from '@nopaper/shared';
import { Dialog, SaveFooter, useFormState } from '@/components/ui/dialog';
import { Button, Checkbox, Field, IconButton, Input, Segmented, Select } from '@/components/ui/base';
import { api, post, put, errMsg, ApiError } from '@/lib/api';
import { useCategories, useFolders } from '@/lib/queries';
import { Combobox } from '@/components/ui/combobox';
import { cn, isTouch } from '@/lib/utils';
import type { Bill, Classification } from '@/lib/types';
import { MoneyInput } from './MoneyInput';
import { RecurrenceEditor, initialRec, needsRows, recPayload, type RecState } from './RecurrenceEditor';
import { DocDrop } from './DocDrop';
import { CopyButton, SLOT_META } from './attachments';
import { BarcodeButton, PixQrButton } from './PayCode';
import { L, RECURRENCE_LABEL } from './labels';
import { DatePicker } from '@/components/ui/date-picker';

interface Props {
  type: BillType;
  bill: Bill | null; // null = criar
  open: boolean;
  onClose: () => void;
  onRestructure: (b: Bill) => void;
  onStopRecurrence: (b: Bill) => void;
  onView: (b: Bill, slot: AttachmentSlot) => void;
  /** Conta nova já com um arquivo para ler (ex.: guia enviada pelo contador) e textos sugeridos. */
  seed?: { file: File; description?: string; notes?: string; /** Tipo do anexo quando a leitura não tiver certeza. */ slot?: AttachmentSlot } | null;
  /** Chamado quando a conta nova é criada. */
  onCreated?: (b: Bill) => void;
}

const confLabel = { high: 'alta', medium: 'média', low: 'baixa' };

function SmartHint({ tone, icon, children }: { tone: 'ok' | 'warn' | 'info'; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className={cn('mt-1.5 flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-xs',
      tone === 'ok' && 'bg-ok/10 text-ok', tone === 'warn' && 'bg-warn/10 text-warn', tone === 'info' && 'bg-accent-soft text-accent')}>
      <span className="mt-px">{icon}</span><span className="min-w-0">{children}</span>
    </div>
  );
}

async function uploadAttachment(billId: string, file: File, slot: AttachmentSlot | 'auto', password?: string) {
  const fd = new FormData();
  if (password) fd.append('password', password); // os campos de texto vão antes do arquivo
  fd.append('file', file);
  return api<{ bill: Bill; classification: Classification | null; slot: AttachmentSlot }>('POST', `/api/bills/${billId}/attachments?slot=${slot}`, fd);
}

export function BillForm({ type, bill, open, onClose, onRestructure, onStopRecurrence, onView, seed, onCreated }: Props) {
  const l = L[type];
  const names = useBillNames()(type);
  const canOrg = useCan()('org.settings');
  const [current, setCurrent] = useState<Bill | null>(bill);
  /** Depois de criar, a janela continua aberta editando a conta criada. */
  const isEdit = !!current;
  const perm = useBillPerms(type);
  const qc = useQueryClient();
  const { data: categories = [] } = useCategories();
  const { data: folders = [] } = useFolders();
  const cats = useMemo(() => categories.filter((c) => c.kind === 'both' || c.kind === type), [categories, type]);

  const [f, setF, form] = useFormState(() => blank());
  const [rec, setRec] = useState<RecState>(initialRec());
  const [cascade, setCascade] = useState(false);
  const [pending, setPending] = useState<{ file: File; slot: AttachmentSlot | null; cls: Classification | null; password?: string } | null>(null);
  // PDF com senha que nenhuma regra abriu: a pessoa digita a senha aqui
  const [pdfPw, setPdfPw] = useState({ value: '', remember: true });
  const [analyzing, setAnalyzing] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [manualFor, setManualFor] = useState<File | null>(null);

  function blank() {
    return {
      description: '', categoryId: '', folderId: '', amount: '', dueDate: todayISO(), status: 'pending' as 'pending' | 'paid',
      paidAt: todayISO(), paidAmount: '', relatedPerson: '', notes: '', barcode: '', pixKey: '', paymentMethod: '',
    };
  }

  function fromBill(b: Bill) {
    return {
      description: b.description, categoryId: b.categoryId, folderId: b.folderId ?? '', amount: b.amount, dueDate: b.dueDate,
      status: b.status, paidAt: b.paidAt ?? todayISO(), paidAmount: b.paidAmount ?? b.amount, relatedPerson: b.relatedPerson ?? '',
      notes: b.notes ?? '', barcode: b.barcode ?? '', pixKey: b.pixKey ?? '', paymentMethod: b.paymentMethod ?? '',
    };
  }
  useEffect(() => {
    if (!open) return;
    setCurrent(bill);
    setPending(null); setManualFor(null); setCascade(false);
    if (bill) {
      form.load(fromBill(bill));
      setRec(initialRec(bill.recurrenceType, bill.isIndefinite));
    } else {
      form.load({ ...blank(), categoryId: cats[0]?.id ?? '', description: seed?.description ?? '', notes: seed?.notes ?? '' });
      setRec(initialRec());
      if (seed) void analyze(seed.file, seed.slot);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, bill?.id]);
  // conta nova e as categorias chegaram depois de abrir: escolhe a 1ª sem contar como alteração.
  // Só em conta nova: ao editar, este efeito roda junto com o de cima ainda com o `f` vazio e
  // apagava os dados recém-carregados (a 1ª edição depois de abrir a página vinha em branco).
  useEffect(() => { if (open && !bill && !f.categoryId && cats[0]) form.load({ ...f, categoryId: cats[0].id, description: f.description || seed?.description || '', notes: f.notes || seed?.notes || '' }); }, [cats, open, f.categoryId]); // eslint-disable-line react-hooks/exhaustive-deps

  const boleto = useMemo(() => (f.barcode.replace(/\D/g, '').length >= 44 ? parseBoleto(f.barcode) : null), [f.barcode]);
  const pix = useMemo(() => (f.pixKey.trim() ? parsePix(f.pixKey) : null), [f.pixKey]);
  // boleto/PIX válido colado com valor vazio: preenche sozinho (o usuário ainda pode editar)
  useEffect(() => {
    if (isEdit || !boleto?.valid) return;
    setF((p) => ({ ...p, amount: p.amount || boleto.amount || '', dueDate: boleto.dueDate ?? p.dueDate, paymentMethod: p.paymentMethod || 'Boleto' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boleto?.barcode]);
  useEffect(() => {
    if (isEdit || !pix?.isBrCode || !pix.crcValid) return;
    setF((p) => ({ ...p, amount: p.amount || pix.amount || '', description: p.description || pix.merchantName || '', paymentMethod: p.paymentMethod || 'PIX' }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [f.pixKey]);
  const series = !!current && (current.parentId !== null || current.recurrenceType !== 'once');
  const isHeadOrSingle = !!current && current.parentId === null;

  const applyClassification = (c: Classification) => {
    setF((p) => ({
      ...p,
      barcode: p.barcode || c.barcode || '',
      pixKey: p.pixKey || c.pixCode || c.pixKey || '',
      amount: !isEdit && !p.amount && c.amount ? c.amount : p.amount,
      dueDate: !isEdit && c.dueDate ? c.dueDate : p.dueDate,
      description: !isEdit && !p.description && c.beneficiary ? c.beneficiary.slice(0, 120) : p.description,
      paymentMethod: p.paymentMethod || (c.kind === 'boleto' ? (c.barcode ? 'Boleto' : c.pixCode ? 'PIX' : '') : ''),
    }));
  };

  const analyze = async (file: File, prefer?: AttachmentSlot, password?: string, remember?: boolean) => {
    setAnalyzing(true);
    try {
      const fd = new FormData();
      if (password) { fd.append('password', password); if (remember) fd.append('remember', '1'); }
      fd.append('file', file);
      const c = await api<Classification>('POST', '/api/documents/analyze', fd);
      setPending({ file, slot: prefer && c.confidence !== 'high' ? prefer : c.kind === 'unknown' ? null : c.kind, cls: c, password: password && !c.locked ? password : undefined });
      if (password && !c.locked) setPdfPw({ value: '', remember: true });
      if (c.kind !== 'unknown') applyClassification(c);
    } catch (e) { toast.error(errMsg(e)); } finally { setAnalyzing(false); }
  };

  const uploadNow = async (file: File, slot: AttachmentSlot | 'auto') => {
    if (!current) return;
    setUploading(true);
    try {
      const r = await uploadAttachment(current.id, file, slot);
      setCurrent(r.bill); setManualFor(null);
      if (r.classification) {
        toast.success(`Detectado como ${ATTACHMENT_SLOT_LABEL[r.slot].toLowerCase()} (confiança ${confLabel[r.classification.confidence]})`);
        if (r.classification.barcode && !f.barcode) setF((p) => ({ ...p, barcode: r.classification!.barcode! }));
      } else toast.success(`${ATTACHMENT_SLOT_LABEL[r.slot]} anexado`);
      qc.invalidateQueries({ queryKey: ['bills'] });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'classification_unknown') setManualFor(file);
      else toast.error(errMsg(e));
    } finally { setUploading(false); }
  };

  const removeAttachment = async (slot: AttachmentSlot) => {
    if (!current) return;
    try { const b = await api<Bill>('DELETE', `/api/bills/${current.id}/attachments/${slot}`); setCurrent(b); qc.invalidateQueries({ queryKey: ['bills'] }); } catch (e) { toast.error(errMsg(e)); }
  };

  const valid = f.description.trim() && f.categoryId && f.dueDate && (needsRows(rec) && !isEdit ? true : !!f.amount) && (!pending || pending.slot);

  const submit = async () => {
    setBusy(true);
    try {
      if (!isEdit) {
        const payload = {
          type, description: f.description, categoryId: f.categoryId, folderId: f.folderId || null,
          relatedPerson: f.relatedPerson, notes: f.notes, barcode: f.barcode, pixKey: f.pixKey, paymentMethod: f.paymentMethod,
          ...recPayload(rec, f.dueDate, f.amount),
        };
        const r = await post<{ headId: string; items: Bill[] }>('/api/bills', payload);
        let head = r.items.find((b) => b.id === r.headId) ?? r.items[0] ?? null;
        if (pending?.slot) {
          try { head = (await uploadAttachment(r.headId, pending.file, pending.slot, pending.password)).bill; } catch (e) { toast.error(`Conta criada, mas o anexo falhou: ${errMsg(e)}`); }
        }
        toast.success(r.items.length > 1 ? `${r.items.length} lançamentos criados — editando o primeiro` : 'Conta criada');
        setPending(null);
        if (head) { setCurrent(head); form.load(fromBill(head)); setRec(initialRec(head.recurrenceType, head.isIndefinite)); onCreated?.(head); }
      } else if (current) {
        const folderChanged = (current.folderId ?? '') !== f.folderId;
        const r = await put<Bill & { cascaded: number }>(`/api/bills/${current.id}`, {
          description: f.description, categoryId: f.categoryId, folderId: f.folderId || null, amount: f.amount, dueDate: f.dueDate,
          relatedPerson: f.relatedPerson, notes: f.notes, barcode: f.barcode, pixKey: f.pixKey, paymentMethod: f.paymentMethod,
          status: f.status, paidAt: f.status === 'paid' ? f.paidAt : null, paidAmount: f.status === 'paid' ? f.paidAmount || f.amount : null,
          cascade: series && (cascade || folderChanged),
        });
        toast.success(r.cascaded ? `Conta salva e ${r.cascaded} ocorrência(s) futura(s) atualizada(s)` : 'Conta salva');
        setCurrent(r); form.load(fromBill(r)); setCascade(false);
      }
      qc.invalidateQueries({ queryKey: ['bills'] });
      qc.invalidateQueries({ queryKey: ['categories'] });
      qc.invalidateQueries({ queryKey: ['folders'] });
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); }
  };

  const hideAmount = !isEdit && needsRows(rec);
  // criando: a repetição e o arquivo também contam como alteração
  const dirty = form.dirty || (!isEdit && (!!pending || rec.type !== 'once'));

  return (
    <Dialog
      open={open} onClose={onClose} size="lg"
      title={isEdit ? 'Editar conta' : names.new}
      description={isEdit && current ? <span className="inline-flex items-center gap-2">{RECURRENCE_LABEL[current.recurrenceType]}{current.installmentNumber && ` · parcela ${current.installmentNumber}/${current.totalInstallments}`}{current.isIndefinite && <span className="inline-flex items-center gap-1 text-accent"><InfinityIcon className="size-3.5" /> sem data para acabar</span>}</span> : (isTouch() ? 'Envie' : 'Arraste') + ' o boleto ou a nota para preencher automaticamente.'}
      dirty={dirty}
      footer={<SaveFooter dirty={dirty} isNew={!isEdit} saving={busy} canSave={!!valid} onSave={submit} onClose={onClose} saveLabel={isEdit ? 'Salvar' : 'Criar conta'} />}
    >
      <div className="flex flex-col gap-5">
        {!isEdit && (
          pending ? (
            <div className={cn('rounded-xl border p-3', pending.slot && !pending.cls?.locked ? 'border-ok/40 bg-ok/5' : 'border-warn/40 bg-warn/5')}>
              <div className="flex items-start gap-3">
                {pending.slot && !pending.cls?.locked ? <Sparkles className="size-5 text-ok shrink-0" /> : <AlertTriangle className="size-5 text-warn shrink-0" />}
                <div className="min-w-0 flex-1 text-sm">
                  <p className="font-medium truncate">{pending.file.name}</p>
                  {pending.cls?.locked ? null : pending.slot && pending.cls ? (
                    <p className="text-xs text-muted mt-0.5">
                      Identificado como <b>{ATTACHMENT_SLOT_LABEL[pending.slot].toLowerCase()}</b> (confiança {confLabel[pending.cls.confidence]})
                      {[pending.cls.barcode && 'código de barras', pending.cls.amount && 'valor', pending.cls.dueDate && 'vencimento', (pending.cls.pixCode || pending.cls.pixKey) && 'PIX'].filter(Boolean).length > 0 &&
                        ` · preenchido: ${[pending.cls.barcode && 'código de barras', pending.cls.amount && 'valor', pending.cls.dueDate && 'vencimento', (pending.cls.pixCode || pending.cls.pixKey) && 'PIX'].filter(Boolean).join(', ')}`}.
                      {' '}Será anexado ao criar a conta.
                    </p>
                  ) : <p className="text-xs text-muted mt-0.5">Não deu para identificar o tipo. Escolha:</p>}
                  {pending.cls?.locked && (
                    <div className="mt-1">
                      <p className="flex items-center gap-1.5 text-xs text-muted"><Lock className="size-3.5 shrink-0" /> Este PDF tem senha. Digite a senha para o NoPaper ler e guardar o arquivo sem senha, ou escolha o tipo abaixo e anexe como está.</p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Input aria-label="Senha do PDF" autoComplete="off" className="h-9 w-40" placeholder="Senha do PDF" value={pdfPw.value} onChange={(e) => setPdfPw({ ...pdfPw, value: e.target.value })}
                          onKeyDown={(e) => { if (e.key === 'Enter' && pdfPw.value) { e.preventDefault(); void analyze(pending.file, undefined, pdfPw.value, pdfPw.remember && canOrg); } }} />
                        <Button size="sm" variant="secondary" loading={analyzing} disabled={!pdfPw.value} onClick={() => analyze(pending.file, undefined, pdfPw.value, pdfPw.remember && canOrg)}>Abrir</Button>
                        {canOrg && <Checkbox checked={pdfPw.remember} onChange={(remember) => setPdfPw({ ...pdfPw, remember })} label={<span className="text-xs text-muted">Lembrar esta senha neste espaço</span>} />}
                      </div>
                    </div>
                  )}
                  {pending.cls?.unlockedBy && <p className="mt-1 flex items-center gap-1.5 text-xs text-ok"><LockOpen className="size-3.5 shrink-0" /> PDF com senha aberto ({pending.cls.unlockedBy}). Será guardado sem senha.</p>}
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    {ATTACHMENT_SLOTS.map((s) => (
                      <button key={s} type="button" onClick={() => setPending({ ...pending, slot: s })}
                        className={cn('rounded-md border px-2 py-1 text-xs font-medium', pending.slot === s ? SLOT_META[s].tone : 'border-line text-muted hover:text-ink')}>
                        {ATTACHMENT_SLOT_LABEL[s]}
                      </button>
                    ))}
                  </div>
                </div>
                <IconButton label="Remover arquivo" onClick={() => setPending(null)}><X className="size-4" /></IconButton>
              </div>
            </div>
          ) : <DocDrop onFile={analyze} busy={analyzing} label={isTouch() ? 'Toque para enviar o boleto, PIX ou nota fiscal' : 'Arraste aqui o boleto, PIX ou nota fiscal'} hint="PDF ou imagem até 15 MB. Lemos o código de barras, valor e vencimento." />
        )}

        <Field label="Descrição" required>
          <Input value={f.description} maxLength={255} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder={type === 'payable' ? 'Ex.: Aluguel, Energia, Fornecedor X' : 'Ex.: Mensalidade cliente Y'} autoFocus={!isEdit} />
        </Field>

        <div className="grid sm:grid-cols-3 gap-4">
          <Field label="Categoria" required>
            <Select value={f.categoryId} onChange={(e) => setF({ ...f, categoryId: e.target.value })}>
              {cats.map((c) => <option key={c.id} value={c.id}>{c.label}{c.isRestricted ? ' 🔒' : ''}</option>)}
            </Select>
          </Field>
          <Field label="Pasta">
            <Select value={f.folderId} onChange={(e) => setF({ ...f, folderId: e.target.value })}>
              <option value="">Sem pasta</option>
              {folders.map((x) => <option key={x.id} value={x.id}>{x.label}</option>)}
            </Select>
          </Field>
          <Field label={rec.type !== 'once' && !isEdit ? '1º vencimento' : 'Vencimento'} required>
            <DatePicker value={f.dueDate} disabled={!!current?.statementId || !!current?.payrollEntryId} onChange={(dueDate) => setF({ ...f, dueDate })} />
          </Field>
        </div>

        {isEdit && current?.payrollEntryId && (
          <p className="-mt-2 rounded-lg bg-accent-soft/60 px-3 py-2 text-xs text-accent">Este salário vem da Folha de pagamento: valor e vencimento vêm do lançamento do funcionário no mês.</p>
        )}
        {isEdit && current?.statementId && (
          <p className="-mt-2 rounded-lg bg-accent-soft/60 px-3 py-2 text-xs text-accent">Esta conta é a fatura de um cartão: valor e vencimento vêm dos lançamentos na tela de Cartões.</p>
        )}
        <div className="grid sm:grid-cols-3 gap-4">
          {!hideAmount && (
            <Field label={rec.type === 'installments' && !isEdit ? 'Valor de cada parcela' : 'Valor'} required>
              <MoneyInput value={f.amount} disabled={!!current?.statementId || !!current?.payrollEntryId} onChange={(amount) => setF({ ...f, amount })} />
            </Field>
          )}
          <Field label="Forma de pagamento">
            <Combobox value={f.paymentMethod} maxLength={64} onChange={(paymentMethod) => setF({ ...f, paymentMethod })} options={PAYMENT_METHODS} placeholder="PIX, Boleto, DDA…" />
          </Field>
          <Field label={l.person}>
            <Input value={f.relatedPerson} maxLength={128} onChange={(e) => setF({ ...f, relatedPerson: e.target.value })} />
          </Field>
        </div>

        {isEdit && perm.pay && (
          <div className="grid sm:grid-cols-3 gap-4 rounded-xl border border-line p-3">
            <Field label="Situação">
              <Segmented value={f.status} onChange={(status) => setF({ ...f, status, paidAmount: f.paidAmount || f.amount })} options={[{ value: 'pending', label: 'Pendente' }, { value: 'paid', label: l.paid }]} />
            </Field>
            {f.status === 'paid' && <>
              <Field label={l.paidAt}><DatePicker value={f.paidAt} onChange={(paidAt) => setF({ ...f, paidAt })} /></Field>
              <Field label={l.paidAmount} hint="Pode diferir do previsto (juros ou desconto)."><MoneyInput value={f.paidAmount} onChange={(paidAmount) => setF({ ...f, paidAmount })} /></Field>
            </>}
          </div>
        )}

        {!isEdit && (
          <div>
            <p className="mb-2 text-[13px] font-medium text-muted">Repetição</p>
            <RecurrenceEditor rec={rec} setRec={setRec} dueDate={f.dueDate} amount={f.amount} />
          </div>
        )}

        <div className="grid gap-4">
          <Field label="Código de barras / linha digitável">
            <div className="flex gap-1">
              <Input className="font-mono text-[13px]" value={f.barcode} maxLength={120} onChange={(e) => setF({ ...f, barcode: e.target.value })} placeholder="00000.00000 00000.000000 00000.000000 0 00000000000000" />
              {f.barcode && <CopyButton text={f.barcode.replace(/\D/g, '')} className="size-10" />}
              {boleto && <BarcodeButton barcode={f.barcode} className="size-10" />}
            </div>
            {boleto && (boleto.valid ? (
              <SmartHint tone="ok" icon={<Barcode className="size-3.5" />}>
                Boleto {boleto.kind === 'bancario' ? `bancário${boleto.bankCode ? ` (banco ${boleto.bankCode})` : ''}` : 'de arrecadação'} válido
                {boleto.amount && ` · ${formatBRL(boleto.amount)}`}{boleto.dueDate && ` · vence ${formatDateBR(boleto.dueDate)}`}
                {(boleto.amount && boleto.amount !== f.amount) || (boleto.dueDate && boleto.dueDate !== f.dueDate) ? (
                  <button type="button" className="ml-2 underline font-medium" onClick={() => setF({ ...f, amount: boleto.amount ?? f.amount, dueDate: boleto.dueDate ?? f.dueDate })}>usar estes dados</button>
                ) : null}
              </SmartHint>
            ) : <SmartHint tone="warn" icon={<AlertTriangle className="size-3.5" />}>Os dígitos verificadores não conferem. Confira o código.</SmartHint>)}
          </Field>
          <Field label="PIX (chave ou copia e cola)">
            <div className="flex gap-1">
              <Input className="font-mono text-[13px]" value={f.pixKey} onChange={(e) => setF({ ...f, pixKey: e.target.value })} placeholder="CPF, e-mail, celular, chave aleatória ou 000201…" />
              {f.pixKey && <CopyButton text={f.pixKey} className="size-10" />}
              {pix && (pix.isBrCode || pix.keyType) && <PixQrButton pix={f.pixKey} amount={f.status === 'paid' ? null : f.amount} name={f.description} className="size-10" />}
            </div>
            {pix && (pix.isBrCode ? (
              pix.crcValid ? (
                <SmartHint tone="ok" icon={<QrCode className="size-3.5" />}>
                  PIX copia e cola{pix.merchantName && ` · ${pix.merchantName}`}{pix.amount && ` · ${formatBRL(pix.amount)}`}{pix.key && ` · chave ${pix.key}`}
                  {pix.amount && pix.amount !== f.amount && <button type="button" className="ml-2 underline font-medium" onClick={() => setF({ ...f, amount: pix.amount!, description: f.description || pix.merchantName || '' })}>usar valor</button>}
                </SmartHint>
              ) : <SmartHint tone="warn" icon={<AlertTriangle className="size-3.5" />}>Código PIX incompleto ou alterado (CRC não confere).</SmartHint>
            ) : pix.keyType ? <SmartHint tone="info" icon={<CheckCircle2 className="size-3.5" />}>Chave PIX: {PIX_KEY_TYPE_LABEL[pix.keyType]}</SmartHint> : null)}
          </Field>
          <Field label="Observações">
            <Input value={f.notes} maxLength={2000} onChange={(e) => setF({ ...f, notes: e.target.value })} />
          </Field>
        </div>

        {isEdit && current && (
          <div className="flex flex-col gap-3">
            <p className="text-[13px] font-medium text-muted">Anexos</p>
            {ATTACHMENT_SLOTS.filter((s) => current.attachments[s]).map((s) => {
              const a = current.attachments[s]!;
              const M = SLOT_META[s];
              return (
                <div key={s} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
                  <span className={cn('grid size-8 place-items-center rounded-md border', M.tone)}><M.icon className="size-4" /></span>
                  <span className="min-w-0 flex-1"><span className="block text-sm font-medium">{M.label}</span><span className="block truncate text-xs text-faint">{a.name} · {Math.ceil(a.size / 1024)} KB</span></span>
                  <IconButton label="Visualizar" onClick={() => onView(current, s)}><Eye className="size-4" /></IconButton>
                  <IconButton label="Remover" tone="danger" onClick={() => removeAttachment(s)}><Trash2 className="size-4" /></IconButton>
                </div>
              );
            })}
            {manualFor ? (
              <div className="rounded-xl border border-warn/40 bg-warn/5 p-3 text-sm">
                <p className="font-medium">Não deu para identificar “{manualFor.name}”. Que documento é este?</p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {ATTACHMENT_SLOTS.map((s) => <Button key={s} size="sm" variant="outline" loading={uploading} onClick={() => uploadNow(manualFor, s)}>{ATTACHMENT_SLOT_LABEL[s]}</Button>)}
                  <Button size="sm" variant="ghost" onClick={() => setManualFor(null)}>Cancelar</Button>
                </div>
              </div>
            ) : <DocDrop compact onFile={(file) => uploadNow(file, 'auto')} busy={uploading} label="Anexar boleto, nota fiscal ou comprovante" hint="O tipo é identificado automaticamente. Um arquivo novo substitui o do mesmo tipo." />}
          </div>
        )}

        {isEdit && current && series && (
          <div className="rounded-xl border border-accent/30 bg-accent-soft/40 p-4 flex flex-col gap-3">
            <p className="text-sm font-medium">Esta conta faz parte de uma série ({RECURRENCE_LABEL[current.recurrenceType].toLowerCase()})</p>
            <Checkbox checked={cascade} onChange={setCascade}
              label={<span>Aplicar as mudanças também às próximas ocorrências pendentes<span className="block text-xs text-faint mt-0.5">Descrição, categoria, pasta, valor, pessoa, PIX, forma de pagamento e observações. O vencimento e o código de barras de cada uma não mudam; as já pagas não são tocadas. Trocar a pasta sempre se aplica às próximas.</span></span>} />
            <div className="flex flex-wrap gap-2">
              {isHeadOrSingle && current.status !== 'paid' && <Button size="sm" variant="outline" onClick={() => onRestructure(current)}>Mudar repetição (tipo, quantidade, datas)</Button>}
              {(current.isIndefinite || current.recurrenceType !== 'once') && <Button size="sm" variant="ghost" className="text-danger" onClick={() => onStopRecurrence(current)}>Parar a série a partir de hoje</Button>}
            </div>
          </div>
        )}
        {isEdit && current && !series && !current.statementId && !current.payrollEntryId && current.status !== 'paid' && (
          <button type="button" className="self-start text-sm text-accent hover:underline" onClick={() => onRestructure(current)}>Transformar em conta recorrente ou parcelada</button>
        )}
      </div>
    </Dialog>
  );
}
