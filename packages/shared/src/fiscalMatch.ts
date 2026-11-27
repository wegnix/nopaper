/**
 * Vincular uma NF-e a contas a pagar já lançadas: pontuação das contas candidatas.
 * As contas não guardam CNPJ e a descrição costuma ter o nome popular ("POSTO CENTRAL - GOL ABC1234")
 * em vez da razão social da nota ("COMERCIO DE COMBUSTIVEIS EXEMPLO LTDA"): o que casa é valor/vencimento,
 * placa, número da NF, palavras do nome e o que já foi vinculado antes ao mesmo fornecedor.
 * Nada é vinculado sozinho: isto só ordena e explica as sugestões.
 */
import { z } from 'zod';
import { diffDaysISO } from './dates.js';
import { toCents } from './money.js';
import type { NfeDetails, NfeDuplicate } from './nfe.js';

export interface NoteMatchNote {
  number: string | null;
  key: string;
  issuedAt: string | null;
  total: string | null;
  emitterName: string | null;
  duplicates: NfeDuplicate[];
  details: NfeDetails | null;
}
export interface NoteMatchBill {
  description: string;
  relatedPerson: string | null;
  notes: string | null;
  amount: string;
  dueDate: string;
}
export type MatchReason = 'amount' | 'due' | 'plate' | 'model' | 'number' | 'key' | 'name' | 'learned';
export interface MatchResult { score: number; level: 'found' | 'maybe' | 'none'; reasons: MatchReason[] }

export const FISCAL_MATCH_FOUND = 55;
export const FISCAL_MATCH_MAYBE = 20;
/** Janela de vencimentos procurada: de N dias antes da emissão até N dias depois da última duplicata. */
export const FISCAL_MATCH_BEFORE_DAYS = 10;
export const FISCAL_MATCH_AFTER_DAYS = 45;

export const MATCH_REASON_LABELS: Record<MatchReason, string> = {
  amount: 'Mesmo valor', due: 'Vencimento próximo', plate: 'Mesma placa', model: 'Mesmo veículo', number: 'Número da NF',
  key: 'Chave da nota', name: 'Nome do fornecedor', learned: 'Já vinculado antes',
};

