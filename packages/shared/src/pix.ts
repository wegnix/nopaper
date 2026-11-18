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
  if (/^\(\d{2}\)[\d\s-]+$/.test(k) && (d.length === 10 || d.length === 11)) return 'phone';
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

// ---------------------------------------------------------------- QR Code a partir da chave

/** Tipos possíveis de uma chave digitada (11 dígitos pode ser CPF **ou** celular). */
export function pixKeyCandidates(raw: string): PixKeyType[] {
  const k = raw.trim();
  const first = detectPixKeyType(k);
  if (!first) return [];
  // DDD + 9 + 8 dígitos que por acaso também fecha como CPF: só a pessoa sabe qual é
  // (com a máscara do CPF ou do telefone não há dúvida)
  if (first === 'cpf' && /^[1-9]{2}9\d{8}$/.test(k)) return ['cpf', 'phone'];
  return [first];
}

/** Chave no formato que o BR Code exige (CPF/CNPJ só dígitos, celular +55…, o resto em minúsculas). */
export function normalizePixKey(raw: string, type: PixKeyType): string | null {
  const k = raw.trim();
  const d = k.replace(/\D/g, '');
  let out: string;
  if (type === 'cpf' || type === 'cnpj') out = d;
  else if (type === 'phone') out = `+${d.length > 11 && d.startsWith('55') ? d : `55${d}`}`;
  else out = k.toLowerCase();
  return /^[\x21-\x7e]{1,77}$/.test(out) ? out : null;
}

const tlv = (id: string, value: string) => `${id}${String(value.length).padStart(2, '0')}${value}`;

/** Texto livre → o que cabe nos campos de nome/cidade do BR Code (maiúsculas sem acento). */
function brCodeText(s: string, max: number, fallback: string): string {
  const t = s.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return t || fallback;
}

/**
 * Monta um PIX "copia e cola" estático para uma chave. O nome é só um rótulo: o banco mostra o
 * titular de verdade da chave antes de confirmar. `amount` vazio/zero = quem paga digita o valor.
 */
export function buildPixBrCode(opts: { key: string; keyType: PixKeyType; amount?: string | null; name?: string | null; city?: string | null }): string | null {
  const key = normalizePixKey(opts.key, opts.keyType);
  if (!key) return null;
  const amount = opts.amount && /^\d{1,11}(\.\d{1,2})?$/.test(opts.amount) && Number(opts.amount) > 0 ? Number(opts.amount).toFixed(2) : null;
  const body = tlv('00', '01')
    + tlv('26', tlv('00', 'br.gov.bcb.pix') + tlv('01', key))
    + tlv('52', '0000') + tlv('53', '986')
    + (amount ? tlv('54', amount) : '')
    + tlv('58', 'BR')
    + tlv('59', brCodeText(opts.name ?? '', 25, 'RECEBEDOR'))
    + tlv('60', brCodeText(opts.city ?? '', 15, 'BRASIL'))
    + tlv('62', tlv('05', '***'))
    + '6304';
  return body + crc16(body);
}

/**
 * Procura um PIX copia e cola ("000201…6304XXXX" com CRC válido) num texto extraído de PDF ou OCR.
 * O código pode ter espaços de verdade (nome do recebedor: "CAIXA ECONOMICA FEDERAL") e quebras de
 * linha postas pelo PDF no meio dele; por isso tenta o texto com as quebras juntadas e, se não fechar,
 * sem nenhum espaço. Quem decide é o CRC — o 1º trecho que fecha vale.
 */
export function findPixInText(text: string): string | null {
  const variants = [text.replace(/\r?\n/g, ''), text.replace(/\s*\r?\n\s*/g, ''), text.replace(/\s+/g, '')];
  const seen = new Set<string>();
  for (const v of variants) {
    if (seen.has(v)) continue;
    seen.add(v);
    let from = 0;
    for (let tries = 0; tries < 20; tries++) {
      const start = v.indexOf('000201', from);
      if (start < 0) break;
      from = start + 6;
      const end = Math.min(v.length, start + 800); // teto do código: a busca fica com tempo previsível
      for (let i = v.indexOf('6304', start + 20); i >= 0 && i + 8 <= end; i = v.indexOf('6304', i + 1)) {
        const code = v.slice(start, i + 8);
        if (/[\r\n]/.test(code)) break;
        if (crc16(code.slice(0, -4)) === code.slice(-4).toUpperCase()) return code;
      }
    }
  }
  return null;
}
