import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isProLabore, parsePayslips, payrollPayslipApplySchema, payslipEmployeeFor, payslipItemKey, payslipOk, payslipRubricFor, payslipRubricName, type PdfCell } from './payslips.js';
import { payrollTotals } from './payroll.js';

// células como o pdfToCells devolve (x = começo, w = largura); dados fictícios
const c = (x: number, s: string, w = s.length * 4.2): PdfCell => ({ x, w, s });
/** Valor alinhado à direita na coluna (401 = vencimentos, 491 = descontos). */
const r = (right: number, s: string) => c(right - s.length * 4.2, s);
const words = (x: number, text: string) => { let at = x; return text.split(' ').map((w) => { const cell = c(at, w); at += cell.w + 4; return cell; }); };

function slip(o: { title?: string; code: string; name: string; adm: string; role: string; items: Array<[string | null, string, string | null, 'e' | 'd', string]>; te: string; td: string; net: string; fgts: string; splitRole?: boolean }): PdfCell[][] {
  return [
    [c(48, '99 - EMPRESA EXEMPLO LTDA'), c(330, `Recibo de Pagamento de ${o.title ?? 'Salário'}`)],
    [c(49, 'CNPJ:'), c(75, '00.000.000/0001-00'), c(330, 'Competência:'), c(381, 'Março/2027')],
    [c(47, 'Matricula'), c(83, 'Nome'), c(341, 'Data Admissão'), c(425, 'CTPS')],
    [c(50, o.code), ...words(85, o.name), c(343, o.adm), c(429, '000000000001PR')],
    ...(o.splitRole ? [[...words(85, o.role), c(343, 'VENDAS')], [c(47, 'Função:')]] : [[c(47, 'Função:'), ...words(85, o.role), c(343, 'VENDAS')]]),
    [c(50, 'Código'), c(86, 'Nomenclatura'), c(290, 'Ref.', 13), c(346, 'Vencimentos', 43), c(435, 'Descontos', 35)],
    ...o.items.map(([code, name, ref, kind, v]) => [...(code ? [c(49, code)] : []), ...words(86, name), ...(ref ? [r(299, ref)] : []), r(kind === 'e' ? 401 : 491, v)]),
    [c(328, 'Total de Vantagens', 63), c(418, 'Total de Descontos', 63)],
    [r(400, o.te), r(493, o.td)],
    [c(327, 'Valor Líquido', 59), r(493, o.net)],
    [c(44, 'Demonstrativo - Recibo Vale Transporte', 132), c(197, 'Salário Base', 41), c(266, 'Base FGTS', 37), c(328, 'F.G.T.S', 24), c(380, 'Base INSS', 35), c(446, 'Base IRRF', 35)],
    [r(243, '2.000,00'), r(309, o.te), c(333, o.fgts, 25), r(423, o.te), r(496, '1.000,00')],
    [c(33, '-'), c(45, '-'), c(549, '-'), c(561, '-')],
  ];
}
const ANA = slip({ code: '7', name: 'ANA EXEMPLO DA SILVA', adm: '03/02/2020', role: 'ATENDENTE DE FARMACIA - BALCON', splitRole: true,
  items: [['1', 'SALARIO', '30D', 'e', '2.000,00'], ['13', 'HORAS EXTRAS 50%', '14,00H', 'e', '190,00'], ['236', 'DESCONTO EMPRESTIMO CONSIGNADO', null, 'd', '400,00'], [null, 'I.N.S.S.', '7,81%', 'd', '171,04']],
  te: '2.190,00', td: '571,04', net: '1.618,96', fgts: '175,20' });
const BIA = slip({ title: 'Pro-labore', code: '12', name: 'BIA TESTE', adm: '26/07/2022', role: 'SOCIO GERENTE',
  items: [['56', 'PRO LABORE', null, 'e', '1.621,00'], [null, 'I.N.S.S.', '11%', 'd', '178,31']], te: '1.621,00', td: '178,31', net: '1.442,69', fgts: '0,00' });

