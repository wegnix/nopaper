import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import type { PayrollKind, PayrollSection, PayrollSettings } from '@nopaper/shared';
import { errMsg, get, put } from '@/lib/api';
import { useSession } from '@/lib/session';
import type { Bill } from '@/lib/types';

export interface Employee {
  id: string; name: string; document: string | null; role: string | null; admissionDate: string | null; terminationDate: string | null;
  active: boolean; pixKey: string | null; phone: string | null; bankInfo: string | null; notes: string | null; months: number; lastRef: string | null;
}
export interface Rubric { id: string; name: string; section: PayrollSection; kind: PayrollKind; fixed: boolean; active: boolean; sortOrder: number; usage: number }
export interface PayrollMeta { settings: PayrollSettings; rubrics: Rubric[]; employees: Employee[] }
export interface PeriodSummary {
  id: string; ref: string; payDate: string; billsEnabled: boolean; imported: boolean; employees: number;
  total: string; offPayroll: string; payslipNet: string; employerCost: string; companyCost: string; paid: number; bills: number;
}
export interface EntryLine { rubricId: string; amount: string; note: string | null }
export interface Entry {
  id: string; periodId: string; employeeId: string; payslipNet: string; payslipNetDeclared: string | null; total: string; offPayroll: string; employerCost: string; companyCost: string;
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
  payslip: 'Vencimentos e descontos do holerite. INSS e IRRF descontados saem do salário do funcionário (a empresa só repassa ao governo). As bases do rodapé (Base INSS, Base FGTS, Base IRRF) não se lançam.',
  extra: 'Pago fora do holerite: metas, comissões, vitaminas, hora extra… e descontos de produtos/vales.',
  employer: 'Benefícios pagos pela empresa (vale-alimentação, parte da empresa no VT, plano de saúde…). FGTS, INSS patronal, 13º e férias são calculados sozinhos.',
} as const;

/**
 * Troca a rubrica `r` de lugar com a vizinha em `visible` (a lista mostrada na tela, já na ordem).
 * A tela muda na hora (cache) e o servidor grava a ordem completa.
 */
export function useRubricMove() {
  const qc = useQueryClient();
  const orgId = useSession((s) => s.orgId);
  return async (all: Rubric[], visible: Rubric[], r: Rubric, dir: -1 | 1) => {
    const other = visible[visible.indexOf(r) + dir];
    if (!other) return;
    const ids = all.map((x) => x.id);
    const a = ids.indexOf(r.id), b = ids.indexOf(other.id);
    [ids[a], ids[b]] = [ids[b], ids[a]];
    qc.setQueryData<PayrollMeta>(payrollKey(orgId, 'meta'), (m) => m && { ...m, rubrics: ids.map((id, i) => ({ ...m.rubrics.find((x) => x.id === id)!, sortOrder: i })) });
    try { await put('/api/payroll/rubrics/order', { ids }); } catch (e) { toast.error(errMsg(e)); }
    qc.invalidateQueries({ queryKey: payrollKey(orgId, 'meta') });
  };
}
