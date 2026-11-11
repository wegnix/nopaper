import { useQuery } from '@tanstack/react-query';
import type { AccountingDetected, AccountingDirection, AccountingKind, AccountingStatus } from '@nopaper/shared';
import { get } from '@/lib/api';
import { useCan, useSession } from '@/lib/session';

export interface AccountingDoc {
  id: string; direction: AccountingDirection; kind: AccountingKind; competence: string | null; note: string | null; originalName: string; mime: string; size: number;
  detected: AccountingDetected | null; status: AccountingStatus; billId: string | null; handledAt: string | null; handleNote: string | null;
  createdAt: string; uploadedByName: string | null; handledByName: string | null; mine: boolean;
  /** Tirado da lista de quem confere (o registro continua para quem enviou). `hiddenByMe` = cancelado por quem enviou. */
  hiddenAt: string | null; hiddenByMe: boolean;
  bill: { id: string; description: string; status: 'pending' | 'paid'; dueDate: string; amount: string } | null;
}

/**
 * Contador "puro": só envia documentos, não vê mais nada do espaço. Para ele o Início é a própria
 * área do contador (menu enxuto, sem busca).
 */
export function useAccountantOnly() {
  const can = useCan();
  return can('accounting.upload') && !(['accounting.review', 'accounting.send', 'payable.view', 'receivable.view', 'cards.view', 'bank.view', 'payroll.view', 'reports.view'] as const).some(can);
}

export const accountingKey = (orgId: string | null, ...rest: unknown[]) => ['accounting', orgId, ...rest];

/** `to_client` = o que o contador mandou para o espaço; `to_accountant` = o que o espaço mandou para o contador. */
export function useAccountingDocs(direction: AccountingDirection = 'to_client', enabled = true) {
  const orgId = useSession((s) => s.orgId);
  return useQuery({ enabled, queryKey: accountingKey(orgId, 'docs', direction), queryFn: () => get<{ items: AccountingDoc[] }>(`/api/accounting/documents?direction=${direction}`).then((r) => r.items), refetchInterval: 60_000 });
}

/** Selos do menu: `pending` = documentos do contador para conferir; `inbox` = o que o espaço mandou e o contador ainda não viu. */
function useAccountingSummary() {
  const orgId = useSession((s) => s.orgId);
  const can = useCan();
  const enabled = can('accounting.review') || can('accounting.upload');
  const q = useQuery({ enabled, queryKey: accountingKey(orgId, 'summary'), queryFn: () => get<{ pending: number; inbox: number }>('/api/accounting/summary'), refetchInterval: 60_000 });
  return enabled ? q.data ?? { pending: 0, inbox: 0 } : { pending: 0, inbox: 0 };
}
/** Documentos do contador esperando conferência (selo no menu e aviso no Início). Só para quem confere. */
export const useAccountingPending = () => useAccountingSummary().pending;
/** Arquivos que o espaço mandou e o contador ainda não viu (selo em "Recebidos"). */
export const useAccountingInbox = () => useAccountingSummary().inbox;