test('lê os holerites, separa vencimento de desconto pela coluna e ignora a 2ª via', () => {
  const rep = parsePayslips([...ANA, ...ANA, ...BIA, ...BIA]);
  assert.equal(rep.company, 'EMPRESA EXEMPLO LTDA');
  assert.equal(rep.ref, '2027-03');
  assert.deepEqual(rep.warnings, []);
  assert.equal(rep.slips.length, 2);
  const [ana, bia] = rep.slips;
  assert.deepEqual([ana.code, ana.name, ana.title, ana.admissionDate, ana.role, ana.department], ['7', 'ANA EXEMPLO DA SILVA', 'Salário', '2020-02-03', 'ATENDENTE DE FARMACIA - BALCON', 'VENDAS']);
  assert.deepEqual(ana.items.map((i) => [i.key, i.name, i.ref, i.kind, i.amount]), [
    ['c:1', 'SALARIO', '30D', 'earning', '2000.00'],
    ['c:13', 'HORAS EXTRAS 50%', '14,00H', 'earning', '190.00'],
    ['c:236', 'DESCONTO EMPRESTIMO CONSIGNADO', null, 'deduction', '400.00'],
    ['n:i-n-s-s', 'I.N.S.S.', '7,81%', 'deduction', '171.04'],
  ]);
  assert.deepEqual([ana.totalEarnings, ana.totalDeductions, ana.net, ana.fgts], ['2190.00', '571.04', '1618.96', '175.20']);
  assert.ok(payslipOk(ana));
  assert.deepEqual([bia.title, bia.role, bia.net, bia.fgts], ['Pro-labore', 'SOCIO GERENTE', '1442.69', '0.00']);
});

test('holerite que não fecha com os totais fica com aviso', () => {
  const bad = slip({ code: '9', name: 'CAIO FICTICIO', adm: '01/01/2024', role: 'ENTREGADOR', items: [['1', 'SALARIO', '30D', 'e', '2.000,00']], te: '2.100,00', td: '0,00', net: '2.100,00', fgts: '160,00' });
  const rep = parsePayslips(bad);
  assert.equal(payslipOk(rep.slips[0]!), false);
});

test('recibos diferentes da mesma matrícula: fica o primeiro, com aviso', () => {
  const other = slip({ code: '12', name: 'BIA TESTE', adm: '26/07/2022', role: 'SOCIO GERENTE', items: [['56', 'PRO LABORE', null, 'e', '500,00']], te: '500,00', td: '0,00', net: '500,00', fgts: '0,00' });
  const rep = parsePayslips([...BIA, ...other]);
  assert.equal(rep.slips.length, 1);
  assert.equal(rep.slips[0]!.net, '1442.69');
  assert.match(rep.warnings[0]!, /Bia Teste/);
});

test('PDF que não é holerite não devolve nada', () => {
  assert.deepEqual(parsePayslips([[c(10, 'Relatório de vendas')], [c(10, '1'), c(50, 'GENERICO'), c(300, '10,00')]]).slips, []);
});

test('rubrica sugerida: ligação salva, depois o nome', () => {
  const rubrics = [
    { id: 'r1', name: 'Salário base', section: 'payslip', kind: 'earning' },
    { id: 'r2', name: 'INSS', section: 'payslip', kind: 'deduction' },
    { id: 'r3', name: 'Complemento', section: 'payslip', kind: 'earning' },
    { id: 'r4', name: 'Hora extra', section: 'extra', kind: 'earning' },
  ];
  assert.equal(payslipRubricFor({ key: 'c:1', name: 'SALARIO', kind: 'earning' }, rubrics)?.id, 'r1');
  assert.equal(payslipRubricFor({ key: 'n:i-n-s-s', name: 'I.N.S.S.', kind: 'deduction' }, rubrics)?.id, 'r2');
  assert.equal(payslipRubricFor({ key: 'c:927', name: 'DIFERENCA SALARIAL', kind: 'earning' }, rubrics), null);
  assert.equal(payslipRubricFor({ key: 'c:927', name: 'DIFERENCA SALARIAL', kind: 'earning' }, rubrics, { 'c:927': 'r3' })?.id, 'r3');
  // ligação salva de outro tipo/seção não vale
  assert.equal(payslipRubricFor({ key: 'c:13', name: 'HORAS EXTRAS 50%', kind: 'earning' }, rubrics, { 'c:13': 'r4' }), null);
  assert.equal(payslipRubricName({ name: 'DIFERENCA SALARIAL' }), 'Diferença salarial');
  assert.equal(payslipRubricName({ name: 'PRO LABORE' }), 'Pró-labore');
  assert.equal(payslipRubricName({ name: 'DESCONTO EMPRESTIMO CONSIGNADO' }), 'Empréstimo consignado');
  assert.equal(payslipRubricName({ name: 'GRATIFICACAO DE FUNCAO' }), 'Gratificacao de funcao');
  assert.equal(payslipItemKey(null, 'I.N.S.S.'), 'n:i-n-s-s');
});

