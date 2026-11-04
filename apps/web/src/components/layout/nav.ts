import { ArrowDownLeft, ArrowUpRight, BarChart3, CreditCard, LayoutDashboard, Settings, type LucideIcon } from 'lucide-react';
import type { Permission } from '@nopaper/shared';

export interface NavItem { to: string; label: string; icon: LucideIcon; perm?: Permission; soon?: boolean }
export const NAV: NavItem[] = [
  { to: '/', label: 'Início', icon: LayoutDashboard },
  { to: '/pagar', label: 'Contas a pagar', icon: ArrowUpRight, perm: 'payable.view' },
  { to: '/receber', label: 'Contas a receber', icon: ArrowDownLeft, perm: 'receivable.view' },
  { to: '/cartoes', label: 'Cartões', icon: CreditCard, perm: 'cards.view' },
  { to: '/relatorios', label: 'Relatórios', icon: BarChart3, perm: 'reports.view' },
];
export const NAV_BOTTOM: NavItem[] = [{ to: '/config', label: 'Configurações', icon: Settings }];
