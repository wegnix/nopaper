import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameCompany } from './spaceCheck.js';

test('matriz e filial (mesma raiz do CNPJ) contam como a mesma empresa', () => {
  assert.ok(sameCompany('11.222.333/0001-81', '11.222.333/0002-62'));
  assert.ok(sameCompany('11222333000181', '11.222.333/0001-81'));
  assert.ok(!sameCompany('11.222.333/0001-81', '11.222.334/0001-81'));
  assert.ok(!sameCompany('111.222.333-44', '111.222.333-44'), 'CPF não entra nessa regra');
});
