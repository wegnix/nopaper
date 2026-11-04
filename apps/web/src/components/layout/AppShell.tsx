import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { AnimatePresence, motion } from 'motion/react';
import { DropdownMenu } from 'radix-ui';
import { Building2, Check, ChevronsUpDown, LogOut, Menu, Moon, PanelLeftClose, PanelLeftOpen, Plus, Search, Sun, User, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useSession, useOrg, useCan } from '@/lib/session';
import { useTheme } from '@/lib/theme';
import { cn } from '@/lib/utils';
import { Tooltip } from '@/components/ui/base';
import { useSidebar } from '@/lib/sidebar';
import { endSession, useIdleLogout } from '@/lib/idle';
import { Logo } from './Logo';
import { NAV, NAV_BOTTOM, type NavItem } from './nav';
import { CommandPalette } from './CommandPalette';
import { NewOrgDialog } from './NewOrgDialog';

function NavItems({ items, onNavigate, collapsed }: { items: NavItem[]; onNavigate?: () => void; collapsed?: boolean }) {
  const can = useCan();
  return (
    <>
      {items.filter((i) => !i.perm || can(i.perm)).map((i) => (
        <Tooltip key={i.to} content={collapsed ? i.label : null} side="right">
          <NavLink
            to={i.to} end={i.to === '/'} onClick={onNavigate} aria-label={collapsed ? i.label : undefined}
            className={({ isActive }) => cn(
              'group relative flex items-center gap-3 rounded-lg px-[11px] h-10 text-sm font-medium transition-colors',
              isActive ? 'text-ink bg-surface-2' : 'text-muted hover:text-ink hover:bg-surface-2/60',
            )}
          >
            {({ isActive }) => (
              <>
                {isActive && <motion.span layoutId="nav-active" className="absolute left-0 top-2 bottom-2 w-[3px] rounded-full bg-accent" transition={{ type: 'spring', stiffness: 500, damping: 40 }} />}
                <i.icon className={cn('size-[18px] shrink-0', isActive && 'text-accent')} />
                <span className={cn('flex-1 truncate whitespace-nowrap transition-opacity duration-150', collapsed && 'opacity-0')}>{i.label}</span>
                {i.soon && !collapsed && <span className="rounded px-1.5 text-[10px] font-semibold text-faint border border-line">em breve</span>}
              </>
            )}
          </NavLink>
        </Tooltip>
      ))}
    </>
  );
}

