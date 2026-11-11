import { LogoMark } from '@/components/brand/Brand';

const SCALE = {
  sm: { mark: 28, gap: 'gap-2', text: 'text-[19px]' },
  md: { mark: 36, gap: 'gap-2.5', text: 'text-[24px]' },
  lg: { mark: 60, gap: 'gap-3.5', text: 'text-[38px]' },
} as const;

/** Marca + nome. `scale`: sm (compacto), md (menu lateral), lg (login). `markSize` troca só o tamanho do desenho. */
export function Logo({ className = '', textClassName = '', animated, scale = 'sm', markSize }: {
  className?: string; textClassName?: string; animated?: boolean; scale?: keyof typeof SCALE; markSize?: number;
}) {
  const s = SCALE[scale];
  return (
    <span className={`inline-flex items-center ${s.gap} ${className}`}>
      <LogoMark size={markSize ?? s.mark} animated={animated} />
      <span className={`font-display ${s.text} font-semibold tracking-tight leading-none whitespace-nowrap ${textClassName}`}>NoPaper</span>
    </span>
  );
}
