import { ArrowDownLeft, ArrowUpRight, BarChart3, CreditCard, LayoutDashboard, Settings, UsersRound, type LucideIcon } from 'lucide-react';
import type { Permission } from '@nopaper/shared';

/** `companyOnly`: só aparece em espaço do tipo Empresa. */
export interface NavItem { to: string; label: string; icon: LucideIcon; perm?: Permission; soon?: boolean; companyOnly?: boolean }
export const NAV: NavItem[] = [
  { to: '/', label: 'Início', icon: LayoutDashboard },
  { to: '/pagar', label: 'Contas a pagar', icon: ArrowUpRight, perm: 'payable.view' },
  { to: '/receber', label: 'Contas a receber', icon: ArrowDownLeft, perm: 'receivable.view' },
  { to: '/cartoes', label: 'Cartões', icon: CreditCard, perm: 'cards.view' },
  { to: '/folha', label: 'Folha de pagamento', icon: UsersRound, perm: 'payroll.view', companyOnly: true },
  { to: '/relatorios', label: 'Relatórios', icon: BarChart3, perm: 'reports.view' },
];
export const NAV_BOTTOM: NavItem[] = [{ to: '/config', label: 'Configurações', icon: Settings }];

/** Item visível para a pessoa neste espaço. */
export const navVisible = (i: NavItem, can: (p: Permission) => boolean, kind: 'personal' | 'company' | undefined) =>
  (!i.perm || can(i.perm)) && (!i.companyOnly || kind === 'company');