function OrgSwitcher({ onNew, collapsed }: { onNew: () => void; collapsed?: boolean }) {
  const { orgs, setOrg } = useSession();
  const canCreate = useSession((s) => !!(s.user?.isSuperadmin || s.user?.canCreateOrgs));
  const org = useOrg();
  const qc = useQueryClient();
  const nav = useNavigate();
  return (
    <DropdownMenu.Root>
      <Tooltip content={collapsed ? `${org?.name} · trocar de espaço` : null} side="right">
        <DropdownMenu.Trigger className={cn(
          'w-full flex items-center gap-3 rounded-xl border border-line bg-surface-2 text-left hover:border-line-strong transition-colors',
          collapsed ? 'p-[3px]' : 'px-2.5 py-2',
        )}>
          <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent font-display font-semibold">
            {org?.name.slice(0, 1).toUpperCase()}
          </span>
          {!collapsed && <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{org?.name}</span>
              <span className="block text-xs text-faint">{org?.kind === 'personal' ? 'Pessoal' : 'Empresa'}</span>
            </span>
            <ChevronsUpDown className="size-4 shrink-0 text-faint" />
          </>}
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" side={collapsed ? 'right' : 'bottom'} sideOffset={6} className="z-[6000] w-[260px] rounded-xl border border-line bg-raised p-1.5 shadow-2xl">
          <DropdownMenu.Label className="px-2 py-1.5 text-xs text-faint">Seus espaços</DropdownMenu.Label>
          {orgs.map((o) => (
            <DropdownMenu.Item
              key={o.id}
              onSelect={() => { setOrg(o.id); qc.clear(); nav('/'); }}
              className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm outline-none data-[highlighted]:bg-surface-2 cursor-pointer"
            >
              <Building2 className="size-4 text-faint" />
              <span className="flex-1 truncate">{o.name}</span>
              {o.id === org?.id && <Check className="size-4 text-accent" />}
            </DropdownMenu.Item>
          ))}
          {canCreate && <>
            <DropdownMenu.Separator className="my-1 h-px bg-line" />
            <DropdownMenu.Item onSelect={onNew} className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm outline-none data-[highlighted]:bg-surface-2 cursor-pointer">
              <Plus className="size-4 text-faint" /> Criar novo espaço
            </DropdownMenu.Item>
          </>}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function SidebarContent({ onNavigate, onNewOrg, collapsed, onToggle }: { onNavigate?: () => void; onNewOrg: () => void; collapsed?: boolean; onToggle?: () => void }) {
  return (
    <div className="flex h-full flex-col gap-5 px-3 py-4">
      <div className="px-[6px] pt-1 overflow-hidden"><Logo textClassName={cn('transition-opacity duration-150', collapsed && 'opacity-0')} /></div>
      <OrgSwitcher onNew={onNewOrg} collapsed={collapsed} />
      <nav className="flex flex-col gap-0.5"><NavItems items={NAV} onNavigate={onNavigate} collapsed={collapsed} /></nav>
      <div className="mt-auto flex flex-col gap-0.5">
        <NavItems items={NAV_BOTTOM} onNavigate={onNavigate} collapsed={collapsed} />
        {onToggle && (
          <Tooltip content={collapsed ? 'Expandir menu (Ctrl+B)' : 'Recolher menu (Ctrl+B)'} side="right">
            <button
              type="button" onClick={onToggle} aria-label={collapsed ? 'Expandir menu' : 'Recolher menu'} aria-expanded={!collapsed}
              className="flex h-10 items-center gap-3 rounded-lg px-[11px] text-sm font-medium text-faint hover:text-ink hover:bg-surface-2/60 transition-colors"
            >
              {collapsed ? <PanelLeftOpen className="size-[18px] shrink-0" /> : <PanelLeftClose className="size-[18px] shrink-0" />}
              <span className={cn('flex-1 truncate whitespace-nowrap text-left transition-opacity duration-150', collapsed && 'opacity-0')}>Recolher menu</span>
            </button>
          </Tooltip>
        )}
        <p className={cn('px-[11px] pt-1 text-[11px] text-faint tnum whitespace-nowrap transition-opacity duration-150', collapsed && 'opacity-0')} title={`NoPaper versão ${__APP_VERSION__}`}>NoPaper v{__APP_VERSION__}</p>
      </div>
    </div>
  );
}

export function AppShell() {
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const [newOrg, setNewOrg] = useState(false);
  const { collapsed, toggle: toggleSidebar } = useSidebar();
  const { user } = useSession();
  const { theme, toggle } = useTheme();
  const loc = useLocation();
  const nav = useNavigate();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPalette((v) => !v); }
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') { e.preventDefault(); useSidebar.getState().toggle(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  useEffect(() => setDrawer(false), [loc.pathname]);
  // servidor atualizado e este front ainda é o antigo (aba aberta ou PWA em cache): oferece recarregar
  const serverVersion = useSession((s) => s.serverVersion);
  useEffect(() => {
    if (!serverVersion || serverVersion === __APP_VERSION__) return;
    toast.info(`Nova versão do NoPaper disponível (v${serverVersion}).`, {
      id: 'np-update', duration: Infinity, action: { label: 'Recarregar', onClick: () => window.location.reload() },
    });
  }, [serverVersion]);

  useIdleLogout();
  const logout = async () => {
    await endSession();
    nav('/login');
  };

  return (
    <div className="safe-x flex h-dvh overflow-hidden">
      <aside className={cn('sidebar-glow relative hidden lg:block shrink-0 overflow-hidden border-r border-line transition-[width] duration-200 ease-out', collapsed ? 'w-16' : 'w-[220px]')}>
        <SidebarContent onNewOrg={() => setNewOrg(true)} collapsed={collapsed} onToggle={toggleSidebar} />
      </aside>

      <AnimatePresence>
        {drawer && (
          <>
            <motion.div className="fixed inset-0 z-[4500] bg-black/50 lg:hidden" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => setDrawer(false)} />
            <motion.aside
              className="sidebar-glow safe-top safe-bottom fixed inset-y-0 left-0 z-[4501] w-[min(280px,85vw)] border-r border-line lg:hidden"
              style={{ paddingLeft: 'env(safe-area-inset-left)' }}
              initial={{ x: -320 }} animate={{ x: 0 }} exit={{ x: -320 }} transition={{ type: 'spring', stiffness: 400, damping: 38 }}
            >
              <div className="relative h-full overflow-y-auto">
                <button className="absolute right-2 top-2.5 grid size-10 place-items-center rounded-lg text-muted hover:bg-surface-2" onClick={() => setDrawer(false)} aria-label="Fechar menu"><X className="size-5" /></button>
                <SidebarContent onNavigate={() => setDrawer(false)} onNewOrg={() => setNewOrg(true)} />
              </div>
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="safe-top shrink-0 border-b border-line">
         <div className="flex h-14 md:h-16 items-center gap-2 md:gap-3 px-2 sm:px-4 md:px-6">
          <button className="lg:hidden grid size-11 shrink-0 place-items-center rounded-lg text-muted hover:bg-surface-2 active:bg-surface-2" onClick={() => setDrawer(true)} aria-label="Abrir menu"><Menu className="size-6" /></button>
          <button
            onClick={() => setPalette(true)}
            className="flex h-10 min-w-0 flex-1 max-w-md items-center gap-2 rounded-lg border border-line bg-surface-2 px-3 text-sm text-faint hover:border-line-strong transition-colors"
          >
            <Search className="size-4 shrink-0" />
            <span className="flex-1 truncate text-left">Buscar ou ir para…</span>
            <kbd className="hidden sm:inline rounded border border-line px-1.5 text-[11px]">Ctrl K</kbd>
          </button>
          <div className="ml-auto flex shrink-0 items-center gap-0.5 sm:gap-1">
            <button onClick={toggle} className="grid size-11 sm:size-9 place-items-center rounded-lg text-muted hover:text-ink hover:bg-surface-2" aria-label="Alternar tema">
              {theme === 'dark' ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
            </button>
            <DropdownMenu.Root>
              <DropdownMenu.Trigger className="flex h-11 sm:h-auto items-center gap-2 rounded-lg px-1.5 sm:pl-1 sm:pr-2 py-1 hover:bg-surface-2" aria-label="Menu da conta">
                <span className="grid size-8 place-items-center rounded-full bg-accent text-accent-ink text-sm font-semibold">{user?.name.slice(0, 1).toUpperCase()}</span>
                <span className="hidden md:block text-sm font-medium max-w-[140px] truncate">{user?.name.split(' ')[0]}</span>
              </DropdownMenu.Trigger>
              <DropdownMenu.Portal>
                <DropdownMenu.Content align="end" sideOffset={6} className="z-[6000] w-56 rounded-xl border border-line bg-raised p-1.5 shadow-2xl">
                  <div className="px-2 py-1.5"><p className="text-sm font-medium truncate">{user?.name}</p><p className="text-xs text-faint truncate">{user?.email}</p></div>
                  <DropdownMenu.Separator className="my-1 h-px bg-line" />
                  <DropdownMenu.Item onSelect={() => nav('/config/perfil')} className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm outline-none data-[highlighted]:bg-surface-2 cursor-pointer"><User className="size-4 text-faint" /> Meu perfil</DropdownMenu.Item>
                  <DropdownMenu.Item onSelect={logout} className="flex items-center gap-2 rounded-lg px-2 py-2 text-sm text-danger outline-none data-[highlighted]:bg-surface-2 cursor-pointer"><LogOut className="size-4" /> Sair</DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu.Portal>
            </DropdownMenu.Root>
          </div>
         </div>
        </header>
        <main className="safe-bottom flex-1 overflow-y-auto overscroll-contain">
          <motion.div key={loc.pathname.split('/')[1]} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.22, ease: 'easeOut' }} className="w-full px-3 py-4 sm:px-4 md:px-5 md:py-5 lg:px-6 lg:py-6">
            <Outlet />
          </motion.div>
        </main>
      </div>
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <NewOrgDialog open={newOrg} onClose={() => setNewOrg(false)} />
    </div>
  );
}
