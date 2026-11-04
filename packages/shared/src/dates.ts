/** Utilitários de data trabalhando sempre com strings ISO `YYYY-MM-DD` (sem fuso). */

export function parseISODate(s: string): { y: number; m: number; d: number } {
  const [y, m, d] = s.slice(0, 10).split('-').map(Number);
  return { y, m, d };
}

export function toISODate(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Soma meses a partir de uma data base; dia 31 vira último dia do mês destino (não acumulativo). */
export function addMonthsISO(base: string, months: number, preferredDay?: number): string {
  const { y, m, d } = parseISODate(base);
  const total = m - 1 + months;
  const ny = y + Math.floor(total / 12);
  const nm = ((total % 12) + 12) % 12 + 1;
  const day = Math.min(preferredDay ?? d, daysInMonth(ny, nm));
  return toISODate(ny, nm, day);
}

/** Soma anos; 29/02 vira 28/02 em ano não bissexto. */
export function addYearsISO(base: string, years: number, preferredDay?: number): string {
  const { y, m, d } = parseISODate(base);
  const ny = y + years;
  return toISODate(ny, m, Math.min(preferredDay ?? d, daysInMonth(ny, m)));
}

export function addDaysISO(base: string, days: number): string {
  const { y, m, d } = parseISODate(base);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function diffDaysISO(a: string, b: string): number {
  const pa = parseISODate(a), pb = parseISODate(b);
  return Math.round((Date.UTC(pa.y, pa.m - 1, pa.d) - Date.UTC(pb.y, pb.m - 1, pb.d)) / 86400000);
}

/** Data de hoje (YYYY-MM-DD) num fuso IANA. */
export function todayISO(timeZone = 'America/Sao_Paulo'): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

export function formatDateBR(iso: string | null | undefined): string {
  if (!iso) return '—';
  const { y, m, d } = parseISODate(iso);
  return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/${y}`;
}

export const MONTHS_PT = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
] as const;
export const MONTHS_PT_SHORT = ['Jan', 'Fev', 'Mar', 'Abr', 'Mai', 'Jun', 'Jul', 'Ago', 'Set', 'Out', 'Nov', 'Dez'] as const;

export function monthRange(year: number, month: number): { from: string; to: string } {
  return { from: toISODate(year, month, 1), to: toISODate(year, month, daysInMonth(year, month)) };
}
