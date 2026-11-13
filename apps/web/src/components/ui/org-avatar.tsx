import { cn } from '@/lib/utils';

/**
 * Marca do espaço: a logo enviada em Dados do espaço ou, sem ela, a inicial do nome.
 * A logo fica sempre sobre fundo branco (a maioria é feita para papel claro) — também no tema escuro.
 */
export function OrgAvatar({ name, logo, className }: { name?: string | null; logo?: string | null; className?: string }) {
  if (logo) {
    return (
      <span className={cn('grid size-8 shrink-0 place-items-center overflow-hidden rounded-lg bg-white ring-1 ring-inset ring-black/10', className)}>
        <img src={logo} alt="" draggable={false} className="size-full object-contain p-[8%]" />
      </span>
    );
  }
  return (
    <span className={cn('grid size-8 shrink-0 place-items-center rounded-lg bg-accent-soft font-display font-semibold text-accent', className)}>
      {(name ?? '').trim().slice(0, 1).toUpperCase()}
    </span>
  );
}
