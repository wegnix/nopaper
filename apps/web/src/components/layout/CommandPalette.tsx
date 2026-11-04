import { Command } from 'cmdk';
import { useNavigate } from 'react-router';
import { Dialog as RDialog } from 'radix-ui';
import { Moon, Plus, Building2, FileSpreadsheet, Settings, Users, Shield } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useCan, useSession } from '@/lib/session';
import { useTheme } from '@/lib/theme';
import { NAV } from './nav';

export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const nav = useNavigate();
  const can = useCan();
  const { orgs, setOrg, orgId } = useSession();
  const theme = useTheme();
  const qc = useQueryClient();
  const go = (to: string) => { onClose(); nav(to); };
  const item = 'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm cursor-pointer data-[selected=true]:bg-surface-2 data-[selected=true]:text-ink text-muted';
  return (
    <RDialog.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-[7000] bg-[#05070d]/60 backdrop-blur-[2px]" />
        <RDialog.Content className="fixed left-1/2 top-[12vh] z-[7001] w-[min(640px,calc(100vw-24px))] -translate-x-1/2 overflow-hidden rounded-2xl border border-line bg-raised shadow-2xl">
          <RDialog.Title className="sr-only">Paleta de comandos</RDialog.Title>
          <RDialog.Description className="sr-only">Navegue e execute ações</RDialog.Description>
          <Command loop>
            <Command.Input autoFocus placeholder="O que você quer fazer?" className="h-14 w-full border-b border-line bg-transparent px-5 text-[15px] outline-none placeholder:text-faint" />
            <Command.List className="max-h-[50vh] overflow-y-auto p-2">
              <Command.Empty className="px-3 py-6 text-center text-sm text-faint">Nada encontrado.</Command.Empty>
              <Command.Group heading="Ações" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-faint">
                {can('payable.create') && <Command.Item className={item} onSelect={() => go('/pagar?nova=1')}><Plus className="size-4" /> Nova conta a pagar</Command.Item>}
                {can('receivable.create') && <Command.Item className={item} onSelect={() => go('/receber?nova=1')}><Plus className="size-4" /> Nova conta a receber</Command.Item>}
                {can('bills.import') && (can('payable.create') || can('receivable.create')) && <Command.Item className={item} value="importar planilha excel xlsx csv" onSelect={() => go('/importar')}><FileSpreadsheet className="size-4" /> Importar planilha</Command.Item>}
                <Command.Item className={item} onSelect={() => { theme.toggle(); onClose(); }}><Moon className="size-4" /> Alternar tema claro/escuro</Command.Item>
              </Command.Group>
              <Command.Group heading="Ir para" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-faint">
                {NAV.filter((n) => !n.perm || can(n.perm)).map((n) => (
                  <Command.Item key={n.to} className={item} onSelect={() => go(n.to)}><n.icon className="size-4" /> {n.label}</Command.Item>
                ))}
                <Command.Item className={item} onSelect={() => go('/config')}><Settings className="size-4" /> Configurações</Command.Item>
                {can('members.manage') && <Command.Item className={item} onSelect={() => go('/config/membros')}><Users className="size-4" /> Membros</Command.Item>}
                {can('groups.manage') && <Command.Item className={item} onSelect={() => go('/config/grupos')}><Shield className="size-4" /> Grupos e permissões</Command.Item>}
              </Command.Group>
              {orgs.length > 1 && (
                <Command.Group heading="Trocar de espaço" className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:text-faint">
                  {orgs.filter((o) => o.id !== orgId).map((o) => (
                    <Command.Item key={o.id} className={item} onSelect={() => { setOrg(o.id); qc.clear(); go('/'); }}><Building2 className="size-4" /> {o.name}</Command.Item>
                  ))}
                </Command.Group>
              )}
            </Command.List>
          </Command>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
