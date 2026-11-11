import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Copy, Download, FileSignature, FileUp, MessageCircle, PenLine, Send, X } from 'lucide-react';
import { formatBRL, refLabelPT, whatsappLink, type PayslipSignatureRow } from '@nopaper/shared';
import { Button, Empty, IconButton, Select, Spinner } from '@/components/ui/base';
import { StatusChip } from '@/components/ui/chips';
import { Dialog, useConfirm } from '@/components/ui/dialog';
import { api, del, get, post, errMsg } from '@/lib/api';
import { useCan, useSession } from '@/lib/session';
import { downloadBlob, plural } from '@/lib/utils';
import { payrollKey } from './data';
import { useAccountants } from '@/features/accounting/data';

const when = (iso: string) => { const d = new Date(iso); return `${d.toLocaleDateString('pt-BR')} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`; };

export function useSignatures(periodId: string | null) {
  const orgId = useSession((s) => s.orgId);
  return useQuery({
    enabled: !!periodId, queryKey: payrollKey(orgId, 'signatures', periodId),
    queryFn: () => get<PayslipSignatureRow[]>(`/api/payroll/periods/${periodId}/signatures`),
  });
}

export function useSignatureTerms(enabled: boolean) {
  const orgId = useSession((s) => s.orgId);
  return useQuery({ enabled, queryKey: payrollKey(orgId, 'signature-terms'), queryFn: () => get<PayslipSignatureRow[]>('/api/payroll/signature-terms') });
}

/**
 * Assinatura eletrônica dos holerites do mês: envia o PDF do contador, cada funcionário recebe um
 * link pessoal (abre com o CPF) e assina no celular; a via assinada fica aqui e pode ir ao contador.
 */
