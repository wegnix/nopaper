import { useQuery } from '@tanstack/react-query';
import type { OfxStatement } from '@nopaper/shared';
import { get } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Bill } from '@/lib/types';

export interface BankAccount {
  id: string; name: string; bankCode: string | null; branch: string | null; accountNumber: string | null; kind: 'checking' | 'savings' | 'other';
  color: string; active: boolean; notes: string | null; balance: string | null; balanceDate: string | null;
  pending: number; transactions: number; lastDate: string | null;
}
export interface BankTx {
  id: string; accountId: string; importId: string | null; fitId: string; postedAt: string; amount: string; trnType: string | null;
  memo: string | null; name: string | null; refNum: string | null; checkNum: string | null;
  status: 'pending' | 'linked' | 'ignored'; action: 'paid' | 'matched' | 'created' | null; billId: string | null;
  bill: Bill | null; hiddenBill: boolean;
}
export interface ReconcileView { account: BankAccount; transactions: BankTx[]; candidates: Bill[] }
export interface ReadStatement extends OfxStatement {
  account: { id: string; name: string; active: boolean } | null; duplicates: number;
  suggested: { name: string; bankCode: string | null; branch: string | null; accountNumber: string | null; kind: BankAccount['kind'] };
}
export interface BankImportRow { id: string; accountId: string; fileName: string; from: string | null; to: string | null; txCount: number; newCount: number; createdAt: string; createdByName: string | null; linked: number }

/** Tudo do extrato fica sob 'bills' para ser invalidado junto com as contas. */
export const bankKey = (orgId: string | null, ...rest: unknown[]) => ['bills', orgId, 'bank', ...rest];

export function useBankAccounts() {
  const orgId = useSession((s) => s.orgId);
  return useQuery({ queryKey: bankKey(orgId, 'accounts'), queryFn: () => get<{ items: BankAccount[] }>('/api/bank/accounts').then((r) => r.items) });
}
export function useReconcile(accountId: string | null, from: string, to: string) {
  const orgId = useSession((s) => s.orgId);
  return useQuery({
    enabled: !!accountId, queryKey: bankKey(orgId, 'reconcile', accountId, from, to),
    queryFn: () => get<ReconcileView>(`/api/bank/accounts/${accountId}/reconcile?from=${from}&to=${to}`), placeholderData: (p) => p,
  });
}
export function useBankImports(accountId: string | null, enabled: boolean) {
  const orgId = useSession((s) => s.orgId);
  return useQuery({ enabled: enabled && !!accountId, queryKey: bankKey(orgId, 'imports', accountId), queryFn: () => get<{ items: BankImportRow[] }>(`/api/bank/imports?accountId=${accountId}`).then((r) => r.items) });
}
