import type { ReactNode } from 'react';
import { COLOR_PRESETS, isColorKey } from '@nopaper/shared';
import { Folder, Lock } from 'lucide-react';
import { cn } from '@/lib/utils';

export function ColorChip({ color, children, className, title, onClick, active, icon }: {
  color: string; children: ReactNode; className?: string; title?: string; onClick?: () => void; active?: boolean; icon?: ReactNode;
}) {
  const p = COLOR_PRESETS[isColorKey(color) ? color : 'slate'];
  const Comp = onClick ? 'button' : 'span';
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      title={title}
      onClick={onClick}
      style={{ ['--c' as string]: p.base, ['--cl' as string]: p.light, ['--cd' as string]: p.dark }}
      className={cn('chip inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium whitespace-nowrap max-w-full', active && 'ring-2 ring-[var(--c)]/50', onClick && 'cursor-pointer hover:brightness-110 pointer-coarse:py-1.5', className)}
    >
      {icon}
      <span className="truncate">{children}</span>
    </Comp>
  );
}

export function CategoryChip({ category, className }: { category?: { label: string; color: string; isRestricted?: boolean } | null; className?: string }) {
  if (!category) return <span className="text-xs text-faint">—</span>;
  return (
    <ColorChip color={category.color} className={className} icon={category.isRestricted ? <Lock className="size-3" /> : undefined}>
      {category.label}
    </ColorChip>
  );
}

export function FolderChip({ folder }: { folder?: { label: string; name: string; color: string } | null }) {
  if (!folder) return <span className="inline-block rounded-md border border-dashed border-line px-2 py-0.5 text-xs text-faint">sem pasta</span>;
  return <ColorChip color={folder.color} title={folder.name} icon={<Folder className="size-3" />}>{folder.label}</ColorChip>;
}

export type DisplayStatus = 'paid' | 'overdue' | 'today' | 'soon' | 'pending';
const statusStyle: Record<DisplayStatus, string> = {
  paid: 'text-ok bg-ok/12 border-ok/30',
  overdue: 'text-danger bg-danger/12 border-danger/35',
  today: 'text-warn bg-warn/15 border-warn/40',
  soon: 'text-warn bg-warn/8 border-warn/25',
  pending: 'text-muted bg-surface-2 border-line',
};
export function StatusChip({ status, label }: { status: DisplayStatus; label: string }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium whitespace-nowrap', statusStyle[status])}>
      <span className={cn('size-1.5 rounded-full bg-current', status === 'overdue' && 'animate-pulse')} />
      {label}
    </span>
  );
}
