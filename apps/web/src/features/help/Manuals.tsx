import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BookOpen, CircleHelp } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import type { ManualInfo } from '@nopaper/shared';
import { Tooltip } from '@/components/ui/base';
import { get } from '@/lib/api';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/utils';
import { FileViewer, type FileViewerTarget } from '@/features/bills/FileViewer';

/** Manuais que aparecem para a pessoa no espaço atual. */
export function useManuals() {
  const orgId = useSession((s) => s.orgId);
  return useQuery({ queryKey: ['manuals', orgId], staleTime: 5 * 60_000, queryFn: () => get<{ items: ManualInfo[] }>('/api/manuals').then((r) => r.items) });
}

/**
 * "?" do cabeçalho: abre o manual da pessoa no visualizador (com Baixar e Imprimir). Um manual só abre
 * direto; mais de um mostra a lista. Sem manual para a pessoa, o botão não aparece.
 */
export function HelpButton({ className }: { className?: string }) {
  const manuals = useManuals().data ?? [];
  const [viewer, setViewer] = useState<FileViewerTarget | null>(null);
  if (!manuals.length) return null;
  const open = (m: ManualInfo) => setViewer({ urlPath: `/api/manuals/${m.id}/url`, label: 'Manual', title: m.title });
  const cls = cn('grid place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-ink', className);
  return (
    <>
      {manuals.length === 1 ? (
        <Tooltip content={manuals[0]!.title}>
          <button type="button" className={cls} aria-label={`Ajuda: ${manuals[0]!.title}`} onClick={() => open(manuals[0]!)}><CircleHelp className="size-[18px]" /></button>
        </Tooltip>
      ) : (
        <DropdownMenu.Root>
          <DropdownMenu.Trigger className={cls} aria-label="Ajuda: manuais"><CircleHelp className="size-[18px]" /></DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" sideOffset={6} className="z-[6000] w-72 max-w-[calc(100vw-24px)] rounded-xl border border-line bg-raised p-1.5 text-sm shadow-2xl">
              <DropdownMenu.Label className="px-2 pb-1 pt-1.5 text-xs text-faint">Manuais</DropdownMenu.Label>
              {manuals.map((m) => (
                <DropdownMenu.Item key={m.id} onSelect={() => open(m)} className="flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-2 outline-none data-[highlighted]:bg-surface-2">
                  <BookOpen className="mt-0.5 size-4 shrink-0 text-accent" />
                  <span className="min-w-0">
                    <span className="block font-medium leading-snug">{m.title}</span>
                    {m.description && <span className="mt-0.5 block text-xs leading-snug text-muted">{m.description}</span>}
                  </span>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
      )}
      <FileViewer target={viewer} onClose={() => setViewer(null)} />
    </>
  );
}