test('funcionário sugerido: matrícula primeiro, depois o primeiro nome (se for o único)', () => {
  const emps = [{ id: 'a', name: 'Ana', payslipCode: null }, { id: 'b', name: 'Ana Paula', payslipCode: null }, { id: 'c', name: 'Caio', payslipCode: '9' }];
  assert.deepEqual(payslipEmployeeFor({ code: '7', name: 'ANA EXEMPLO DA SILVA' }, emps), { employee: emps[0], by: 'name' });
  assert.equal(payslipEmployeeFor({ code: '8', name: 'PAULA FICTICIA' }, emps), null);
  assert.equal(payslipEmployeeFor({ code: '9', name: 'OUTRO NOME' }, emps)?.by, 'code');
  // quem já tem matrícula não é sugerido pelo nome para outro holerite
  assert.equal(payslipEmployeeFor({ code: '10', name: 'CAIO FICTICIO' }, emps), null);
});

test('só holerite: guarda o holerite, mas não paga nem custa', () => {
  const rubrics = [{ id: 's', section: 'payslip', kind: 'earning' }, { id: 'i', section: 'payslip', kind: 'deduction' }, { id: 'x', section: 'extra', kind: 'earning' }];
  const lines = [{ rubricId: 's', amount: '2040.00' }, { rubricId: 'i', amount: '159.28' }, { rubricId: 'x', amount: '100.00' }];
  const t = payrollTotals('0', lines, rubrics, undefined, { payslipOnly: true });
  assert.deepEqual([t.payslipNet, t.payslipEarnings, t.total, t.offPayroll, t.onPayroll, t.fgts, t.provisions, t.companyCost], ['1880.72', '2040.00', '0.00', '0.00', '0.00', '0.00', '0.00', '0.00']);
  assert.equal(payrollTotals('0', lines, rubrics).total, '1980.72');
});

test('envio: cada holerite precisa de um funcionário ou de um cadastro novo (não os dois)', () => {
  const s = { code: '7', name: 'ANA', net: '10.00', items: [{ key: 'c:1', name: 'SALARIO', kind: 'earning', amount: '10.00' }] };
  const id = '00000000-0000-4000-8000-000000000001';
  assert.ok(payrollPayslipApplySchema.safeParse({ fileName: 'h.pdf', slips: [{ ...s, employeeId: id }] }).success);
  assert.ok(payrollPayslipApplySchema.safeParse({ fileName: 'h.pdf', slips: [{ ...s, create: { name: 'Ana', payslipOnly: true } }] }).success);
  assert.equal(payrollPayslipApplySchema.safeParse({ fileName: 'h.pdf', slips: [s] }).success, false);
  assert.equal(payrollPayslipApplySchema.safeParse({ fileName: 'h.pdf', slips: [{ ...s, employeeId: id, create: { name: 'Ana' } }] }).success, false);
});

// layout "Demonstrativo de Pagamento de Salário" (outro sistema de folha); dados fictícios
const DEMO = (o: { code: string; name: string; items: PdfCell[][]; te: string; td: string; net: string; fgts: string }): PdfCell[][] => [
  [c(7, '77-EMPRESA DOIS LTDA', 113), c(308, 'Demonstrativo de Pagamento de Salário', 138)],
  [c(7, 'EMPRESA DOIS LTDA', 89), c(102, 'Cidade - PR', 86), c(395, '08/2027', 26), c(453, 'Mensal', 24)],
  [c(9, 'CNPJ', 19), c(61, '00.000.000/0001-00', 65), c(304, 'CPF: 529.982.247-25', 70)],
  [c(12, 'Cadastro', 28), c(70, 'Nome do Funcionário', 71), c(328, 'CBO', 17), c(372, 'Empresa', 28), c(432, 'Local', 19), c(518, 'Departamento', 45), c(585, 'FL', 9)],
  [c(12, o.code, 4), c(70, o.name, 173), c(321, '313310', 24), c(384, '77', 16), c(446, '1', 4), c(537, '001.001', 26), c(586, '01', 8)],
  [c(73, 'TECNICO DE REDES', 121), c(316, 'Data Admissão:', 51), c(428, '01/08/2019', 36)],
  [c(9, 'Ev', 9), c(39, 'Descrição', 33), c(360, 'Referência', 37), c(454, 'Proventos', 34), c(557, 'Descontos', 34)],
  ...o.items,
  [c(39, 'Parabens ! Feliz Aniversario 15/09', 120)],
  [c(340, 'Total', 18), r(489, o.te), r(589, o.td)],
  [c(442, 'Total Líquido', 48), r(589, o.net)],
  [c(57, 'Salário Base', 42), c(147, 'Sal Cont INSS', 49), c(251, 'Bas Cálc FGTS', 53), c(350, 'FGTS Mês', 37), c(440, 'Bas Cálc IRRF', 52), c(524, 'Faixa IRRF', 41), c(575, 'Dep', 13)],
  [r(99, '2.456,00'), r(196, o.te), r(304, o.te), r(387, o.fgts), r(492, '2.522,62'), r(565, '7,50'), c(581, '03', 8)],
  [c(9, 'Recebi em: ____/____/____', 91), c(132, 'Assinatura:_________________________', 136)],
];
const it = (code: string | null, name: string, ref: string | null, kind: 'e' | 'd', v: string): PdfCell[] =>
  [...(code ? [r(31, code)] : []), c(39, name, name.length * 3.5), ...(ref ? [r(390, ref)] : []), r(kind === 'e' ? 488 : 591, v)];

