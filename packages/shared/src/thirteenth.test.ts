import { test } from 'node:test';
import assert from 'node:assert/strict';
import { thirteenthClash, thirteenthDeadline, thirteenthDefaultPayDate, thirteenthInstallmentOf, thirteenthYearFor } from './thirteenth.js';

test('parcela do 13º pelo título do recibo', () => {
  assert.equal(thirteenthInstallmentOf('13º Salário – 1ª parcela'), 'first');
  assert.equal(thirteenthInstallmentOf('13º Salário – 2ª parcela'), 'second');
  assert.equal(thirteenthInstallmentOf('13º Salário'), 'single');
  assert.equal(thirteenthInstallmentOf('Salário'), null);
  assert.equal(thirteenthInstallmentOf('Férias'), null);
});

test('prazo legal recua para dia útil e vale só no mês da folha', () => {
  assert.equal(thirteenthDeadline('first', 2026), '2026-11-30'); // segunda
  assert.equal(thirteenthDeadline('second', 2026), '2026-12-18'); // 20/12/2026 é domingo
  assert.equal(thirteenthDeadline('first', 2025), '2025-11-28'); // 30/11/2025 é domingo
  assert.equal(thirteenthDefaultPayDate('first', 2026, '2026-11', '2026-11-06'), '2026-11-30');
  assert.equal(thirteenthDefaultPayDate('single', 2026, '2026-12', '2026-12-07'), '2026-12-18');
  // 1ª parcela paga junto em dezembro: vale a data do mês
  assert.equal(thirteenthDefaultPayDate('first', 2026, '2026-12', '2026-12-07'), '2026-12-07');
  assert.equal(thirteenthYearFor('2026-12'), 2026);
  assert.equal(thirteenthYearFor('2027-01'), 2026);
});

test('parcela única não convive com 1ª/2ª', () => {
  assert.equal(thirteenthClash('second', ['first']), null);
  assert.equal(thirteenthClash('first', ['first']), 'first');
  assert.equal(thirteenthClash('single', ['first']), 'first');
  assert.equal(thirteenthClash('first', ['single']), 'single');
  assert.equal(thirteenthClash('single', []), null);
});
