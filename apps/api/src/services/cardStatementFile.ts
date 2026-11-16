/**
 * Fatura do cartão em qualquer formato: descobre o tipo pelos primeiros bytes, abre o que vier com
 * senha (regras do espaço ou a senha digitada) e entrega os lançamentos lidos. O OFX continua com o
 * leitor próprio (devolve `ofx` para a rota tratar como sempre).
 */
import { parseCardPdf, parseCardSheet, type CardStatementRead } from '@nopaper/shared';
import { badRequest } from '../lib/errors.js';
import { readCsv, readXlsx } from '../routes/import.js';
import { pdfToCells } from './pdf.js';
import { passwordCandidates, unlockPdf } from './pdfPasswords.js';

export type StatementFile =
  | { kind: 'ofx' }
  | { kind: 'locked' }
  | { kind: 'read'; read: CardStatementRead; unlockedBy: string | null };

const starts = (buf: Buffer, ...bytes: number[]) => buf.subarray(0, bytes.length).equals(Buffer.from(bytes));

/** Planilha do Office protegida por senha (o arquivo vira um contêiner cifrado, não um ZIP). */
async function openProtectedSheet(orgId: string, buf: Buffer, typed: string | null): Promise<{ buf: Buffer; by: string } | 'locked' | 'not_encrypted'> {
  const crypto = (await import('officecrypto-tool')).default;
  if (!crypto.isEncrypted(buf)) return 'not_encrypted';
  for (const c of await passwordCandidates(orgId, typed)) {
    try {
      const open = await crypto.decrypt(buf, { password: c.password });
      if (starts(open, 0x50, 0x4b, 0x03, 0x04)) return { buf: open, by: c.name };
    } catch { /* senha errada: tenta a próxima */ }
  }
  return 'locked';
}

export async function readCardStatementFile(orgId: string, input: Buffer, filename: string, typed: string | null, today: string): Promise<StatementFile> {
  let buf = input, unlockedBy: string | null = null;

  if (starts(buf, 0x25, 0x50, 0x44, 0x46)) { // %PDF
    const u = await unlockPdf(orgId, buf, typed);
    if (u.state === 'locked') return { kind: 'locked' };
    let cells;
    try { cells = await pdfToCells(u.buf, 30); } catch { throw badRequest('Não consegui ler este PDF. Se for uma foto ou digitalização da fatura, use a planilha ou o OFX do banco.'); }
    const read = parseCardPdf(cells, today);
    if (!read.lines.length) throw badRequest('Não achei lançamentos neste PDF. Ele é a fatura do cartão? Se for uma foto ou digitalização, use a planilha ou o OFX do banco.');
    return { kind: 'read', read, unlockedBy: u.state === 'unlocked' ? u.by : null };
  }

  if (starts(buf, 0xd0, 0xcf, 0x11, 0xe0)) {
    const open = await openProtectedSheet(orgId, buf, typed).catch(() => 'not_encrypted' as const);
    if (open === 'locked') return { kind: 'locked' };
    if (open === 'not_encrypted') throw badRequest('Formato .xls antigo não é suportado. Abra no Excel/LibreOffice e salve como .xlsx.');
    buf = open.buf; unlockedBy = open.by;
  }

  if (starts(buf, 0x50, 0x4b, 0x03, 0x04)) {
    const read = parseCardSheet(await readXlsx(buf), today);
    if (!read.lines.length) throw badRequest('Não achei lançamentos nesta planilha. Ela precisa ter as colunas Data, Descrição e Valor.');
    return { kind: 'read', read, unlockedBy };
  }

  if (buf.subarray(0, 4096).includes(0)) throw badRequest('Formato não suportado. Envie a fatura em PDF, planilha (.xlsx ou .csv) ou OFX.');
  const head = buf.subarray(0, 4096).toString('latin1').toUpperCase();
  if (head.includes('<OFX') || head.includes('OFXHEADER')) return { kind: 'ofx' };
  const read = parseCardSheet(readCsv(buf, filename), today);
  if (!read.lines.length) throw badRequest('Não achei lançamentos neste arquivo. Envie a fatura em PDF, planilha (.xlsx ou .csv) ou OFX.');
  return { kind: 'read', read, unlockedBy: null };
}
