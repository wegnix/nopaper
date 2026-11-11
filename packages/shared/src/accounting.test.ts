import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountingBillDescription, accountingHandleSchema, accountingIsPayable, accountingSendSchema, accountingUploadSchema } from './accounting.js';
import { DEFAULT_ACCOUNTANT_PERMISSIONS, DEFAULT_OPERATOR_PERMISSIONS, withRequired } from './permissions.js';
import { findBoletoInText } from './boleto.js';

test('área do contador: descrição sugerida da conta', () => {
  assert.equal(accountingBillDescription('das', '2026-10'), 'DAS – Out/2026');
  assert.equal(accountingBillDescription('office_fee', '2027-01'), 'Honorários contabilidade – Jan/2027');
  assert.equal(accountingBillDescription('state_tax', null), 'Guia estadual');
  assert.ok(accountingIsPayable('darf') && !accountingIsPayable('payslip') && !accountingIsPayable('other'));
});

test('área do contador: campos do envio e da conferência', () => {
  assert.deepEqual(accountingUploadSchema.parse({ kind: 'das', competence: '2026-10', note: '  vence dia 20 ' }), { kind: 'das', competence: '2026-10', note: 'vence dia 20' });
  assert.deepEqual(accountingUploadSchema.parse({ kind: 'other', competence: '', note: '' }), { kind: 'other', competence: null, note: null });
  assert.equal(accountingUploadSchema.safeParse({ kind: 'nota', competence: '2026-10' }).success, false);
  assert.equal(accountingUploadSchema.safeParse({ kind: 'das', competence: '2026-13' }).success, false);
  assert.equal(accountingHandleSchema.safeParse({ status: 'done', billId: 'x' }).success, false);
  assert.ok(accountingHandleSchema.safeParse({ status: 'dismissed' }).success);
});

test('envio do espaço para o contador: notas fiscais (padrão) ou outro; tipos do contador não valem', () => {
  assert.deepEqual(accountingSendSchema.parse({ competence: '2026-11', note: '' }), { kind: 'invoice', competence: '2026-11', note: null });
  assert.equal(accountingSendSchema.parse({ kind: 'other', competence: '' }).competence, null);
  assert.equal(accountingSendSchema.safeParse({ kind: 'das', competence: '2026-11' }).success, false);
  // e o contador não envia "notas fiscais" pela tela dele
  assert.equal(accountingUploadSchema.safeParse({ kind: 'invoice', competence: '2026-11' }).success, false);
});

test('grupo Contador só envia; Operadores não ganham a área do contador sozinhos', () => {
  assert.deepEqual(withRequired(DEFAULT_ACCOUNTANT_PERMISSIONS), ['accounting.upload']);
  assert.ok(!DEFAULT_OPERATOR_PERMISSIONS.some((p) => p.startsWith('accounting.')));
});

test('números soltos de um relatório não viram linha digitável', () => {
  // passa nos DVs dos 3 campos, mas não no DV geral (caso real de holerite lido como boleto)
  assert.equal(findBoletoInText('total 2026122115 03995075086 27115039862 7 10641216210011'), null);
});
