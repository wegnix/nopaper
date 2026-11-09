import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commissionByRubric, commissionNote, commissionRate, mergeCommissionGroups, parseSalesReport, payrollCommissionsSchema, reportGroups, sellerCommission, type CommissionRule } from './commissions.js';

// linhas como o pdfToRows devolve (textos da esquerda para a direita); dados fictícios
const g = (code: string, name: string, qty: string, sales: string) => [`${code} ${name}`, qty, '0,00', '1,00', sales, '0,10', '10,00', '0,00', '0,00', '1,00', '20,00'];
const ROWS: string[][] = [
  ['LOJA EXEMPLO LTDA - FARMACIA EXEMPLO', 'Data:03/11/2026'],
  ['Vendedores:TODOS OS VENDEDORES', 'Seleção Período:01/10/26 A 31/10/26'],
  ['Vendas Vendedor e Grupo Produtos'],
  ['Código', 'Grupo de produtos', 'Quantidade', 'Desconto', 'Custo', 'Vendas', '% Part.', 'de Lucro', 'de Desconto', 'Desconto', 'Vendas', 'Rentab.'],
  ['Vendedor:', '2 ANA EXEMPLO'],
  g('2', 'CAMPANHA CIMED', '4', '100,00'),
  g('9', 'GENERICO', '1.200', '10.000,00'),
  g('17', 'SIMILAR', '50', '2.000,50'),
  g('20', 'VITAMINAS E', '30', '1.500,00'),
  ['Total Vendedor:', '1.284', '0,00', '4,00', '13.600,50', '1,00', '1,00', '1,00', '1,00', '1,00', '1,00'],
  ['Rentab. Vendedor:', '30,00'],
  ['Vendedor:', '8 BRUNO TESTE'],
  g('7', 'ELETRO-PORTATEIS', '3', '209,97'),
  g('20', 'VITAMINAS E', '29', '900,00'),
  ['Total Vendedor:', '33', '0,00', '2,00', '1.000,00', '1,00', '1,00', '1,00', '1,00', '1,00', '1,00'],
  ['Página 1 de 2'],
];

const RULES: CommissionRule[] = [
  { id: 'gs', name: 'Genérico + Similar', groups: [{ code: '9', name: 'GENERICO' }, { code: '17', name: 'SIMILAR' }], base: 'sales', rate: 3, tiers: [], rubricId: '00000000-0000-4000-8000-000000000001', active: true },
  { id: 'ci', name: 'CIMED', groups: [{ code: '2', name: 'CAMPANHA CIMED' }], base: 'quantity', rate: 3, tiers: [], rubricId: '00000000-0000-4000-8000-000000000002', active: true },
  { id: 'vi', name: 'Vitaminas', groups: [{ code: '20', name: 'VITAMINAS E' }], base: 'quantity', rate: 3, tiers: [{ min: 30, rate: 5 }], rubricId: '00000000-0000-4000-8000-000000000003', active: true },
];

test('lê o relatório de vendas', () => {
  const r = parseSalesReport(ROWS);
  assert.equal(r.from, '2026-10-01');
  assert.equal(r.to, '2026-10-31');
  assert.equal(r.company, 'LOJA EXEMPLO LTDA - FARMACIA EXEMPLO');
  assert.deepEqual(r.sellers.map((s) => [s.code, s.name, s.groups.length]), [['2', 'ANA EXEMPLO', 4], ['8', 'BRUNO TESTE', 2]]);
  assert.deepEqual(r.sellers[0].groups[1], { code: '9', name: 'GENERICO', quantity: 1200, sales: '10000.00' });
  assert.equal(r.sellers[1].groups[0].name, 'ELETRO-PORTATEIS');
  // o total do 2º vendedor não bate (33 un · 1.109,97 ≠ 1.000,00)
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /BRUNO TESTE/);
  assert.deepEqual(reportGroups(r).map((x) => x.code), ['2', '7', '9', '17', '20']);
});

test('calcula as comissões (3% e por unidade com meta)', () => {
  const [ana, bruno] = parseSalesReport(ROWS).sellers;
  const a = sellerCommission(ana, RULES);
  assert.deepEqual(a.lines.map((l) => l.amount), ['360.02', '12.00', '150.00']); // 12.000,50 × 3% = 360,015 → 360,02
  assert.equal(a.total, '522.02');
  assert.equal(a.lines[2].tierMin, 30);
  const b = sellerCommission(bruno, RULES);
  assert.deepEqual(b.lines.map((l) => l.amount), ['0.00', '0.00', '87.00']); // 29 un: não bateu a meta
  assert.equal(commissionNote(a.lines.slice(2), '2026-10-01', '2026-10-31'), 'Vendas 01/10–31/10/26: 30 un × R$ 5,00 (meta 30)');
  assert.equal(commissionNote(a.lines.slice(0, 1), null, null), 'Vendas: R$ 12.000,50 × 3%');
  // regra inativa não conta; duas regras na mesma rubrica somam
  const same = RULES.map((r) => ({ ...r, rubricId: RULES[0].rubricId, active: r.id !== 'ci' }));
  const m = commissionByRubric(sellerCommission(ana, same));
  assert.equal(m.size, 1);
  assert.equal(m.get(RULES[0].rubricId)!.amount, '510.02');
});

test('metas: vale a maior atingida', () => {
  const r = { rate: 3, tiers: [{ min: 50, rate: 7 }, { min: 30, rate: 5 }] };
  assert.deepEqual(commissionRate(r, 29), { rate: 3, tierMin: null });
  assert.deepEqual(commissionRate(r, 30), { rate: 5, tierMin: 30 });
  assert.deepEqual(commissionRate(r, 80), { rate: 7, tierMin: 50 });
});

test('configuração: padrão vazio e grupos conhecidos', () => {
  assert.deepEqual(payrollCommissionsSchema.parse({}), { rules: [], groups: [] });
  assert.deepEqual(mergeCommissionGroups([{ code: '20', name: 'VITAMINAS' }, { code: '9', name: 'GEN' }], [{ code: '9', name: 'GENERICO' }, { code: '2', name: 'CIMED' }]),
    [{ code: '2', name: 'CIMED' }, { code: '9', name: 'GENERICO' }, { code: '20', name: 'VITAMINAS' }]);
  assert.throws(() => payrollCommissionsSchema.parse({ rules: [{ ...RULES[0], groups: [] }] }));
});

test('arquivo que não é o relatório: sem vendedores', () => {
  const r = parseSalesReport([['Extrato de conta corrente'], ['01/10 PIX 10,00']]);
  assert.equal(r.sellers.length, 0);
});