test('layout "Demonstrativo de Pagamento": CPF, mês numérico e sublinhas de contrato fora', () => {
  const rows = DEMO({ code: '9', name: 'DAVI EXEMPLO DE SOUZA', te: '3.386,34', td: '583,88', net: '2.802,46', fgts: '270,90', items: [
    it('1', 'Salario Normal', '30 Dias', 'e', '2.456,00'), it('64', 'Periculosidade', '30,00 %', 'e', '736,80'), it('853', 'Sobre Aviso', '040:00 hs', 'e', '193,54'),
    it('950', 'INSS', '12,00 %', 'd', '294,95'), it('4004', 'Empréstimo Crédito do Trabalhador', null, 'd', '288,93'),
    it(null, 'Contrato: 123 | IF: 341 |', '12/12', 'd', '193,16'), it(null, 'Contrato: 456 | IF: 386 |', '11/12', 'd', '95,77'),
  ] });
  const rep = parsePayslips([...rows, ...rows]);
  assert.deepEqual([rep.company, rep.ref, rep.slips.length, rep.warnings.length], ['EMPRESA DOIS LTDA', '2027-08', 1, 0]);
  const s = rep.slips[0]!;
  assert.deepEqual([s.code, s.name, s.role, s.admissionDate, s.document, s.department], ['9', 'DAVI EXEMPLO DE SOUZA', 'TECNICO DE REDES', '2019-08-01', '529.982.247-25', null]);
  assert.deepEqual(s.items.map((i) => [i.key, i.name, i.ref, i.kind, i.amount]), [
    ['c:1', 'Salario Normal', '30 Dias', 'earning', '2456.00'], ['c:64', 'Periculosidade', '30,00 %', 'earning', '736.80'], ['c:853', 'Sobre Aviso', '040:00 hs', 'earning', '193.54'],
    ['c:950', 'INSS', '12,00 %', 'deduction', '294.95'], ['c:4004', 'Empréstimo Crédito do Trabalhador', null, 'deduction', '288.93'],
  ]);
  assert.deepEqual([s.totalEarnings, s.totalDeductions, s.net, s.fgts], ['3386.34', '583.88', '2802.46', '270.90']);
  assert.ok(payslipOk(s));
  assert.equal(payslipRubricName(s.items[0]!), 'Salário base');
  assert.equal(payslipRubricName(s.items[2]!), 'Sobreaviso');
  assert.equal(payslipRubricName(s.items[4]!), 'Empréstimo consignado');
});

test('pró-labore: sem FGTS, 13º e férias no custo', () => {
  assert.ok(isProLabore('Pró-labore') && isProLabore('PRO LABORE') && !isProLabore('Salário base'));
  const rubrics = [{ id: 'p', section: 'payslip', kind: 'earning', laborCharges: false }, { id: 's', section: 'payslip', kind: 'earning' }, { id: 'i', section: 'payslip', kind: 'deduction' }];
  const pl = payrollTotals('0', [{ rubricId: 'p', amount: '1621.00' }, { rubricId: 'i', amount: '178.31' }], rubrics);
  assert.deepEqual([pl.payslipNet, pl.fgts, pl.provisions, pl.employerCost, pl.companyCost], ['1442.69', '0.00', '0.00', '0.00', '1621.00']);
  const clt = payrollTotals('0', [{ rubricId: 's', amount: '2000.00' }], rubrics);
  assert.equal(clt.fgts, '160.00');
  // fora do Simples o INSS patronal incide também no pró-labore
  const normal = payrollTotals('0', [{ rubricId: 'p', amount: '1000.00' }], rubrics, { regime: 'normal', ratPct: 0, thirdPartyPct: 0, provisions: true });
  assert.deepEqual([normal.fgts, normal.employerInss, normal.provisions], ['0.00', '200.00', '0.00']);
});
