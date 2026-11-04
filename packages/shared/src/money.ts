/**
 * Dinheiro trafega como string decimal com 2 casas ("1234.50").
 * Aritmética feita em centavos inteiros (bigint-safe até ~90 trilhões).
 */
export function toCents(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'number') return Math.round(v * 100);
  const s = v.trim();
  const neg = s.startsWith('-');
  const [int, frac = ''] = s.replace('-', '').split('.');
  return (neg ? -1 : 1) * (Number(int || '0') * 100 + Number((frac + '00').slice(0, 2)));
}

export function fromCents(c: number): string {
  const neg = c < 0;
  const a = Math.abs(Math.round(c));
  return `${neg ? '-' : ''}${Math.floor(a / 100)}.${String(a % 100).padStart(2, '0')}`;
}

export function sumMoney(values: Array<string | number | null | undefined>): string {
  return fromCents(values.reduce<number>((acc, v) => acc + toCents(v), 0));
}

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export function formatBRL(v: string | number | null | undefined): string {
  return brl.format(toCents(v) / 100);
}

/**
 * Converte entrada livre em string decimal: aceita "1.234,56", "1234,56", "1234.56",
 * "R$ 1.234,56", "1,234.56", números. Retorna null se inválido.
 */
export function parseMoneyInput(input: unknown): string | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? fromCents(Math.round(input * 100)) : null;
  let s = String(input).trim().replace(/R\$\s*/i, '').replace(/\s/g, '');
  if (!s) return null;
  const neg = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/[()\-]/g, '');
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma > -1 && lastDot > -1) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma > -1) {
    s = s.replace(/\./g, '').replace(',', '.');
  } else if (lastDot > -1 && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    s = s.replace(/\./g, '');
  }
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const cents = Math.round(Number(s) * 100);
  return fromCents(neg ? -cents : cents);
}

/** Texto usado no botão "copiar descrição" do sistema anterior: "ALUGUEL 1500,00 PGTO". */
export function copyDescriptionText(description: string, amount: string): string {
  return `${description} ${fromCents(toCents(amount)).replace('.', ',')} PGTO`;
}
