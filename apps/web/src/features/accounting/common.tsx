import { Building2, FileText, Landmark, ReceiptText, UsersRound } from 'lucide-react';
import { ACCOUNTING_KIND_LABEL, refLabelPT, type AccountingKind } from '@nopaper/shared';
import type { AccountingDoc } from './data';

export const KIND_ICON: Record<AccountingKind, typeof FileText> = {
  payslip: UsersRound, office_fee: Building2, das: Landmark, darf: Landmark, dae: Landmark, state_tax: Landmark, other: FileText, invoice: ReceiptText,
};
export const sizeText = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
export const when = (iso: string) => { const d = new Date(iso); return `${d.toLocaleDateString('pt-BR')} às ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`; };
/** Texto sem acento/maiúsculas, para a busca. */
export const norm = (v: string) => v.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
/** Mês do envio (AAAA-MM, no horário de quem está vendo). */
export const sentMonth = (iso: string) => { const d = new Date(iso); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; };
export const docTitle = (d: Pick<AccountingDoc, 'kind' | 'competence'>) => `${ACCOUNTING_KIND_LABEL[d.kind]}${d.competence ? ` – ${refLabelPT(d.competence)}` : ''}`;
/** Dá para abrir no navegador (PDF e imagem); compactados e XML são só para baixar. */
export const canPreview = (mime: string) => mime === 'application/pdf' || mime.startsWith('image/');
/** `accept` do seletor de arquivos: com `archives`, também ZIP/RAR/7z/XML (envio ao contador). */
export const fileAccept = (archives: boolean) => `application/pdf,.pdf,image/png,image/jpeg,image/webp${archives ? ',.zip,.rar,.7z,.xml,application/zip,application/xml,text/xml' : ''}`;
/** Só os arquivos aceitos; `rejected` = quantos ficaram de fora. */
export function acceptFiles(list: FileList | File[] | null, current: File[], archives = false) {
  const all = [...(list ?? [])];
  const ext = archives ? /\.(pdf|png|jpe?g|webp|zip|rar|7z|xml)$/i : /\.(pdf|png|jpe?g|webp)$/i;
  const ok = all.filter((f) => /pdf|png|jpe?g|webp/i.test(f.type) || ext.test(f.name));
  return { files: [...current, ...ok.filter((f) => !current.some((x) => x.name === f.name && x.size === f.size))].slice(0, 20), rejected: all.length - ok.length };
}
