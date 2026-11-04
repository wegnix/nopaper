import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildImportRows, guessMapping, headersOf, parseCellDate, sheetMonthFromName, type ImportSheet } from './import.js';

const sheet: ImportSheet = {
  name: 'Fev',
  rows: [
    [null, null, null],
    ['Despesas Mensal', null, null],
    ['Seq', 'Descrição', 'Data Vcto', 'Valor', 'Pago', 'Data Pgto', 'Método de pagamento', 'Obervações'],
    [1, 'Água', '2025-02-04', 150.4, 150.4, '2026-02-03', 'Débito em conta', null],
    [2, 'Diarista', 'Semanal', 1800, 500, null, 'PIX', '3 diárias'],
    [3, 'Corte de grama', 'Quinzenal', null, null, null, null, null],
    [4, 'Internet', '2026-02-10', 99.9, null, null, 'Boleto', null],
    [5, 'Luz', '2026-02-12', 250, 250, '2026-12-26', null, null],
    [null, null, 'TOTAL', 2300.3, null, null, null, null],
  ],
};

test('import: cabeçalho, mapeamento e regras', () => {
  assert.equal(sheetMonthFromName('Fevereiro'), 2);
  assert.equal(sheetMonthFromName('03/2026'), 3);
  assert.equal(sheetMonthFromName('IPVA'), null);
  assert.equal(parseCellDate('05/03/26'), '2026-03-05');
  assert.equal(parseCellDate(46000), '2025-12-09');
  const { headerRow, headers } = headersOf(sheet);
  assert.equal(headerRow, 2);
  const m = guessMapping(headers);
  assert.deepEqual(m, { paidAt: 'data pgto', paid: 'pago', dueDate: 'data vcto', description: 'descricao', amount: 'valor', paymentMethod: 'metodo de pagamento', notes: 'obervacoes' });
  const rows = buildImportRows(sheet, m, { year: 2026, fixYear: true, fallbackDay: 10, today: '2026-11-03' });
  const [agua, diar, grama, net, luz, total] = rows;
  assert.equal(agua.dueDate, '2026-02-04'); assert.equal(agua.paidAt, '2026-02-03'); assert.equal(agua.paidAmount, '150.40');
  assert.match(agua.warnings[0], /Ano corrigido/);
  assert.equal(diar.dueDate, '2026-02-10'); assert.equal(diar.paidAt, null); assert.match(diar.notes!, /parcialmente/);
  assert.equal(grama.skip, 'no_amount');
  assert.equal(net.paidAt, null); assert.equal(net.amount, '99.90');
  assert.equal(luz.paidAt, '2026-02-12');
  assert.equal(total.skip, 'total');
});
