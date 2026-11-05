import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPayDate, guessPayrollStartYear, parsePayrollSheet, payrollTotals } from './payroll.js';

const R = [
  { id: 'base', section: 'payslip', kind: 'earning' }, { id: 'inss', section: 'payslip', kind: 'deduction' },
  { id: 'meta', section: 'extra', kind: 'earning' }, { id: 'desc', section: 'extra', kind: 'deduction' },
  { id: 'fgts', section: 'employer', kind: 'earning' },
];

test('totais com líquido digitado', () => {
  const t = payrollTotals('1600.00', [{ rubricId: 'meta', amount: '400.00' }, { rubricId: 'desc', amount: '100.00' }, { rubricId: 'fgts', amount: '150' }], R);
  assert.equal(t.total, '1900.00');
  assert.equal(t.offPayroll, '300.00');
  assert.equal(t.onPayroll, '1600.00');
  assert.equal(t.companyCost, '2150.00');
  assert.equal(t.detailed, false);
});

test('holerite detalhado ignora o líquido digitado; desconto maior que extras não gera "por fora"', () => {
  const t = payrollTotals('999', [{ rubricId: 'base', amount: '2000' }, { rubricId: 'inss', amount: '150' }, { rubricId: 'desc', amount: '300' }], R);
  assert.equal(t.payslipNet, '1850.00');
  assert.equal(t.total, '1550.00');
  assert.equal(t.offPayroll, '0.00');
  assert.equal(t.onPayroll, '1550.00');
  assert.equal(t.companyCost, '2000.00');
});

test('5º dia útil conta sábado e pula domingo', () => {
  assert.equal(defaultPayDate('2026-11', 0, 'next'), '2026-12-05'); // ter 1 … sáb 5
  assert.equal(defaultPayDate('2026-01', 0, 'next'), '2026-02-06'); // dom 1 fica de fora
  assert.equal(defaultPayDate('2026-02', 31, 'same'), '2026-02-28');
});

const rows = [
  ['Folha de Pagamento'],
  ['Mês Novembro'],
  ['Funcionário', 'Salário Liquido', 'Meta Global', 'Meta Individual', 'Vitaminas', 'Total Salário', 'Desconto produtos/vale', 'Salário a pagar', 'Valor por fora pago em dinheiro'],
  ['FULANO', 1000, 200, 50, 10, 1260, 60, 1200, 200],
  ['CICLANO', 1500, 0, 0, 0, 1500, 0, 1500, 0, 'HORA EXTRA', 99],
  ['BELTRANA', 1000, 0, 0, 0, 1000, 0, 1150, 150, 150, '10 horas extras'],
  ['VAZIO', 0, 0, 0, 0, 0, 0, 0, 0],
  [],
  ['TOTAL', 3500],
  ['Hora Extra', 'Valor', 'Data'],
  ['Fulano', 80, 46133],
  ['Mês Janeiro'],
  ['Funcionário', 'Salário Liquido', 'Meta/Premiação', 'Total Salário', 'Desconto produtos', 'Salário a pagar'],
  ['Fulano', 1000, 100, 1100, 0, 1100],
] as (string | number | null)[][];

test('lê blocos mensais, vira o ano e ajusta para o total da planilha', () => {
  const r = parsePayrollSheet(rows, 2025);
  assert.deepEqual(r.months.map((m) => m.ref), ['2025-11', '2026-01']);
  assert.match(r.warnings[0], /Falta 1 mês/);
  const [nov] = r.months;
  assert.equal(nov.entries.length, 3);
  const f = nov.entries[0];
  assert.equal(f.name, 'Fulano');
  assert.equal(f.payslipNet, '1000.00');
  assert.deepEqual(f.lines.map((l) => [l.rubric, l.amount]), [['Meta global', '200.00'], ['Meta individual', '50.00'], ['Vitaminas', '10.00'], ['Desconto produtos/vale', '60.00']]);
  assert.match(f.notes ?? '', /Hora extra paga à parte: 80,00 \(21\/04\/2026\)/);
  assert.equal(nov.entries[1].notes, 'Planilha: HORA EXTRA 99,00');
  const b = nov.entries[2];
  assert.deepEqual(b.lines.map((l) => [l.rubric, l.amount]), [['Outros proventos', '150.00']]);
  assert.match(b.lines[0].note ?? '', /hora extra/);
  assert.equal(r.months[1].entries[0].lines[0].rubric, 'Meta global');
});

test('ano inicial: último mês cai no passado', () => {
  assert.equal(guessPayrollStartYear(rows, '2026-11-05'), 2025);
  assert.equal(guessPayrollStartYear(rows, '2026-01-20'), 2025);
});
