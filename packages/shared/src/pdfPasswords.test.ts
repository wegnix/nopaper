import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describePdfRule, pdfRulePassword } from './pdfPasswords.js';

test('pdfRulePassword: partes do CPF/CNPJ e senha fixa', () => {
  const org = { orgDocument: '12.345.678/0001-95' };
  assert.equal(pdfRulePassword({ source: 'org_document', part: 'first', length: 4 }, org), '1234');
  assert.equal(pdfRulePassword({ source: 'org_document', part: 'last', length: 4 }, org), '0195');
  assert.equal(pdfRulePassword({ source: 'org_document', part: 'all', length: 4 }, org), '12345678000195');
  assert.equal(pdfRulePassword({ source: 'other_document', part: 'first', length: 5 }, { value: '529.982.247-25' }), '52998');
  assert.equal(pdfRulePassword({ source: 'fixed', part: 'first', length: 4 }, { value: 'Senha 123' }), 'Senha 123');
  // sem dado suficiente, a regra não produz senha
  assert.equal(pdfRulePassword({ source: 'org_document', part: 'first', length: 4 }, { orgDocument: null }), null);
  assert.equal(pdfRulePassword({ source: 'other_document', part: 'first', length: 12 }, { value: '529.982.247-25' }), null);
  assert.equal(pdfRulePassword({ source: 'fixed', part: 'first', length: 4 }, {}), null);
});

test('describePdfRule', () => {
  assert.equal(describePdfRule({ source: 'org_document', part: 'first', length: 4 }), 'os 4 primeiros dígitos do CPF/CNPJ do espaço');
  assert.equal(describePdfRule({ source: 'other_document', part: 'last', length: 1 }), 'o último dígito de outro CPF/CNPJ');
  assert.equal(describePdfRule({ source: 'fixed', part: 'first', length: 4 }), 'senha fixa');
});
