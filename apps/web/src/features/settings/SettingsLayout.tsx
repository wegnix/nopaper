import { NavLink, Outlet, Navigate, useLocation, useNavigate } from 'react-router';
import { ArrowUpCircle, Bell, ChevronDown, Building2, DatabaseBackup, History, KeyRound, LockKeyhole, Mail, ScrollText, Shield, User, UserCog, Users } from 'lucide-react';
import { useCan, useSession } from '@/lib/session';
import { PageHeader } from '@/components/ui/base';
import { cn } from '@/lib/utils';
import type { Permission } from '@nopaper/shared';

interface Item { to: string; label: string; icon: typeof User; perm?: Permission }
const SECTIONS: Array<{ title: string; superadmin?: boolean; items: Item[] }> = [
  { title: 'Conta', items: [{ to: 'perfil', label: 'Meu perfil', icon: User }] },
  {
    title: 'Espaço', items: [
      { to: 'organizacao', label: 'Configuração do espaço', icon: Building2, perm: 'org.settings' },
      { to: 'membros', label: 'Membros', icon: Users, perm: 'members.manage' },
      { to: 'grupos', label: 'Grupos e permissões', icon: Shield, perm: 'groups.manage' },
      { to: 'alertas', label: 'Alertas', icon: Bell, perm: 'alerts.manage' },
      { to: 'integracoes', label: 'Integrações', icon: KeyRound, perm: 'integrations.manage' },
      { to: 'auditoria', label: 'Auditoria', icon: History, perm: 'audit.view' },
    ],
  },
  {
    title: 'Plataforma', superadmin: true, items: [
      { to: 'plataforma/usuarios', label: 'Usuários', icon: UserCog },
      { to: 'plataforma/backups', label: 'Backups e restauração', icon: DatabaseBackup },
      { to: 'plataforma/notificacoes', label: 'E-mail e Telegram', icon: Mail },
      { to: 'plataforma/seguranca', label: 'Segurança', icon: LockKeyhole },
      { to: 'plataforma/atualizacoes', label: 'Atualizações', icon: ArrowUpCircle },
      { to: 'plataforma/auditoria', label: 'Auditoria da plataforma', icon: ScrollText },
    ],
  },
];

export function SettingsLayout() {
  const can = useCan();
  const isSuper = useSession((s) => !!s.user?.isSuperadmin);
  const sections = SECTIONS.filter((s) => !s.superadmin || isSuper)
    .map((s) => ({ ...s, items: s.items.filter((i) => !i.perm || can(i.perm)) }))
    .filter((s) => s.items.length);
  const loc = useLocation();
  const nav = useNavigate();
  const current = sections.flatMap((s) => s.items).find((i) => loc.pathname.startsWith(`/config/${i.to}`));
  const CurIcon = current?.icon ?? User;
  return (
    <div className="flex flex-col gap-4 sm:gap-6">
      <PageHeader title="Configurações" />
      <div className="grid gap-4 sm:gap-6 lg:grid-cols-[220px_1fr]">
        {/* celular/tablet: lista suspensa com as seções (a fileira de abas não cabia e escondia itens) */}
        <label className="relative lg:hidden">
          <span className="sr-only">Seção das configurações</span>
          <CurIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-accent" />
          <select
            value={current?.to ?? ''} onChange={(e) => nav(e.target.value)}
            className="h-11 w-full appearance-none rounded-lg border border-line bg-surface pl-9 pr-9 text-sm font-medium text-ink shadow-card focus:border-accent focus:outline-none"
          >
            {sections.map((s) => (
              <optgroup key={s.title} label={s.title}>
                {s.items.map((i) => <option key={i.to} value={i.to}>{i.label}</option>)}
              </optgroup>
            ))}
          </select>
          <ChevronDown className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
        </label>
        <nav className="hidden lg:flex lg:flex-col gap-1 lg:gap-5">
          {sections.map((s) => (
            <div key={s.title} className="flex lg:flex-col gap-1 shrink-0">
              <p className="hidden lg:block px-3 pb-1 text-[11px] font-semibold uppercase tracking-wide text-faint">{s.title}</p>
              {s.items.map((i) => (
                <NavLink key={i.to} to={i.to} className={({ isActive }) => cn('flex items-center gap-2.5 rounded-lg px-3 h-10 text-sm font-medium whitespace-nowrap transition-colors', isActive ? 'bg-accent-soft text-accent font-semibold shadow-[inset_3px_0_0_var(--np-accent)]' : 'text-muted hover:text-ink hover:bg-surface-2')}>
                  <i.icon className="size-4" />{i.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="min-w-0"><Outlet /></div>
      </div>
    </div>
  );
}
export const SettingsIndex = () => <Navigate to="perfil" replace />;
