import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defaultPayDate, guessPayrollStartYear, parsePayrollSheet, payrollTotals, payslipCheck, DEFAULT_PAYROLL_COSTS, employerInssPct, employeeSchema, whatsappLink, printColumnOrder, mergePrintOrder } from './payroll.js';
import { fromCents } from './money.js';

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
  const t = payrollTotals('999', [{ rubricId: 'base', amount: '2000' }, { rubricId: 'inss', amount: '150' }, { rubricId: 'desc', amount: '300' }], R, { ...DEFAULT_PAYROLL_COSTS, provisions: false });
  assert.equal(t.payslipNet, '1850.00');
  assert.equal(t.total, '1550.00');
  assert.equal(t.offPayroll, '0.00');
  assert.equal(t.onPayroll, '1550.00');
  assert.equal(t.fgts, '160.00');
  assert.equal(t.companyCost, '2160.00');
});

test('custo para a empresa: Simples (só FGTS + reservas) e Lucro Presumido (INSS patronal)', () => {
  const lines = [{ rubricId: 'base', amount: '5226.00' }, { rubricId: 'inss', amount: '533.14' }, { rubricId: 'meta', amount: '800' }];
  const s = payrollTotals('0', lines, R);
  assert.equal(s.fgts, '418.08'); // 8% de 5.226,00
  assert.equal(s.employerInss, '0.00');
  assert.equal(s.provision13, '435.50');
  assert.equal(s.provisionVacation, '580.67');
  assert.equal(s.provisionCharges, '81.29'); // 8% de 1016,17
  assert.equal(s.companyCost, fromCents(522600 + 80000 + 41808 + 43550 + 58067 + 8129));
  const n = payrollTotals('0', lines, R, { regime: 'normal', ratPct: 2, thirdPartyPct: 5.8, provisions: true });
  assert.equal(n.employerInss, '1452.83'); // 27,8%
  assert.equal(employerInssPct({ regime: 'simples_iv', ratPct: 3, thirdPartyPct: 5.8, provisions: true }), 23);
  const typed = payrollTotals('4692.86', [], R);
  assert.equal(typed.fgts, '0.00'); // sem o bruto não dá para calcular
});

test('holerite detalhado confere com o valor líquido do papel (salário + diferença − INSS)', () => {
  const R2 = [...R, { id: 'dif', section: 'payslip', kind: 'earning' }];
  const lines = [{ rubricId: 'base', amount: '4988.00' }, { rubricId: 'dif', amount: '238.00' }, { rubricId: 'inss', amount: '533.14' }, { rubricId: 'fgts', amount: '418.08' }];
  const t = payrollTotals('0', lines, R2);
  assert.equal(t.payslipEarnings, '5226.00');
  assert.equal(t.payslipDeductions, '533.14');
  assert.equal(t.payslipNet, '4692.86');
  assert.deepEqual(payslipCheck('4692.86', t.payslipNet), { state: 'ok', diff: 0 });
  assert.deepEqual(payslipCheck('4692.86', payrollTotals('0', lines.filter((l) => l.rubricId !== 'dif'), R2).payslipNet), { state: 'mismatch', diff: 23800 });
  assert.equal(payslipCheck(null, t.payslipNet).state, 'missing');
  assert.equal(payslipCheck('', t.payslipNet).state, 'missing');
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

test('telefone do funcionário: formata, aceita +55 e gera link do WhatsApp', () => {
  const p = (phone: string) => employeeSchema.safeParse({ name: 'X', phone });
  assert.equal(p('11912345678').data?.phone, '(11) 91234-5678');
  assert.equal(p('+55 (11) 3333-4444').data?.phone, '(11) 3333-4444');
  assert.equal(p('').data?.phone, null);
  assert.equal(p('1234').success, false);
  assert.equal(whatsappLink('(11) 91234-5678'), 'https://wa.me/5511912345678');
  assert.equal(whatsappLink(null), null);
});

test('ordem das colunas da impressão', () => {
  const def = ['net', 'meta', 'vit', 'outros', 'cimed', 'gross', 'total'];
  assert.deepEqual(printColumnOrder(def, []), def);
  // ordem salva; coluna nova entra depois da vizinha padrão; chave que não existe no mês some
  assert.deepEqual(printColumnOrder(def, ['net', 'meta', 'outros', 'vit', 'gross', 'total', 'velha']), ['net', 'meta', 'outros', 'cimed', 'vit', 'gross', 'total']);
  assert.deepEqual(printColumnOrder(['net', 'novo', 'gross'], ['gross', 'net']), ['gross', 'net', 'novo']);
  // salvar num mês sem 'cimed' mantém a posição dela
  assert.deepEqual(mergePrintOrder(['net', 'vit', 'cimed', 'gross'], ['vit', 'net', 'gross']), ['vit', 'cimed', 'net', 'gross']); // continua logo depois de 'vit'
});
