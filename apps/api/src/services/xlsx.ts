import ExcelJS from 'exceljs';
import { formatDateBR } from '@nopaper/shared';

export interface SheetBillRow {
  dueDate: string; description: string; category: string; folder: string | null; amount: string;
  /** paid | pending | overdue */
  status: string; paidAt: string | null; paidAmount: string | null; paymentMethod: string | null;
  relatedPerson: string | null; notes: string | null; attachments: string; installment?: string | null;
}

const VIOLET = 'FF5B4BE8';
const statusLabel = (s: string, paidWord: string) => (s === 'paid' ? paidWord : s === 'overdue' ? 'Vencida' : 'Pendente');
const header = (paidWord: string) => ['Vencimento', 'Descrição', 'Parcela', 'Categoria', 'Pasta', 'Valor', 'Situação', `${paidWord} em`, `Valor ${paidWord.toLowerCase()}`, 'Forma de pagamento', 'Pessoa', 'Observações', 'Anexos'];

const MONTHS = ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho', 'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
const BRL = '"R$" #,##0.00';
const cents = (v: string | null) => Math.round(Number(v ?? 0) * 100);

/** Uma aba com a lista de contas (título, filtros, cabeçalho, linhas e total). */
function addBillsSheet(wb: ExcelJS.Workbook, name: string, title: string, rows: SheetBillRow[], type: 'payable' | 'receivable', subtitle?: string) {
  const ws = wb.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 3 }] });
  const paidWord = type === 'payable' ? 'Pago' : 'Recebido';
  const cols = header(paidWord);
  const lastCol = String.fromCharCode(64 + cols.length);
  ws.mergeCells(`A1:${lastCol}1`);
  ws.getCell('A1').value = title;
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: VIOLET } };
  if (subtitle) {
    ws.mergeCells(`A2:${lastCol}2`);
    ws.getCell('A2').value = subtitle;
    ws.getCell('A2').font = { size: 10, color: { argb: 'FF5B6478' } };
  }
  ws.getRow(3).values = cols;
  ws.getRow(3).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VIOLET } };
  ws.columns = [
    { width: 12 }, { width: 40 }, { width: 9 }, { width: 18 }, { width: 18 }, { width: 14 }, { width: 11 },
    { width: 12 }, { width: 14 }, { width: 18 }, { width: 18 }, { width: 40 }, { width: 28 },
  ];
  for (const r of rows) {
    const row = ws.addRow([
      parseDate(r.dueDate), r.description, r.installment ?? '', r.category, r.folder ?? '', Number(r.amount),
      statusLabel(r.status, paidWord), r.paidAt ? parseDate(r.paidAt) : null,
      r.paidAmount ? Number(r.paidAmount) : null, r.paymentMethod ?? '', r.relatedPerson ?? '', r.notes ?? '', r.attachments,
    ]);
    row.getCell(1).numFmt = 'dd/mm/yyyy';
    row.getCell(8).numFmt = 'dd/mm/yyyy';
    row.getCell(6).numFmt = BRL;
    row.getCell(9).numFmt = BRL;
    if (r.status === 'overdue') row.getCell(7).font = { color: { argb: 'FFD9483B' } };
  }
  const last = Math.max(ws.rowCount, 3);
  const total = ws.addRow(['', `TOTAL (${rows.length} ${rows.length === 1 ? 'conta' : 'contas'})`, '', '', '', rows.length ? { formula: `SUM(F4:F${last})` } : 0, '', '', rows.length ? { formula: `SUM(I4:I${last})` } : 0]);
  total.font = { bold: true };
  total.getCell(6).numFmt = BRL;
  total.getCell(9).numFmt = BRL;
  if (rows.length) ws.autoFilter = { from: 'A3', to: `${lastCol}${last}` };
  return ws;
}

/**
 * Planilha com as contas (lista exportada e relatório do ZIP contábil). `subtitle`: filtros/período.
 * Se as contas cobrem mais de um mês (e `byMonth` não for false), sai uma aba "Resumo" com os
 * totais de cada mês, uma aba por mês e uma aba "Todas" com a lista completa.
 */
