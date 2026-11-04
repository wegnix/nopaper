import { test } from 'node:test';
import assert from 'node:assert/strict';
import { documentError, formatDocument, isValidCNPJ, isValidCPF } from './document.js';
import { orgUpdateSchema } from './schemas.js';

test('CPF: válido, inválido e máscara', () => {
  assert.equal(isValidCPF('529.982.247-25'), true);
  assert.equal(isValidCPF('52998224724'), false);
  assert.equal(isValidCPF('111.111.111-11'), false);
  assert.equal(formatDocument('5299822'), '529.982.2');
  assert.equal(formatDocument('52998224725'), '529.982.247-25');
  assert.match(documentError('5299')!, /incompleto/);
});

test('CNPJ numérico e alfanumérico', () => {
  assert.equal(isValidCNPJ('11.222.333/0001-81'), true);
  assert.equal(isValidCNPJ('11.222.333/0001-80'), false);
  // exemplo oficial da Receita para o CNPJ alfanumérico
  assert.equal(isValidCNPJ('12.ABC.345/01DE-35'), true);
  assert.equal(isValidCNPJ('12ABC34501DE34'), false);
  assert.equal(formatDocument('12abc34501de35'), '12.ABC.345/01DE-35');
  assert.equal(formatDocument('112223330001'), '11.222.333/0001');
});

test('schema do espaço normaliza e recusa inválidos', () => {
  assert.equal(orgUpdateSchema.parse({ document: '11222333000181' }).document, '11.222.333/0001-81');
  assert.equal(orgUpdateSchema.parse({ document: '' }).document, null);
  assert.equal(orgUpdateSchema.safeParse({ document: '52998224724' }).success, false);
});
