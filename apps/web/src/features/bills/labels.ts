import { diffDaysISO, type BillType } from '@nopaper/shared';
import type { DisplayStatus } from '@/components/ui/chips';
import type { Bill } from '@/lib/types';

/** Palavras por tipo de conta. O nome da tela e do botão "Nova…" depende do perfil do espaço: `useBillNames`. */
export const L = {
  payable: {
    paid: 'Paga', paidPl: 'Pagas', payAction: 'Pagar',
    paidAt: 'Pago em', paidKpi: 'Pago no mês', markPaid: 'Marcar como paga', confirmPay: 'Confirmar pagamento', paidAmount: 'Valor pago',
    overdue: 'Vencida', overduePl: 'Vencidas', unpay: 'Reverter pagamento', person: 'Pessoa relacionada', bulk: 'Pagar selecionadas',
  },
  receivable: {
    paid: 'Recebida', paidPl: 'Recebidas', payAction: 'Receber',
    paidAt: 'Recebido em', paidKpi: 'Recebido no mês', markPaid: 'Marcar como recebida', confirmPay: 'Confirmar recebimento', paidAmount: 'Valor recebido',
    overdue: 'Atrasada', overduePl: 'Atrasadas', unpay: 'Reverter recebimento', person: 'Cliente / pagador', bulk: 'Receber selecionadas',
  },
} as const satisfies Record<BillType, Record<string, string>>;

export function displayStatus(b: Pick<Bill, 'status' | 'dueDate' | 'type'>, today: string): { status: DisplayStatus; label: string } {
  const l = L[b.type];
  if (b.status === 'paid') return { status: 'paid', label: l.paid };
  const d = diffDaysISO(b.dueDate, today);
  if (d < 0) return { status: 'overdue', label: d === -1 ? `${l.overdue} ontem` : `${l.overdue} há ${-d}d` };
  if (d === 0) return { status: 'today', label: 'Vence hoje' };
  if (d <= 3) return { status: 'soon', label: d === 1 ? 'Vence amanhã' : `Vence em ${d}d` };
  return { status: 'pending', label: 'Pendente' };
}

export const RECURRENCE_LABEL = { once: 'Única', weekly: 'Semanal', biweekly: 'Quinzenal', monthly: 'Mensal', yearly: 'Anual', installments: 'Parcelada' } as const;
