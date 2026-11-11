import { useId } from 'react';
import { cn } from '@/lib/utils';
import { EMIT_PATHS, logoArt, RING, type LogoKind } from './logoArt';

/** Gradientes e sombra da marca. Os ids são por instância: um <svg> escondido (menu do computador no celular) não pode ser a fonte dos outros. */
function Defs({ id }: { id: string }) {
  return (
    <defs>
      <linearGradient id={`${id}t`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#a596ff" /><stop offset=".5" stopColor="#6a58f0" /><stop offset="1" stopColor="#3d2cc0" /></linearGradient>
      <radialGradient id={`${id}h`} cx=".2" cy=".05" r=".9"><stop offset="0" stopColor="#fff" stopOpacity=".38" /><stop offset=".6" stopColor="#fff" stopOpacity="0" /></radialGradient>
      <linearGradient id={`${id}s`} x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#fff" /><stop offset="1" stopColor="#e3deff" /></linearGradient>
      <linearGradient id={`${id}f`} x1="0" y1="1" x2="1" y2="0"><stop offset="0" stopColor="#efecff" /><stop offset="1" stopColor="#a99cff" /></linearGradient>
      <filter id={`${id}d`} x="-30%" y="-30%" width="160%" height="170%"><feDropShadow dx="0" dy="1.6" stdDeviation="1.8" floodColor="#150c5c" floodOpacity=".38" /></filter>
    </defs>
  );
}

function Mark({ id, kind }: { id: string; kind: LogoKind }) {
  const g = logoArt(kind);
  return (
    <>
      <rect width="64" height="64" rx="15" fill={`url(#${id}t)`} />
      <rect width="64" height="64" rx="15" fill={`url(#${id}h)`} />
      <rect x=".5" y=".5" width="63" height="63" rx="14.5" fill="none" stroke="#fff" strokeOpacity=".22" />
      <mask id={`${id}m`}><rect width="64" height="64" fill="#fff" /><path d={g.holes} fill="#000" /></mask>
      <g filter={kind === 'fine' ? `url(#${id}d)` : undefined}>
        <g mask={`url(#${id}m)`}>
          <path d={g.sheet} fill={`url(#${id}s)`} />
          <path d={g.fold} fill={`url(#${id}f)`} />
          {g.lines.map((d) => <path key={d} d={d} stroke="#cfc8ff" strokeWidth="2.1" strokeLinecap="round" />)}
        </g>
      </g>
      {g.pixels.map((p, i) => (
        <rect key={i} className="np-px" x={p.x} y={p.y} width={p.s} height={p.s} rx={p.r} fill="#fff" opacity={p.o}
          style={{ ['--o' as string]: p.o, animationDelay: `${p.delay}s` }} />
      ))}
    </>
  );
}

const useSvgId = () => `np${useId().replace(/[^a-zA-Z0-9]/g, '')}`;

/** A marca (folha se desfazendo em pixels). `size` em px escolhe o desenho; `animated` faz os pixels flutuarem. */
export function LogoMark({ size = 28, animated, className }: { size?: number; animated?: boolean; className?: string }) {
  const id = useSvgId();
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} className={cn('shrink-0', animated && 'np-anim', className)} aria-hidden>
      <Defs id={id} />
      <Mark id={id} kind={size >= 30 ? 'fine' : 'coarse'} />
    </svg>
  );
}

/**
 * Marca em movimento para esperas longas: os quadradinhos saem da folha e formam um anel em volta.
 * Sem `progress` o anel gira; com `progress` (0 a 1) ele vai se completando.
 * O anel ocupa a borda do desenho: a marca fica com ~60% de `size`.
 */
export function LogoLoader({ size = 96, progress, className, label = 'Carregando' }: { size?: number; progress?: number; className?: string; label?: string }) {
  const id = useSvgId();
  const { radius: R, count: N } = RING;
  const determinate = progress !== undefined;
  const squares = Array.from({ length: N }, (_, i) => i);
  return (
    <svg viewBox="-22 -22 108 108" width={size} height={size} className={cn('np-anim shrink-0 text-accent', className)}
      role={determinate ? 'progressbar' : 'status'} aria-label={label} {...(determinate ? { 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(progress * 100) } : {})}>
      <Defs id={id} />
      <Mark id={id} kind="fine" />
      <g className="np-emit" fill="currentColor">
        {[0, 1, 2, 3, 4, 5].map((i) => {
          const s = 3.2 - (i % 3) * 0.4, begin = `${(i * 0.42).toFixed(2)}s`;
          return (
            <rect key={i} x={-s / 2} y={-s / 2} width={s} height={s} rx=".5" opacity="0">
              <animateMotion dur="2.5s" begin={begin} repeatCount="indefinite" path={EMIT_PATHS[i % 3]} calcMode="spline" keyTimes="0;1" keySplines=".4 0 .6 1" />
              <animate attributeName="opacity" dur="2.5s" begin={begin} repeatCount="indefinite" values="0;0;1;1;0" keyTimes="0;.18;.4;.8;1" />
            </rect>
          );
        })}
      </g>
      {determinate ? (
        <g fill="currentColor">
          {squares.map((i) => (
            <rect key={i} x={32 - 1.9} y={32 - R - 1.9} width="3.8" height="3.8" rx=".5" transform={`rotate(${(i / N) * 360} 32 32)`}
              opacity={i / N < progress - 0.001 ? 1 : 0.16} style={{ transition: 'opacity .25s' }} />
          ))}
        </g>
      ) : (
        <g className="np-ring" fill="currentColor">
          {squares.map((i) => {
            const f = i / (N - 1), s = 2 + 2.6 * f, o = Math.pow(f, 1.7);
            return o < 0.04 ? null : <rect key={i} x={32 - s / 2} y={32 - R - s / 2} width={s} height={s} rx={s * 0.14} opacity={o} transform={`rotate(${(i / N) * 300} 32 32)`} />;
          })}
        </g>
      )}
    </svg>
  );
}

/** Anel de quadradinhos girando: o "carregando" pequeno (botões, textos, listas). Usa a cor do texto. */
export function PixelSpinner({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn('size-5 shrink-0', className)} aria-hidden>
      <g className="np-ring-mini" fill="currentColor">
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => <rect key={i} x="10.4" y="1.2" width="3.2" height="3.2" rx=".5" opacity={0.12 + 0.88 * (i / 7) ** 2} transform={`rotate(${i * 45} 12 12)`} />)}
      </g>
    </svg>
  );
}
