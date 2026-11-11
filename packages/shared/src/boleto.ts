/**
 * Boleto (FEBRABAN): linha digitável bancária (47), arrecadação/concessionária (48)
 * e código de barras (44). Validação de DVs, extração de valor e vencimento.
 */
import { addDaysISO, diffDaysISO, todayISO } from './dates.js';

export type BoletoKind = 'bancario' | 'arrecadacao';

export interface BoletoInfo {
  kind: BoletoKind;
  /** Linha digitável formatada (canônica). */
  line: string;
  /** Código de barras de 44 dígitos. */
  barcode: string;
  /** Valor em string decimal ("123.45") ou null se valor livre. */
  amount: string | null;
  /** Vencimento ISO (só bancário com fator). */
  dueDate: string | null;
  bankCode: string | null;
  valid: boolean;
}

const onlyDigits = (s: string) => s.replace(/\D/g, '');

export function mod10(s: string): number {
  let total = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s[s.length - 1 - i];
    let p = Number(ch) * (i % 2 === 0 ? 2 : 1);
    if (p >= 10) p = Math.floor(p / 10) + (p % 10);
    total += p;
  }
  const r = total % 10;
  return r === 0 ? 0 : 10 - r;
}

export function mod11Arrecadacao(s: string): number {
  const w = [2, 3, 4, 5, 6, 7, 8, 9];
  let total = 0;
  for (let i = 0; i < s.length; i++) total += Number(s[s.length - 1 - i]) * w[i % 8];
  const r = total % 11;
  // Regra calibrada com boletos reais: resto 0 ou 1 -> DV 1. Alguns convênios usam 0;
  // a validação aceita ambos (ver dvMatches).
  if (r === 0 || r === 1) return 1;
  return 11 - r;
}

function dvMatches(f: (s: string) => number, block: string, dv: number): boolean {
  const calc = f(block);
  if (calc === dv) return true;
  return f === mod11Arrecadacao && calc === 1 && dv === 0;
}

/** DV geral do código de barras bancário (posição 5), mod 11 pesos 2..9. */
export function dvGeralBancario(b44: string): number {
  const s = b44.slice(0, 4) + b44.slice(5);
  let sum = 0, w = 2;
  for (let i = s.length - 1; i >= 0; i--) { sum += Number(s[i]) * w; w = w === 9 ? 2 : w + 1; }
  const dv = 11 - (sum % 11);
  return dv === 0 || dv === 10 || dv === 11 ? 1 : dv;
}

export function validateLinhaBancaria(d47: string): boolean {
  if (!/^\d{47}$/.test(d47)) return false;
  return mod10(d47.slice(0, 9)) === Number(d47[9])
    && mod10(d47.slice(10, 20)) === Number(d47[20])
    && mod10(d47.slice(21, 31)) === Number(d47[31]);
}

export function validateLinhaArrecadacao(d48: string): boolean {
  if (!/^8\d{47}$/.test(d48)) return false;
  const id = d48[2];
  const f = id === '6' || id === '7' ? mod10 : id === '8' || id === '9' ? mod11Arrecadacao : null;
  if (!f) return false;
  for (let i = 0; i < 48; i += 12) if (!dvMatches(f, d48.slice(i, i + 11), Number(d48[i + 11]))) return false;
  return true;
}

export function linhaToBarcodeBancario(l: string): string {
  return l.slice(0, 4) + l[32] + l.slice(33, 47) + l.slice(4, 9) + l.slice(10, 20) + l.slice(21, 31);
}

export function barcodeToLinhaBancaria(b: string): string {
  const f1 = b.slice(0, 4) + b.slice(19, 24);
  const f2 = b.slice(24, 34);
  const f3 = b.slice(34, 44);
  return f1 + mod10(f1) + f2 + mod10(f2) + f3 + mod10(f3) + b[4] + b.slice(5, 19);
}

export function barcodeToLinhaArrecadacao(b: string): string {
  const id = b[2];
  const f = id === '6' || id === '7' ? mod10 : mod11Arrecadacao;
  let out = '';
  for (let i = 0; i < 44; i += 11) { const blk = b.slice(i, i + 11); out += blk + f(blk); }
  return out;
}

export function formatLinhaBancaria(d: string): string {
  return `${d.slice(0, 5)}.${d.slice(5, 10)} ${d.slice(10, 15)}.${d.slice(15, 21)} ${d.slice(21, 26)}.${d.slice(26, 32)} ${d[32]} ${d.slice(33, 47)}`;
}
export function formatLinhaArrecadacao(d: string): string {
  return [0, 12, 24, 36].map((i) => `${d.slice(i, i + 11)}-${d[i + 11]}`).join(' ');
}

/** Converte fator de vencimento em data, escolhendo o ciclo mais próximo da data de referência. */
export function fatorToDate(fator: number, ref = todayISO()): string | null {
  if (!fator) return null;
  const candidates: string[] = [];
  candidates.push(addDaysISO('1997-10-07', fator));
  if (fator >= 1000) candidates.push(addDaysISO('2025-02-22', fator - 1000));
  candidates.sort((a, b) => Math.abs(diffDaysISO(a, ref)) - Math.abs(diffDaysISO(b, ref)));
  return candidates[0];
}

