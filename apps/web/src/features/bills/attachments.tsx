import { useState, type ReactNode } from 'react';
import { Barcode, Check, Copy, FileText, QrCode, Receipt } from 'lucide-react';
import { toast } from 'sonner';
import type { AttachmentSlot } from '@nopaper/shared';
import { cn, copyText } from '@/lib/utils';
import { Tooltip } from '@/components/ui/base';
import type { Bill } from '@/lib/types';

export function CopyButton({ text, label = 'Copiar', className, toastMsg }: { text: string; label?: string; className?: string; toastMsg?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Tooltip content={done ? 'Copiado!' : label}>
      <button
        type="button"
        aria-label={label}
        onClick={async (e) => {
          e.stopPropagation();
          if (await copyText(text)) {
            setDone(true);
            if (toastMsg) toast.success(toastMsg);
            setTimeout(() => setDone(false), 1500);
          }
        }}
        className={cn('inline-grid place-items-center size-6 rounded text-faint hover:text-ink hover:bg-surface-2 transition-colors', className)}
      >
        {done ? <Check className="size-3.5 text-ok" /> : <Copy className="size-3.5" />}
      </button>
    </Tooltip>
  );
}

export const SLOT_META: Record<AttachmentSlot, { label: string; short: string; icon: typeof Barcode; tone: string }> = {
  boleto: { label: 'Boleto', short: 'Boleto', icon: Barcode, tone: 'text-sky-600 dark:text-sky-300 bg-sky-500/12 border-sky-500/30' },
  invoice: { label: 'Nota fiscal', short: 'NF', icon: FileText, tone: 'text-violet-600 dark:text-violet-300 bg-violet-500/12 border-violet-500/30' },
  payment_proof: { label: 'Comprovante', short: 'Compr.', icon: Receipt, tone: 'text-emerald-600 dark:text-emerald-300 bg-emerald-500/12 border-emerald-500/30' },
};
const pixTone = 'text-teal-600 dark:text-teal-300 bg-teal-500/12 border-teal-500/30';

function Pill({ tone, icon, children, onClick, title }: { tone: string; icon: ReactNode; children: ReactNode; onClick?: () => void; title?: string }) {
  const C = onClick ? 'button' : 'span';
  return (
    <C type={onClick ? 'button' : undefined} title={title} onClick={onClick}
      className={cn('inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium', tone, onClick && 'hover:brightness-110 cursor-pointer')}>
      {icon}{children}
    </C>
  );
}

export function AttachmentChips({ bill, onOpen }: { bill: Bill; onOpen: (slot: AttachmentSlot) => void }) {
  const a = bill.attachments;
  const items: ReactNode[] = [];
  if (bill.barcode || a.boleto) {
    items.push(
      <span key="b" className="inline-flex items-center">
        <Pill tone={SLOT_META.boleto.tone} icon={<Barcode className="size-3" />} onClick={a.boleto ? () => onOpen('boleto') : undefined} title={a.boleto ? 'Ver boleto' : 'Código de barras'}>Boleto</Pill>
        {bill.barcode && <CopyButton text={bill.barcode.replace(/\D/g, '')} label="Copiar código de barras" toastMsg="Código de barras copiado" />}
      </span>,
    );
  }
  if (bill.pixKey) {
    items.push(
      <span key="p" className="inline-flex items-center">
        <Pill tone={pixTone} icon={<QrCode className="size-3" />} title="PIX">Pix</Pill>
        <CopyButton text={bill.pixKey} label="Copiar PIX" toastMsg="PIX copiado" />
      </span>,
    );
  }
  if (a.invoice) items.push(<Pill key="i" tone={SLOT_META.invoice.tone} icon={<FileText className="size-3" />} onClick={() => onOpen('invoice')} title="Ver nota fiscal">NF</Pill>);
  if (a.payment_proof) items.push(<Pill key="c" tone={SLOT_META.payment_proof.tone} icon={<Receipt className="size-3" />} onClick={() => onOpen('payment_proof')} title="Ver comprovante">Compr.</Pill>);
  if (!items.length) return <span className="text-xs text-faint">—</span>;
  return <div className="flex flex-wrap items-center gap-1">{items}</div>;
}

export function attachmentCount(b: Bill) {
  return (b.barcode || b.attachments.boleto ? 1 : 0) + (b.pixKey ? 1 : 0) + (b.attachments.invoice ? 1 : 0) + (b.attachments.payment_proof ? 1 : 0);
}