/** Maiúsculas, sem acento, só letras/números separados por espaço. */
export const matchText = (s: string | null | undefined) => (s ?? '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

const STOP = new Set([
  'LTDA', 'EIRELI', 'EPP', 'CIA', 'COMERCIO', 'COMERCIAL', 'DISTRIBUIDORA', 'DISTRIBUICAO', 'INDUSTRIA', 'INDUSTRIAL',
  'PRODUTOS', 'SERVICOS', 'SOLUCOES', 'TECNOLOGIA', 'TELECOM', 'TELECOMUNICACOES', 'IMPORTACAO', 'EXPORTACAO',
  'EMPRESA', 'GRUPO', 'BRASIL', 'NACIONAL', 'MATERIAIS', 'EQUIPAMENTOS', 'ATACADO', 'VAREJO', 'REPRESENTACOES',
]);
/** Palavras do nome do fornecedor que valem para comparar (4+ letras, sem as genéricas). */
export function nameTokens(...names: Array<string | null | undefined>) {
  const out = new Set<string>();
  for (const n of names) for (const w of matchText(n).split(' ')) if (w.length >= 4 && !/^\d+$/.test(w) && !STOP.has(w)) out.add(w);
  return [...out];
}

/** Começo da descrição que identifica o fornecedor ("POSTO CENTRAL - GOL…" → "POSTO CENTRAL"). */
export function descriptionRoot(description: string) {
  const head = description.split(/\s[-–—|]\s?|\s?[-–—|]\s/)[0] ?? description;
  const words = matchText(head).split(' ').filter(Boolean);
  const root = (words.length > 3 && head === description ? words.slice(0, 2) : words).join(' ');
  return root.length >= 4 ? root : '';
}

const has = (text: string, word: string) => (` ${text} `).includes(` ${word} `);

/**
 * Pontua uma conta para a nota. `learnedRoots` = `descriptionRoot` das contas já vinculadas
 * a outras notas do mesmo CNPJ (faz o papel do CNPJ, que a conta não tem).
 */
export function scoreBillForNote(note: NoteMatchNote, bill: NoteMatchBill, learnedRoots: string[] = []): MatchResult {
  const reasons: MatchReason[] = [];
  let score = 0;
  const desc = matchText(`${bill.description} ${bill.relatedPerson ?? ''}`);
  const all = matchText(`${bill.description} ${bill.relatedPerson ?? ''} ${bill.notes ?? ''}`);

  if (note.key && (bill.notes ?? '').includes(note.key)) { score += 80; reasons.push('key'); }

  // valor igual a uma duplicata (ou ao total) e vencimento perto da duplicata
  const cents = toCents(bill.amount);
  const targets = note.duplicates.length
    ? note.duplicates.map((d) => ({ cents: toCents(d.amount), due: d.dueDate }))
    : note.total ? [{ cents: toCents(note.total), due: null as string | null }] : [];
  if (note.total && note.duplicates.length > 1) targets.push({ cents: toCents(note.total), due: note.duplicates[0]?.dueDate ?? null });
  const same = targets.filter((t) => t.cents === cents);
  if (same.length) { score += 40; reasons.push('amount'); }
  const dues = (same.length ? same : targets).map((t) => t.due).filter((d): d is string => !!d);
  if (dues.some((d) => Math.abs(diffDaysISO(bill.dueDate, d)) <= 7)) { score += 15; reasons.push('due'); }

  const plate = note.details?.vehicle?.plate;
  const samePlate = !!plate && all.replace(/ /g, '').includes(plate);
  if (samePlate) { score += 55; reasons.push('plate'); }
  // o modelo só conta se a conta não for de outro carro ("GOL DEF5678" não é o Gol ABC1234)
  const otherPlate = !samePlate && [...desc.matchAll(/\b([A-Z]{3}) ?(\d[A-Z\d]\d{2})\b/g)].some((m) => `${m[1]}${m[2]}` !== plate);
  const model = matchText(note.details?.vehicle?.model);
  if (model.length >= 3 && !otherPlate && has(desc, model)) { score += 25; reasons.push('model'); }

  const num = note.number?.replace(/^0+/, '');
  if (num && num.length >= 3 && new RegExp(`\\bNF ?E? ?0*${num}\\b`).test(all)) { score += 55; reasons.push('number'); }

  const tokens = nameTokens(note.emitterName, note.details?.tradeName);
  const hits = tokens.filter((w) => has(desc, w)).length;
  if (hits) { score += hits > 1 ? 30 : 20; reasons.push('name'); }

  if (learnedRoots.some((r) => r && (desc === r || desc.startsWith(`${r} `)))) { score += 35; reasons.push('learned'); }

  const level = score >= FISCAL_MATCH_FOUND ? 'found' : score >= FISCAL_MATCH_MAYBE && reasons.some((r) => r !== 'due') ? 'maybe' : 'none';
  return { score, level, reasons };
}

/** Vencimento de referência da nota (1ª duplicata ou emissão), para desempatar pela proximidade. */
export function noteRefDate(note: Pick<NoteMatchNote, 'duplicates' | 'issuedAt'>) {
  return note.duplicates.find((d) => d.dueDate)?.dueDate ?? note.issuedAt;
}

/** Linha acrescentada nas observações da conta ao vincular. */
export function fiscalLinkNoteLine(d: { number: string | null; series: string | null; total: string | null; key: string }) {
  const value = d.total ? ` (R$ ${Number(d.total).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })})` : '';
  return `NF-e ${d.number ?? ''}${d.series ? ` série ${d.series}` : ''}${value} — chave ${d.key}`.replace(/\s+/g, ' ').trim();
}
/** Observações depois de vincular (sem repetir a nota se a chave já estiver lá). */
export function notesAfterLink(current: string | null, line: string, key: string) {
  const cur = (current ?? '').trimEnd();
  if (cur.includes(key)) return cur;
  return cur ? `${cur}\n${line}` : line;
}

export const fiscalLinkSchema = z.object({
  billIds: z.array(z.string().uuid()).min(1, 'Escolha ao menos uma conta').max(60),
  updateNotes: z.boolean().default(false),
});
export type FiscalLinkInput = z.input<typeof fiscalLinkSchema>;

export interface FiscalLinkedBill {
  id: string;
  description: string;
  dueDate: string;
  amount: string;
  status: 'pending' | 'paid';
  /** true = vinculada pelo botão Vincular (dá para desvincular); false = criada pelo Lançar. */
  linked: boolean;
}

export interface FiscalCandidate extends FiscalLinkedBill {
  relatedPerson: string | null;
  notes: string | null;
  installment: string | null;
  categoryLabel: string | null;
  score: number;
  level: MatchResult['level'];
  reasons: MatchReason[];
  /** Outras notas já vinculadas a esta conta (posto: uma conta no mês para vários abastecimentos). */
  otherNotes: Array<{ number: string | null; total: string | null }>;
  canEdit: boolean;
}
