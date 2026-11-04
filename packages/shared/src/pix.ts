/** PIX: BR Code (EMV MPM "Copia e Cola") e detecção de tipo de chave. */

export interface PixInfo {
  isBrCode: boolean;
  key: string | null;
  keyType: PixKeyType | null;
  amount: string | null;
  merchantName: string | null;
  merchantCity: string | null;
  description: string | null;
  txid: string | null;
  dynamicUrl: string | null;
  crcValid: boolean;
}

export type PixKeyType = 'cpf' | 'cnpj' | 'email' | 'phone' | 'random';

export function parseTLV(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  let i = 0;
  while (i + 4 <= s.length) {
    const id = s.slice(i, i + 2);
    const len = Number.parseInt(s.slice(i + 2, i + 4), 10);
    if (!Number.isFinite(len)) break;
    out[id] = s.slice(i + 4, i + 4 + len);
    i += 4 + len;
  }
  return out;
}

export function crc16(payload: string): string {
  let crc = 0xffff;
  const bytes = new TextEncoder().encode(payload);
  for (const b of bytes) {
    crc ^= b << 8;
    for (let k = 0; k < 8; k++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function cpfValid(d: string): boolean {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d)) return false;
  const calc = (n: number) => {
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i);
    const r = (s * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(d[9]) && calc(10) === Number(d[10]);
}

function cnpjValid(d: string): boolean {
  if (!/^\d{14}$/.test(d) || /^(\d)\1{13}$/.test(d)) return false;
  const calc = (n: number) => {
    const w = n === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    let s = 0;
    for (let i = 0; i < n; i++) s += Number(d[i]) * w[i];
    const r = s % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(d[12]) && calc(13) === Number(d[13]);
}

export function detectPixKeyType(raw: string): PixKeyType | null {
  const k = raw.trim();
  if (!k) return null;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(k)) return 'email';
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k)) return 'random';
  if (/^\+55\d{10,11}$/.test(k.replace(/[\s()-]/g, ''))) return 'phone';
  const d = k.replace(/\D/g, '');
  if (/^[\d.\-/\s]+$/.test(k)) {
    if (d.length === 11 && cpfValid(d)) return 'cpf';
    if (d.length === 14 && cnpjValid(d)) return 'cnpj';
    if (d.length === 10 || d.length === 11) return 'phone';
  }
  return null;
}

export const PIX_KEY_TYPE_LABEL: Record<PixKeyType, string> = {
  cpf: 'CPF', cnpj: 'CNPJ', email: 'E-mail', phone: 'Celular', random: 'Chave aleatória',
};

export function parsePix(input: string): PixInfo {
  const s = (input || '').trim();
  const empty: PixInfo = {
    isBrCode: false, key: null, keyType: null, amount: null, merchantName: null,
    merchantCity: null, description: null, txid: null, dynamicUrl: null, crcValid: false,
  };
  if (!s.startsWith('000201')) {
    const keyType = detectPixKeyType(s);
    return { ...empty, key: keyType ? s : null, keyType };
  }
  const top = parseTLV(s);
  let key: string | null = null, description: string | null = null, dynamicUrl: string | null = null;
  for (let id = 26; id <= 51; id++) {
    const v = top[String(id)];
    if (!v) continue;
    const sub = parseTLV(v);
    if ((sub['00'] || '').toLowerCase() === 'br.gov.bcb.pix') {
      key = sub['01'] ?? null;
      description = sub['02'] ?? null;
      dynamicUrl = sub['25'] ?? null;
      break;
    }
  }
  const add = top['62'] ? parseTLV(top['62']) : {};
  const crcValid = s.length > 8 && crc16(s.slice(0, -4)) === s.slice(-4).toUpperCase();
  const amount = top['54'] && /^\d+(\.\d{1,2})?$/.test(top['54'])
    ? (() => { const [i, f = ''] = top['54'].split('.'); return `${Number(i)}.${(f + '00').slice(0, 2)}`; })()
    : null;
  return {
    isBrCode: true,
    key,
    keyType: key ? detectPixKeyType(key) : null,
    amount,
    merchantName: top['59'] ?? null,
    merchantCity: top['60'] ?? null,
    description,
    txid: add['05'] && add['05'] !== '***' ? add['05'] : null,
    dynamicUrl,
    crcValid,
  };
}
