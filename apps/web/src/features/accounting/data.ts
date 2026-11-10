import { useQuery } from '@tanstack/react-query';
import type { AccountingDetected, AccountingKind, AccountingStatus } from '@nopaper/shared';
import { get } from '@/lib/api';
import { useCan, useSession } from '@/lib/session';

export interface AccountingDoc {
  id: string; kind: AccountingKind; competence: string | null; note: string | null; originalName: string; mime: string; size: number;
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
  return can('accounting.upload') && !(['accounting.review', 'payable.view', 'receivable.view', 'cards.view', 'bank.view', 'payroll.view', 'reports.view'] as const).some(can);
}

export const accountingKey = (orgId: string | null, ...rest: unknown[]) => ['accounting', orgId, ...rest];

export function useAccountingDocs() {
  const orgId = useSession((s) => s.orgId);
  return useQuery({ queryKey: accountingKey(orgId, 'docs'), queryFn: () => get<{ items: AccountingDoc[] }>('/api/accounting/documents').then((r) => r.items), refetchInterval: 60_000 });
}

/** Documentos do contador esperando conferência (selo no menu e aviso no Início). Só para quem confere. */
export function useAccountingPending() {
  const orgId = useSession((s) => s.orgId);
  const can = useCan();
  const enabled = can('accounting.review');
  const q = useQuery({ enabled, queryKey: accountingKey(orgId, 'pending'), queryFn: () => get<{ pending: number }>('/api/accounting/summary').then((r) => r.pending), refetchInterval: 60_000 });
  return enabled ? q.data ?? 0 : 0;
}
