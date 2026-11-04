/**
 * Presets de cor usados em categorias e pastas: 16 originais + 8 extras (a estrutura padrão de
 * empresa tem 24 pastas/categorias de contas a pagar, todas com cores diferentes).
 */
export const COLOR_KEYS = [
  'blue', 'sky', 'cyan', 'teal', 'emerald', 'lime', 'yellow', 'amber',
  'orange', 'red', 'rose', 'pink', 'fuchsia', 'purple', 'indigo', 'slate',
  'green', 'olive', 'gold', 'brown', 'coral', 'wine', 'violet', 'navy',
] as const;
export type ColorKey = (typeof COLOR_KEYS)[number];

export const COLOR_PRESETS: Record<ColorKey, { label: string; base: string; light: string; dark: string }> = {
  blue: { label: 'Azul', base: '#3b82f6', light: '#93c5fd', dark: '#1d4ed8' },
  sky: { label: 'Céu', base: '#0ea5e9', light: '#7dd3fc', dark: '#0369a1' },
  cyan: { label: 'Ciano', base: '#06b6d4', light: '#67e8f9', dark: '#0e7490' },
  teal: { label: 'Turquesa', base: '#14b8a6', light: '#5eead4', dark: '#0f766e' },
  emerald: { label: 'Verde', base: '#10b981', light: '#6ee7b7', dark: '#047857' },
  lime: { label: 'Lima', base: '#84cc16', light: '#bef264', dark: '#4d7c0f' },
  yellow: { label: 'Amarelo', base: '#eab308', light: '#fde047', dark: '#a16207' },
  amber: { label: 'Âmbar', base: '#f59e0b', light: '#fcd34d', dark: '#b45309' },
  orange: { label: 'Laranja', base: '#f97316', light: '#fdba74', dark: '#c2410c' },
  red: { label: 'Vermelho', base: '#ef4444', light: '#fca5a5', dark: '#b91c1c' },
  rose: { label: 'Rosê', base: '#f43f5e', light: '#fda4af', dark: '#be123c' },
  pink: { label: 'Rosa', base: '#ec4899', light: '#f9a8d4', dark: '#be185d' },
  fuchsia: { label: 'Fúcsia', base: '#d946ef', light: '#f0abfc', dark: '#a21caf' },
  purple: { label: 'Roxo', base: '#a855f7', light: '#d8b4fe', dark: '#7e22ce' },
  indigo: { label: 'Índigo', base: '#6366f1', light: '#a5b4fc', dark: '#4338ca' },
  slate: { label: 'Cinza', base: '#64748b', light: '#cbd5e1', dark: '#334155' },
  green: { label: 'Verde-folha', base: '#22c55e', light: '#86efac', dark: '#15803d' },
  olive: { label: 'Oliva', base: '#7c8a24', light: '#c5d07a', dark: '#4f5a12' },
  gold: { label: 'Dourado', base: '#c9a227', light: '#e8d48a', dark: '#8a6d10' },
  brown: { label: 'Marrom', base: '#a0522d', light: '#d9a582', dark: '#6b3419' },
  coral: { label: 'Coral', base: '#ff7f50', light: '#ffb59a', dark: '#c4502a' },
  wine: { label: 'Vinho', base: '#9f1239', light: '#e48aa1', dark: '#6b0f27' },
  violet: { label: 'Violeta', base: '#8b5cf6', light: '#c4b5fd', dark: '#6d28d9' },
  navy: { label: 'Marinho', base: '#1e40af', light: '#9db1e8', dark: '#172554' },
};

export function isColorKey(v: unknown): v is ColorKey {
  return typeof v === 'string' && (COLOR_KEYS as readonly string[]).includes(v);
}

/** Cartões aceitam também o preto (cartões "Black"), que não existe para categorias/pastas. */
export const CARD_COLOR_KEYS = [...COLOR_KEYS, 'black'] as const;
export type CardColorKey = (typeof CARD_COLOR_KEYS)[number];
export const CARD_COLOR_PRESETS: Record<CardColorKey, { label: string; base: string; light: string; dark: string }> = {
  ...COLOR_PRESETS,
  black: { label: 'Preto', base: '#1c1c1f', light: '#5a5a62', dark: '#050506' },
};
export function isCardColorKey(v: unknown): v is CardColorKey {
  return typeof v === 'string' && (CARD_COLOR_KEYS as readonly string[]).includes(v);
}
