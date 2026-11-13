import { ArrowDownLeft, ArrowUpRight, BarChart3, CreditCard, FileUp, Inbox, Landmark, LayoutDashboard, Settings, UsersRound, type LucideIcon } from 'lucide-react';
import { billNames, type Permission } from '@nopaper/shared';

/** `companyOnly`: só aparece em espaço do tipo Empresa. */
/** `anyPerm`: aparece para quem tem qualquer uma das permissões. */
export interface NavItem { to: string; label: string; icon: LucideIcon; perm?: Permission; anyPerm?: Permission[]; soon?: boolean; companyOnly?: boolean }
export const NAV: NavItem[] = [
  { to: '/', label: 'Início', icon: LayoutDashboard },
  { to: '/pagar', label: 'Contas a pagar', icon: ArrowUpRight, perm: 'payable.view' },
  { to: '/receber', label: 'Contas a receber', icon: ArrowDownLeft, perm: 'receivable.view' },
  { to: '/cartoes', label: 'Cartões', icon: CreditCard, perm: 'cards.view' },
  { to: '/bancos', label: 'Contas bancárias', icon: Landmark, perm: 'bank.view' },
  { to: '/folha', label: 'Folha de pagamento', icon: UsersRound, perm: 'payroll.view', companyOnly: true },
  { to: '/contador', label: 'Contador', icon: FileUp, anyPerm: ['accounting.upload', 'accounting.review', 'accounting.send'] },
  { to: '/relatorios', label: 'Relatórios', icon: BarChart3, perm: 'reports.view' },
];
/** Só no menu do contador: o que o espaço mandou para ele. */
export const NAV_ACCOUNTANT_INBOX: NavItem = { to: '/recebidos', label: 'Recebidos', icon: Inbox };
export const NAV_BOTTOM: NavItem[] = [{ to: '/config', label: 'Configurações', icon: Settings }];

/** Nome do item neste espaço: no Pessoal as contas viram Despesas / Receitas. */
export const navLabel = (i: NavItem, kind: string | undefined) =>
  (i.to === '/pagar' ? billNames('payable', kind).title : i.to === '/receber' ? billNames('receivable', kind).title : i.label);

/** Item visível para a pessoa neste espaço. */
export const navVisible = (i: NavItem, can: (p: Permission) => boolean, kind: 'personal' | 'company' | undefined) =>
  (!i.perm || can(i.perm)) && (!i.anyPerm || i.anyPerm.some(can)) && (!i.companyOnly || kind === 'company');
