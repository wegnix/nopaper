/**
 * CPF e CNPJ: normalização, máscara (enquanto digita) e validação dos dígitos verificadores.
 * O CNPJ já aceita o formato alfanumérico da Receita (IN RFB 2.229/2024, a partir de jul/2026):
 * 12 primeiros caracteres A–Z/0–9 e 2 dígitos verificadores numéricos, calculados com o valor
 * ASCII − 48 de cada caractere (para dígitos, é o próprio número — o cálculo antigo continua igual).
 */
export type DocumentKind = 'cpf' | 'cnpj';

/** Mantém só 0–9 e A–Z (maiúsculo), no máximo 14 caracteres. */
export const normalizeDocument = (v: string) => v.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 14);

/** Tipo provável pelo conteúdo: letras ou mais de 11 caracteres → CNPJ. */
export const documentKind = (v: string): DocumentKind => {
  const n = normalizeDocument(v);
  return n.length > 11 || /[A-Z]/.test(n) ? 'cnpj' : 'cpf';
};

/** Máscara progressiva: 000.000.000-00 ou AA.AAA.AAA/AAAA-00. */
export function formatDocument(v: string): string {
  const n = normalizeDocument(v);
  if (documentKind(n) === 'cpf') {
    const d = n.replace(/\D/g, '');
    return d.replace(/^(\d{3})(\d)/, '$1.$2').replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/\.(\d{3})(\d{1,2})$/, '.$1-$2');
  }
  let out = '';
  for (let i = 0; i < n.length; i++) {
    if (i === 2 || i === 5) out += '.';
    else if (i === 8) out += '/';
    else if (i === 12) out += '-';
    out += n[i];
  }
  return out;
}

const dv = (values: number[], weights: number[]) => {
  const r = values.reduce((acc, v, i) => acc + v * weights[i], 0) % 11;
  return r < 2 ? 0 : 11 - r;
};

export function isValidCPF(v: string): boolean {
  const d = normalizeDocument(v);
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  const n = [...d].map(Number);
  const d1 = dv(n.slice(0, 9), [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv(n.slice(0, 10), [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === n[9] && d2 === n[10];
}

export function isValidCNPJ(v: string): boolean {
  const c = normalizeDocument(v);
  if (!/^[0-9A-Z]{12}\d{2}$/.test(c) || /^(.)\1{13}$/.test(c)) return false;
  const n = [...c].map((ch) => ch.charCodeAt(0) - 48);
  const d1 = dv(n.slice(0, 12), [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = dv(n.slice(0, 13), [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return d1 === n[12] && d2 === n[13];
}

/** null = válido (ou vazio); senão, a mensagem de erro em pt-BR. */
export function documentError(v: string | null | undefined): string | null {
  const n = normalizeDocument(v ?? '');
  if (!n) return null;
  if (documentKind(n) === 'cpf') {
    if (n.length < 11) return 'CPF incompleto: são 11 dígitos';
    return isValidCPF(n) ? null : 'CPF inválido: confira os números';
  }
  if (n.length < 14) return 'CNPJ incompleto: são 14 caracteres';
  return isValidCNPJ(n) ? null : 'CNPJ inválido: confira os números';
}
