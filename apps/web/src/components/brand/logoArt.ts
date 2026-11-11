/**
 * Desenho da marca NoPaper: a folha que se desfaz em pixels.
 * Geometria determinística (mesma em toda renderização) em uma grade exata, viewBox 0 0 64 64.
 * Dois desenhos: `fine` (30 px ou mais) e `coarse` (menor: pixels maiores, sem as linhas de texto).
 * Os arquivos estáticos (favicon, ícones do PWA) são gerados a partir daqui — mudou aqui, gere de novo.
 */
export type LogoKind = 'fine' | 'coarse';
export interface LogoPixel { x: number; y: number; s: number; r: number; o: number; delay: number }
export interface LogoGeo { sheet: string; fold: string; holes: string; lines: string[]; pixels: LogoPixel[] }

const SEED = 7;
/** quanto da folha se desfaz: início e largura da faixa de dissolução, e início dos pixels soltos */
const DISSOLVE = { a: 0.46, w: 0.5, q: 0.27 };
const GRID = {
  fine: { u: 4, x0: 11, y0: 11, cols: 7, rows: 10, ec: 5, er: 1, fold: 9, r: 2.6, lines: true },
  coarse: { u: 6, x0: 12, y0: 11, cols: 4, rows: 7, ec: 4, er: 0, fold: 8, r: 2.5, lines: false },
} as const;

const hash = (i: number, j: number, s = SEED) => { const v = Math.sin(i * 127.1 + j * 311.7 + s * 74.7) * 43758.5453; return v - Math.floor(v); };
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const n2 = (v: number) => Math.round(v * 100) / 100;

const cache: Partial<Record<LogoKind, LogoGeo>> = {};

export function logoArt(kind: LogoKind): LogoGeo {
  const hit = cache[kind];
  if (hit) return hit;
  const g = GRID[kind];
  const { u, x0, y0, cols, rows, fold, r } = g;
  const x1 = x0 + cols * u, y1 = y0 + rows * u;
  const t = (i: number, j: number) => ((Math.min(i, cols - 1) + 0.5) / cols) * 0.5 + ((Math.min(j, rows - 1) + 0.5) / rows) * 0.5;
  const pixels: LogoPixel[] = [];
  let holes = '';
  for (let i = 0; i < cols + g.ec; i++) {
    for (let j = 0; j < rows + g.er; j++) {
      const n = hash(i, j), x = x0 + i * u, y = y0 + j * u;
      const add = (scale: number, o: number) => {
        const s = u * scale, off = (u - s) / 2;
        pixels.push({ x: n2(x + off), y: n2(y + off), s: n2(s), r: n2(s * 0.14), o: n2(o), delay: n2(-hash(i, j, 3) * 3.6) });
      };
      if (i < cols && j < rows) {
        const p = Math.pow(clamp((t(i, j) - DISSOLVE.a) / DISSOLVE.w), 1.5);
        if (n < p || (i === cols - 1 && j === rows - 1)) {
          holes += `M${n2(x - 0.2)} ${n2(y - 0.2)}h${u + 0.4}v${u + 0.4}h-${u + 0.4}z`;
          if (p > 0.5 && hash(i, j, 11) > p * 0.75) add(1 - 0.12 - 0.3 * p, 1);
        }
      } else {
        const k = Math.max(i - cols + 1, j - rows + 1, 1);
        const q = clamp((t(i, j) - DISSOLVE.q) / 0.34) * (1.02 - 0.2 * k);
        if (n < q) add(0.86 - 0.12 * k, Math.min(1, 1.05 - 0.17 * k));
      }
    }
  }
  const geo: LogoGeo = {
    sheet: `M${x0 + r} ${y0}H${x1 - fold}L${x1} ${y0 + fold}V${y1}H${x0 + r}a${r} ${r} 0 0 1-${r}-${r}V${y0 + r}a${r} ${r} 0 0 1 ${r}-${r}z`,
    fold: `M${x1 - fold} ${y0}v${n2(fold - 2.2)}a2.2 2.2 0 0 0 2.2 2.2H${x1}z`,
    holes,
    lines: g.lines ? [`M${x0 + 5} ${y0 + 15}h13`, `M${x0 + 5} ${y0 + 21.5}h9`] : [],
    pixels,
  };
  cache[kind] = geo;
  return geo;
}

/** anel de espera em volta da marca (centro 32,32) */
export const RING = { radius: 46, count: 30 };
/** caminhos dos quadradinhos que saem do canto da folha e entram no anel */
export const EMIT_PATHS = ['M45 46C54 50 62 56 64.5 64.5', 'M41 50C48 58 54 66 55 72', 'M48 40C58 42 70 46 74.5 51'];
