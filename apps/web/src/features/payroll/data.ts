import { useQuery } from '@tanstack/react-query';
import type { PayrollKind, PayrollSection, PayrollSettings } from '@nopaper/shared';
import { get } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Bill } from '@/lib/types';

export interface Employee {
  id: string; name: string; document: string | null; role: string | null; admissionDate: string | null; terminationDate: string | null;
  active: boolean; pixKey: string | null; bankInfo: string | null; notes: string | null; months: number; lastRef: string | null;
}
export interface Rubric { id: string; name: string; section: PayrollSection; kind: PayrollKind; fixed: boolean; active: boolean; sortOrder: number; usage: number }
export interface PayrollMeta { settings: PayrollSettings; rubrics: Rubric[]; employees: Employee[] }
export interface PeriodSummary {
  id: string; ref: string; payDate: string; billsEnabled: boolean; imported: boolean; employees: number;
  total: string; offPayroll: string; payslipNet: string; employerCost: string; companyCost: string; paid: number; bills: number;
}
export interface EntryLine { rubricId: string; amount: string; note: string | null }
export interface Entry {
  id: string; periodId: string; employeeId: string; payslipNet: string; total: string; offPayroll: string; employerCost: string; companyCost: string;
  notes: string | null; billId: string | null; lines: EntryLine[]; bill: Bill | null;
}
export interface Period { id: string; ref: string; payDate: string; billsEnabled: boolean; notes: string | null; importBatchId: string | null }
export interface MonthView { period: Period | null; suggestedPayDate: string | null; entries: Entry[] }

/** Tudo da folha fica sob a chave 'bills' para ser invalidado junto com Contas a pagar. */
export const payrollKey = (orgId: string | null, ...rest: unknown[]) => ['bills', orgId, 'payroll', ...rest];

export function usePayrollMeta() {
  const orgId = useSession((s) => s.orgId);
  return useQuery({ queryKey: payrollKey(orgId, 'meta'), queryFn: () => get<PayrollMeta>('/api/payroll/meta') });
}
export function usePeriods() {
  const orgId = useSession((s) => s.orgId);
  return useQuery({ queryKey: payrollKey(orgId, 'periods'), queryFn: () => get<{ items: PeriodSummary[] }>('/api/payroll/periods').then((r) => r.items) });
}
export function useMonth(ref: string) {
  const orgId = useSession((s) => s.orgId);
  return useQuery({ queryKey: payrollKey(orgId, 'month', ref), queryFn: () => get<MonthView>(`/api/payroll/month/${ref}`), placeholderData: (p) => p });
}

export const SECTION_HINT = {
  payslip: 'Valores do holerite do contador. Se detalhar aqui, o líquido é calculado.',
  extra: 'Pago fora do holerite: metas, comissões, vitaminas, hora extra… e descontos de produtos/vales.',
  employer: 'Custo da empresa (FGTS etc.). Não entra no valor pago ao funcionário.',
} as const;
