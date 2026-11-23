import { parseMoneyInput, toCents, fromCents } from './money.js';
import { detectPixKeyType } from './pix.js';

/**
 * Recibo de cobrança sem código de barras — o papel que escritórios de contabilidade (e outros
 * prestadores) mandam como cobrança da mensalidade: "RECIBO … VENCIMENTO … Recebi a importância
 * abaixo proveniente de: HONORÁRIOS … TOTAL", com a chave PIX no cabeçalho.
 *
 * Recebe o texto com as linhas na ordem da página (rótulo e valor na mesma linha): o texto corrido
 * que o leitor de PDF entrega embaralha as colunas desse tipo de documento.
 */
export interface ChargeReceipt {
  amount: string;
  dueDate: string | null;
  /** Chave PIX escrita no recibo (CPF/CNPJ, celular, e-mail). */
  pixKey: string | null;
  /** Quem emitiu (1ª linha do cabeçalho). */
  issuer: string | null;
  /** Mês de referência, AAAA-MM. */
  ref: string | null;
}

const MONEY = String.raw`(\d{1,3}(?:\.\d{3})*,\d{2})(?!\d)`;
const plain = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function realDate(d: string, m: string, y: string): string | null {
  const dt = new Date(Date.UTC(Number(y), Number(m) - 1, Number(d)));
  return dt.getUTCFullYear() === Number(y) && dt.getUTCMonth() === Number(m) - 1 && dt.getUTCDate() === Number(d) ? `${y}-${m}-${d}` : null;
}

/** Valor que vem logo depois do rótulo, na mesma linha ("TOTAL: R$ 825,00"); linha em branco para preencher à mão = null. */
function labeled(text: string, label: string): string | null {
  const m = text.match(new RegExp(String.raw`(?<![a-z])${label}[ \t]*:?[ \t]*(?:r\$[ \t]*)?${MONEY}`, 'i'));
  return m ? parseMoneyInput(m[1]!) : null;
}

export function parseChargeReceipt(input: string): ChargeReceipt | null {
  const raw = input.slice(0, 20_000);
  const text = plain(raw);
  if (!/(?<![a-z])recibo(?![a-z])/.test(text)) return null;
  if (!/recebi(?:emos)? a importancia|honorarios|mensalidade/.test(text)) return null;

  // o total impresso vale; quando ele fica em branco (para acréscimo à mão), o subtotal mais o acréscimo
  let amount = labeled(text, 'total') ?? labeled(text, 'valor total');
  if (!amount) {
    const sub = labeled(text, 'subtotal');
    const extra = labeled(text, 'acrescimo');
    if (sub) amount = fromCents(toCents(sub) + (extra ? toCents(extra) : 0));
  }
  if (!amount) {
    const m = text.match(new RegExp(String.raw`^[^\n]*(?:honorarios|mensalidade)[^\n\d]*${MONEY}[ \t]*$`, 'm'));
    if (m) amount = parseMoneyInput(m[1]!);
  }
  if (!amount || toCents(amount) <= 0) return null;

  const dm = text.match(/vencimento[ \t]*:?[ \t]*(\d{2})\/(\d{2})\/(\d{4})/);
  const rm = text.match(/(?<![a-z])ref(?:erencia|erente)?\.?[ \t]*:?[ \t]*(?:a[ \t]+)?(\d{2})\/(\d{4})(?!\d)/);
  const month = rm && Number(rm[1]) >= 1 && Number(rm[1]) <= 12 ? `${rm[2]}-${rm[1]}` : null;

  let pixKey: string | null = null;
  for (const m of raw.matchAll(/pix[ \t]*(?:cpf|cnpj|fone|telefone|celular|e-?mail|chave)?[ \t]*:?[ \t]*(?:n[ºo°][.:]?[ \t]*)?([^\s,;]+)/gi)) {
    const key = m[1]!.replace(/[.)]+$/, '');
    if (detectPixKeyType(key)) { pixKey = key; break; }
  }

  const first = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  const issuer = /[a-zà-ü]{3}/i.test(first) && !first.includes(':') && first.length <= 80 ? first : null;

  return { amount, dueDate: dm ? realDate(dm[1]!, dm[2]!, dm[3]!) : null, pixKey, issuer, ref: month };
}