export function SignaturesDialog({ open, onClose, periodId, refStr }: { open: boolean; onClose: () => void; periodId: string; refStr: string }) {
  const can = useCan();
  const qc = useQueryClient();
  const orgId = useSession((s) => s.orgId);
  const confirm = useConfirm();
  const q = useSignatures(open ? periodId : null);
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const [skipped, setSkipped] = useState<Array<{ name: string; reason: string }>>([]);
  const canEdit = can('payroll.edit');
  const terms = useSignatureTerms(open);
  const [termBusy, setTermBusy] = useState(false);
  const rows = q.data ?? [];
  const termRows = terms.data ?? [];
  // os termos assinados ficam recolhidos: depois que todos assinam, a seção quase some
  const [showSigned, setShowSigned] = useState(false);
  const termsSigned = termRows.filter((t) => t.status === 'signed').length;
  const termsShown = showSigned ? termRows : termRows.filter((t) => t.status !== 'signed');
  const toSend = [...termRows, ...rows].filter((r) => r.status === 'signed' && !r.sentToAccountantAt);
  const reload = () => { qc.invalidateQueries({ queryKey: payrollKey(orgId, 'signatures', periodId) }); qc.invalidateQueries({ queryKey: payrollKey(orgId, 'signature-terms') }); };
  const what = (r: PayslipSignatureRow) => (r.kind === 'term' ? 'Termo de assinatura eletrônica' : 'Holerite');
  // mais de um contador no espaço: escolhe para qual vão os assinados
  const accountants = useAccountants(open && can('accounting.send')).data ?? [];
  const [recipient, setRecipient] = useState('');
  const needRecipient = accountants.length > 1;
  const makeTerms = async () => {
    setTermBusy(true);
    try {
      const r = await post<{ created: number; skipped: Array<{ name: string; reason: string }> }>('/api/payroll/signature-terms');
      setSkipped(r.skipped);
      if (r.created) toast.success(`${plural(r.created, 'termo de aceite criado', 'termos de aceite criados')}. Envie o link a cada funcionário.`);
      else toast.info(r.skipped.length ? 'Nenhum termo novo. Veja os avisos na janela.' : 'Todos os funcionários ativos já têm o termo de aceite.');
      reload();
    } catch (e) { toast.error(errMsg(e)); } finally { setTermBusy(false); }
  };

  const upload = async (f: File | undefined) => {
    if (!f) return;
    setBusy(true);
    try {
      const fd = new FormData(); fd.append('file', f);
      const r = await api<{ competence: string; created: number; updated: number; terms: number; skipped: Array<{ name: string; reason: string }> }>('POST', `/api/payroll/periods/${periodId}/signatures`, fd);
      setSkipped(r.skipped);
      const n = r.created + r.updated;
      if (n) toast.success(`${plural(n, 'holerite pronto', 'holerites prontos')} para assinar (${refLabelPT(r.competence)})${r.terms ? ` e ${plural(r.terms, 'termo de aceite', 'termos de aceite')} para quem ainda não assinou o termo` : ''}. Agora envie o link a cada funcionário.`);
      else toast.warning('Nenhum holerite novo para assinatura. Veja os avisos na janela.');
      reload();
    } catch (e) { toast.error(errMsg(e)); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  };
  const linkOf = async (r: PayslipSignatureRow) => `${window.location.origin}/assinar/${(await get<{ token: string }>(`/api/payroll/signatures/${r.id}/link`)).token}`;
  const message = (r: PayslipSignatureRow, url: string) => (r.kind === 'term'
    ? `Olá, ${r.employeeName.split(' ')[0]}! A partir de agora os holerites serão assinados pelo celular. Para começar, leia e assine o termo de aceite: ${url}`
    : `Olá, ${r.employeeName.split(' ')[0]}! Seu holerite de ${refLabelPT(r.competence)} está disponível para conferir e assinar: ${url}`);
  const copy = async (r: PayslipSignatureRow) => {
    try { await navigator.clipboard.writeText(await linkOf(r)); toast.success(`Link de ${r.employeeName.split(' ')[0]} copiado`); } catch (e) { toast.error(errMsg(e)); }
  };
  const whats = async (r: PayslipSignatureRow) => {
    // abre a aba antes de buscar o link: depois de um await o navegador bloqueia a janela nova
    const w = window.open('', '_blank');
    try { const url = await linkOf(r); const href = `${whatsappLink(r.phone)}?text=${encodeURIComponent(message(r, url))}`; if (w) w.location.href = href; else window.location.href = href; }
    catch (e) { w?.close(); toast.error(errMsg(e)); }
  };
  const download = async (r: PayslipSignatureRow) => {
    try {
      const res = await api<Response>('GET', `/api/payroll/signatures/${r.id}/file`, undefined, { raw: true });
      downloadBlob(await res.blob(), `${what(r)} ${r.status === 'signed' ? 'assinado ' : ''}- ${r.employeeName}${r.kind === 'term' ? '' : ` - ${r.competence}`}.pdf`);
    } catch (e) { toast.error(errMsg(e)); }
  };
  const cancel = async (r: PayslipSignatureRow) => {
    if (!(await confirm({ title: 'Cancelar o envio?', body: `O link de ${r.employeeName} para de funcionar. Você pode ${r.kind === 'term' ? 'gerar o termo' : 'enviar o holerite'} de novo depois.`, confirmLabel: 'Cancelar envio', tone: 'danger' }))) return;
    try { await del(`/api/payroll/signatures/${r.id}`); reload(); } catch (e) { toast.error(errMsg(e)); }
  };
  const sendAccountant = async () => {
    setSending(true);
    try {
      const r = await post<{ sent: number }>('/api/payroll/signatures/send-accountant', { ids: toSend.map((x) => x.id), ...(needRecipient ? { recipientId: recipient } : {}) });
      toast.success(`${plural(r.sent, 'documento assinado enviado', 'documentos assinados enviados')} ao contador`);
      reload();
    } catch (e) { toast.error(errMsg(e)); } finally { setSending(false); }
  };

  const renderList = (list: PayslipSignatureRow[]) => (
          <ul className="flex flex-col divide-y divide-line rounded-xl border border-line">
            {list.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
                <div className="min-w-0 flex-1 basis-48">
                  <p className="truncate text-sm font-medium">{r.employeeName}</p>
                  <p className="text-xs text-muted">{r.kind === 'term' ? 'Termo de aceite de assinatura eletrônica' : <>Holerite de {refLabelPT(r.competence)} · líquido <span className="tnum">{formatBRL(r.net)}</span></>}</p>
                  {r.sentToAccountantAt && <p className="text-xs text-faint">Enviado ao contador em {when(r.sentToAccountantAt)}</p>}
                </div>
                {r.status === 'signed' ? <StatusChip status="paid" label={`Assinado em ${when(r.signedAt!)}`} />
                  : r.viewedAt ? <StatusChip status="soon" label="Abriu, falta assinar" /> : <StatusChip status="pending" label="Aguardando" />}
                <div className="flex items-center gap-1">
                  {r.status === 'pending' && canEdit && <>
                    {whatsappLink(r.phone) && <Button size="sm" variant="secondary" icon={<MessageCircle className="size-3.5" />} onClick={() => whats(r)}>WhatsApp</Button>}
                    <Button size="sm" variant={whatsappLink(r.phone) ? 'ghost' : 'secondary'} icon={<Copy className="size-3.5" />} onClick={() => copy(r)}>Copiar link</Button>
                  </>}
                  <IconButton label={r.status === 'signed' ? 'Baixar o documento assinado' : 'Baixar o documento'} onClick={() => download(r)}><Download className="size-4" /></IconButton>
                  {r.status === 'pending' && canEdit && <IconButton label="Cancelar o envio" tone="danger" onClick={() => cancel(r)}><X className="size-4" /></IconButton>}
                </div>
              </li>
            ))}
          </ul>
  );

  return (
    <Dialog open={open} onClose={onClose} size="lg" title="Assinatura dos holerites"
      description={`Folha de ${refLabelPT(refStr)}. Cada funcionário recebe um link pessoal, abre com o CPF, confere e assina no celular. Antes do primeiro holerite ele assina, uma vez, o termo de aceite.`}
      footer={<>
        {can('accounting.send') && toSend.length > 0 && (
          <div className="mr-auto flex flex-wrap items-center gap-2">
            {needRecipient && (
              <Select aria-label="Contador" className="w-auto min-w-44" value={recipient} onChange={(e) => setRecipient(e.target.value)}>
                <option value="">Para qual contador?</option>
                {accountants.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                <option value="all">Todos os contadores</option>
              </Select>
            )}
            <Button variant="secondary" loading={sending} disabled={needRecipient && !recipient} icon={<Send className="size-4" />} onClick={sendAccountant}>Enviar {plural(toSend.length, 'assinado', 'assinados')} ao contador</Button>
          </div>
        )}
        <Button variant="ghost" onClick={onClose}>Fechar</Button>
      </>}>
      <div className="flex flex-col gap-4">
        {canEdit && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed border-line-strong bg-surface-2/50 p-3.5">
            <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent"><PenLine className="size-5" /></span>
            <p className="min-w-0 flex-1 text-sm text-muted">Envie o <b className="text-ink">PDF dos holerites</b> que o contador manda. O sistema separa o holerite de cada funcionário (pela matrícula) e cria os links.</p>
            <input ref={input} type="file" accept="application/pdf,.pdf" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
            <Button variant="primary" className="max-sm:w-full" loading={busy} icon={<FileUp className="size-4" />} onClick={() => input.current?.click()}>Escolher o PDF</Button>
          </div>
        )}
        {skipped.length > 0 && (
          <div className="rounded-xl border border-warn/40 bg-warn/10 p-3.5 text-sm">
            <p className="flex items-center gap-2 font-medium"><AlertTriangle className="size-4 text-warn" />Ficaram de fora</p>
            <ul className="mt-1.5 flex flex-col gap-1 text-muted">{skipped.map((s) => <li key={s.name}><b className="font-medium text-ink">{s.name}</b>: {s.reason}.</li>)}</ul>
          </div>
        )}
        {(termRows.length > 0 || canEdit) && (
          <section className="flex flex-col gap-2">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="flex items-center gap-2 text-sm font-semibold"><FileSignature className="size-4 text-accent" />Termo de aceite</h3>
              <span className="text-xs text-faint">uma vez por funcionário{termRows.length ? ` · ${termRows.filter((t) => t.status === 'signed').length} de ${termRows.length} assinados` : ''}</span>
              {canEdit && <Button size="sm" variant="ghost" className="ml-auto" loading={termBusy} onClick={makeTerms}>Gerar para quem falta</Button>}
            </div>
            {!termRows.length ? <p className="rounded-xl border border-line p-3 text-sm text-muted">Nenhum termo gerado ainda. Ele é criado junto com o primeiro holerite de cada funcionário, ou pelo botão acima.</p>
              : termsShown.length > 0 ? renderList(termsShown) : null}
            {termsSigned > 0 && (
              <button type="button" className="self-start text-xs text-accent hover:underline" onClick={() => setShowSigned(!showSigned)}>
                {showSigned ? 'Esconder os termos já assinados' : `Ver ${plural(termsSigned, 'termo já assinado', 'termos já assinados')}`}
              </button>
            )}
          </section>
        )}
        <h3 className="flex items-center gap-2 text-sm font-semibold"><PenLine className="size-4 text-accent" />Holerites de {refLabelPT(refStr)}</h3>
        {q.isLoading ? <div className="grid place-items-center py-10"><Spinner /></div> : !rows.length ? (
          <Empty icon={<PenLine className="size-5" />} title="Nenhum holerite enviado para assinatura neste mês">Depois de enviar o PDF, os funcionários aparecem aqui com o link de cada um.</Empty>
        ) : (
          renderList(rows)
        )}
        <p className="text-xs text-faint">Assinado, o documento recebe a assinatura e a data no próprio campo e ganha uma página de comprovante (quem, quando, de qual aparelho); não pode mais ser alterado. O funcionário baixa a via dele pelo mesmo link.</p>
      </div>
    </Dialog>
  );
}