export async function billsWorkbook(title: string, rows: SheetBillRow[], type: 'payable' | 'receivable', subtitle?: string, byMonth = true) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'NoPaper';
  wb.created = new Date();
  const keys = [...new Set(rows.map((r) => r.dueDate.slice(0, 7)))].sort();
  if (!byMonth || keys.length <= 1) {
    addBillsSheet(wb, 'Contas', title, rows, type, subtitle);
    return Buffer.from(await wb.xlsx.writeBuffer());
  }
  const paidWord = type === 'payable' ? 'Pago' : 'Recebido';
  const label = (k: string) => `${MONTHS[Number(k.slice(5)) - 1]} ${k.slice(0, 4)}`;
  const multiYear = new Set(keys.map((k) => k.slice(0, 4))).size > 1;
  const tab = (k: string) => (multiYear ? `${MONTHS[Number(k.slice(5)) - 1].slice(0, 3)} ${k.slice(0, 4)}` : MONTHS[Number(k.slice(5)) - 1]);

  // ---- resumo
  const ws = wb.addWorksheet('Resumo', { views: [{ state: 'frozen', ySplit: 3 }] });
  ws.mergeCells('A1:G1');
  ws.getCell('A1').value = title;
  ws.getCell('A1').font = { bold: true, size: 14, color: { argb: VIOLET } };
  if (subtitle) { ws.mergeCells('A2:G2'); ws.getCell('A2').value = subtitle; ws.getCell('A2').font = { size: 10, color: { argb: 'FF5B6478' } }; }
  ws.getRow(3).values = ['Mês', 'Contas', 'Total', paidWord, 'Pendente', 'Vencido', 'Aba'];
  ws.getRow(3).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  ws.getRow(3).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: VIOLET } };
  ws.columns = [{ width: 18 }, { width: 9 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 14 }];
  for (const k of keys) {
    const m = rows.filter((r) => r.dueDate.startsWith(k));
    const sum = (f: (r: SheetBillRow) => boolean) => m.filter(f).reduce((a, r) => a + cents(r.amount), 0) / 100;
    const row = ws.addRow([label(k), m.length, sum(() => true), sum((r) => r.status === 'paid'), sum((r) => r.status !== 'paid'), sum((r) => r.status === 'overdue'),
      { text: `abrir →`, hyperlink: `#'${tab(k)}'!A1` }]);
    for (const c of [3, 4, 5, 6]) row.getCell(c).numFmt = BRL;
    row.getCell(7).font = { color: { argb: VIOLET }, underline: true };
    if (sum((r) => r.status === 'overdue') > 0) row.getCell(6).font = { color: { argb: 'FFD9483B' } };
  }
  const last = ws.rowCount;
  const tot = ws.addRow(['TOTAL', { formula: `SUM(B4:B${last})` }, { formula: `SUM(C4:C${last})` }, { formula: `SUM(D4:D${last})` }, { formula: `SUM(E4:E${last})` }, { formula: `SUM(F4:F${last})` }]);
  tot.font = { bold: true };
  for (const c of [3, 4, 5, 6]) tot.getCell(c).numFmt = BRL;

  // ---- uma aba por mês + todas
  for (const k of keys) addBillsSheet(wb, tab(k), `${title} — ${label(k)}`, rows.filter((r) => r.dueDate.startsWith(k)), type, subtitle);
  addBillsSheet(wb, 'Todas', title, rows, type, subtitle);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Data como Date em UTC (o Excel mostra o dia certo, sem fuso). */
const parseDate = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00Z`);

/** CSV no padrão do Excel brasileiro: ponto e vírgula, vírgula decimal, BOM UTF-8. */
export function billsCsv(rows: SheetBillRow[], type: 'payable' | 'receivable') {
  const paidWord = type === 'payable' ? 'Pago' : 'Recebido';
  const esc = (v: unknown) => {
    const s = String(v ?? '');
    return /[";\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const money = (v: string | null) => (v ? v.replace('.', ',') : '');
  const lines = rows.map((r) => [
    formatDateBR(r.dueDate), r.description, r.installment ?? '', r.category, r.folder ?? '', money(r.amount),
    statusLabel(r.status, paidWord), r.paidAt ? formatDateBR(r.paidAt) : '', money(r.paidAmount),
    r.paymentMethod ?? '', r.relatedPerson ?? '', r.notes ?? '', r.attachments,
  ].map(esc).join(';'));
  return '﻿' + [header(paidWord).join(';'), ...lines].join('\r\n') + '\r\n';
}