/** Interpreta qualquer entrada (linha digitável ou código de barras, com ou sem formatação). */
export function parseBoleto(input: string, refDate?: string): BoletoInfo | null {
  const d = onlyDigits(input || '');
  if (d.length === 47) {
    const barcode = linhaToBarcodeBancario(d);
    const valid = validateLinhaBancaria(d) && dvGeralBancario(barcode) === Number(barcode[4]);
    return bancarioInfo(d, barcode, valid, refDate);
  }
  if (d.length === 48 && d[0] === '8') {
    const barcode = [0, 12, 24, 36].map((i) => d.slice(i, i + 11)).join('');
    return arrecadacaoInfo(d, barcode, validateLinhaArrecadacao(d));
  }
  if (d.length === 44) {
    if (d[0] === '8') {
      const linha = barcodeToLinhaArrecadacao(d);
      return arrecadacaoInfo(linha, d, validateLinhaArrecadacao(linha));
    }
    const linha = barcodeToLinhaBancaria(d);
    return bancarioInfo(linha, d, dvGeralBancario(d) === Number(d[4]), refDate);
  }
  return null;
}

function bancarioInfo(linha: string, barcode: string, valid: boolean, refDate?: string): BoletoInfo {
  const fator = Number(barcode.slice(5, 9));
  const cents = Number(barcode.slice(9, 19));
  return {
    kind: 'bancario',
    line: formatLinhaBancaria(linha),
    barcode,
    amount: cents > 0 ? `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}` : null,
    dueDate: fatorToDate(fator, refDate),
    bankCode: barcode.slice(0, 3),
    valid,
  };
}

function arrecadacaoInfo(linha: string, barcode: string, valid: boolean): BoletoInfo {
  const effective = barcode[2] === '6' || barcode[2] === '8';
  const cents = Number(barcode.slice(4, 15));
  return {
    kind: 'arrecadacao',
    line: formatLinhaArrecadacao(linha),
    barcode,
    amount: effective && cents > 0 ? `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}` : null,
    dueDate: null,
    bankCode: null,
    valid,
  };
}

/**
 * Procura uma linha digitável válida num texto extraído de PDF (porta do sistema anterior):
 * regex formatada -> janela deslizante sobre todos os dígitos -> dedupe de glifos duplicados.
 */
export function findBoletoInText(text: string): string | null {
  const banco = /(\d{5})\.?(\d{5})\s+(\d{5})\.?(\d{6})\s+(\d{5})\.?(\d{6})\s+(\d)\s+(\d{14})/g;
  for (const m of text.matchAll(banco)) {
    const d = m.slice(1).join('');
    // além dos DVs dos campos, o DV geral tem de fechar (números de relatórios passavam nos 3 primeiros)
    if (validateLinhaBancaria(d) && parseBoleto(d)?.valid) return formatLinhaBancaria(d);
  }
  const conc = /(\d{11})[\s-]?(\d)\s+(\d{11})[\s-]?(\d)\s+(\d{11})[\s-]?(\d)\s+(\d{11})[\s-]?(\d)/g;
  for (const m of text.matchAll(conc)) {
    const d = m.slice(1).join('');
    if (validateLinhaArrecadacao(d)) return formatLinhaArrecadacao(d);
  }
  const slide = (digits: string): string | null => {
    const max = Math.min(digits.length, 5000);
    for (let i = 0; i + 47 <= max; i++) {
      const w = digits.slice(i, i + 47);
      // janela solta no meio dos números do texto: além dos DVs dos campos, o DV geral tem de fechar
      // (holerites e relatórios cheios de números passavam só nos 3 primeiros por coincidência)
      if (validateLinhaBancaria(w) && w.slice(33).replace(/0/g, '') !== '' && parseBoleto(w)?.valid) return formatLinhaBancaria(w);
    }
    for (let i = 0; i + 48 <= max; i++) {
      const w = digits.slice(i, i + 48);
      if (w[0] === '8' && validateLinhaArrecadacao(w)) return formatLinhaArrecadacao(w);
    }
    return null;
  };
  const all = onlyDigits(text);
  const r = slide(all);
  if (r) return r;
  const dedup = (text.match(/\d+/g) || []).map((s) => {
    if (s.length % 2 !== 0) return s;
    for (let i = 0; i < s.length; i += 2) if (s[i] !== s[i + 1]) return s;
    let o = '';
    for (let i = 0; i < s.length; i += 2) o += s[i];
    return o;
  }).join('');
  return dedup !== all ? slide(dedup) : null;
}

// ---------------------------------------------------------------- desenho do código de barras

const ITF: Record<string, string> = {
  0: 'NNWWN', 1: 'WNNNW', 2: 'NWNNW', 3: 'WWNNN', 4: 'NNWNW', 5: 'WNWNN', 6: 'NWWNN', 7: 'NNNWW', 8: 'WNNWN', 9: 'NWNWN',
};

/**
 * Código de barras do boleto (Intercalado 2 de 5): larguras em módulos, alternando
 * barra, espaço, barra… (começa por barra). `wide` = quantos módulos tem o traço largo.
 */
export function itfWidths(digits: string, wide = 3): number[] {
  if (!/^\d+$/.test(digits) || digits.length % 2 !== 0) return [];
  const out = [1, 1, 1, 1];
  for (let i = 0; i < digits.length; i += 2) {
    const bars = ITF[digits[i]], spaces = ITF[digits[i + 1]];
    for (let k = 0; k < 5; k++) out.push(bars[k] === 'W' ? wide : 1, spaces[k] === 'W' ? wide : 1);
  }
  out.push(wide, 1, 1);
  return out;
}
