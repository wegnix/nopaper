import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCardPdf, parseCardSheet, splitInstallment } from './cardStatement.js';
import type { PdfCell } from './payslips.js';

// Dados fictícios, no formato de uma fatura com titular + adicional em duas colunas.
const row = (...s: string[]): PdfCell[] => s.map((t, i) => ({ x: i * 100, w: 80, s: t }));

test('splitInstallment: formatos de parcela', () => {
  assert.deepEqual(splitInstallment('Loja Azul (2/10)'), { description: 'Loja Azul', installment: 2, installments: 10 });
  assert.deepEqual(splitInstallment('LOJA AZUL 02/10'), { description: 'LOJA AZUL', installment: 2, installments: 10 });
  assert.deepEqual(splitInstallment('Loja Azul - Parcela 3 de 6'), { description: 'Loja Azul', installment: 3, installments: 6 });
  assert.equal(splitInstallment('Seguro Parc3').installment, null);
  assert.equal(splitInstallment('Posto 24/7').installment, null);
});

test('PDF em duas colunas, vários cartões, ano pela parcela e conferência com o total', () => {
  const header = row('Fulano De Tal | fatura de Março de 2031 | cartão final 1111');
  const r = parseCardPdf([
    header,
    row('Período de compras: 05/02 até 05/03', 'Total do seu cartão: R$ 9.000,00'),
    row('Vencimento: 10/03'),
    row('Total a pagar', 'R$ 1.350,50'),
    row('Pagamentos feitos pelo cliente', '-R$ 900,00'),
    row('06 Fev', 'Pagamento de fatura', '- R$ 900,00'),
    row('Lançamentos do cartão físico | Fulano Tal | Final 2222', 'Total do cartão: R$ 1.100,00'),
    row('20 Mar', 'Loja Azul (12/12)', 'R$ 100,00', '01 Mar', 'Mercado Bom', 'R$ 1.000,00'),
    header,
    row('Lançamentos do cartão adicional | Beltrana Tal | Final 3333', 'Total do cartão: R$ 240,50'),
    row('28 Fev Padaria Sol', 'R$ 250,50', '02 Mar', 'Estorno Padaria', '- R$ 10,00'),
    row('Outros Lançamentos', 'Total de outros lançamentos: R$ 10,00'),
    row('04 Mar', 'Anuidade', 'R$ 10,00'),
  ], '2031-03-06');
  assert.equal(r.dueDate, '2031-03-10');
  assert.equal(r.total, '1350.50');
  assert.equal(r.diff, '0.00');
  assert.deepEqual(r.warnings, []);
  assert.deepEqual(r.lines.map((l) => [l.date, l.cardFinal, l.kind, l.amount, l.description, l.installment]), [
    ['2030-03-20', '2222', 'purchase', '100.00', 'Loja Azul', 12],
    ['2031-02-06', null, 'payment', '-900.00', 'Pagamento de fatura', null],
    ['2031-02-28', '3333', 'purchase', '250.50', 'Padaria Sol', null],
    ['2031-03-01', '2222', 'purchase', '1000.00', 'Mercado Bom', null],
    ['2031-03-02', '3333', 'refund', '-10.00', 'Estorno Padaria', null],
    ['2031-03-04', null, 'purchase', '10.00', 'Anuidade', null],
  ]);
  assert.deepEqual(r.cards.map((c) => [c.final, c.holder, c.label, c.sum, c.printedTotal]), [
    ['2222', 'Fulano Tal', 'físico', '1100.00', '1100.00'],
    ['3333', 'Beltrana Tal', 'adicional', '240.50', '240.50'],
  ]);
});

test('planilha com blocos (pagamentos, créditos, compras) e diferença para o total', () => {
  const r = parseCardSheet([{ name: 'Titular', rows: [
    [null, 'Fatura Cartão de Crédito', null, null, null, null, 'Março/2031'],
    [null, 'Vencimento', null, '10/03', null, 'Total da Fatura', null, 1350.5],
    [null, 'Pagamentos feitos pelo cliente', null, null, -900],
    [null, 'Data', 'Descrição', '', 'Valor'],
    [null, '2031-02-06', 'Pagamento de fatura', null, -900],
    [null, 'Total de compras e despesas', null, null, 1340.5],
    [null, 'Data', 'Descrição', '', 'Valor', 'Tipo de compra', 'Código de autorização', 'Final Cartão'],
    [null, '2030-03-20', 'Loja Azul (12/12)', null, 100, 'Parcela sem juros', 'AAA111', '2222'],
    [null, '2031-03-01', 'Mercado Bom', null, 1000, 'Compra à vista', 'BBB222', '2222'],
    [null, '2031-02-28', 'Padaria Sol', null, 250.5, 'Compra à vista', 'CCC333', '3333'],
    [null, '2031-03-02', 'Estorno Padaria', null, -10, 'Compra à vista', 'DDD444', '3333'],
  ] }], '2031-03-06');
  assert.equal(r.dueDate, '2031-03-10');
  assert.equal(r.lines.length, 5);
  assert.equal(r.lines[1].kind, 'payment');
  assert.deepEqual([r.lines[0].installment, r.lines[0].installments, r.lines[0].cardFinal], [12, 12, '2222']);
  assert.equal(r.sum, '1340.50');
  assert.equal(r.diff, '10.00');
  assert.equal(r.warnings.length, 1);
});

test('CSV simples com compras negativas e data sem ano', () => {
  const r = parseCardSheet([{ name: 'csv', rows: [
    ['Data', 'Estabelecimento', 'Parcela', 'Valor (R$)'],
    ['20/12', 'Loja Azul', '2/3', '-50,00'],
    ['05/01', 'Mercado Bom', null, '-1.234,56'],
    ['07/01', 'Estorno', null, '34,56'],
  ] }], '2031-02-08');
  assert.deepEqual(r.lines.map((l) => [l.date, l.kind, l.amount, l.installment]), [
    ['2030-12-20', 'purchase', '50.00', 2],
    ['2031-01-05', 'purchase', '1234.56', null],
    ['2031-01-07', 'refund', '-34.56', null],
  ]);
});
