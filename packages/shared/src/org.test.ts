import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orgAddressLine, orgContactLine, orgRegistrationsLine } from './org.js';

test('linhas de identificação da empresa: só o que está preenchido', () => {
  const o = { street: 'Rua das Flores', streetNumber: '123', complement: 'Sala 2', district: 'Centro', city: 'Cidade Exemplo', state: 'PR', zipCode: '86000-000',
    phone: '(43) 3242-0000', whatsapp: '(43) 99999-0000', email: 'contato@exemplo.com.br', website: 'www.exemplo.com.br', stateRegistration: '123.456', cityRegistration: null };
  assert.equal(orgAddressLine(o), 'Rua das Flores, 123, Sala 2 - Centro - Cidade Exemplo/PR - CEP 86000-000');
  assert.equal(orgContactLine(o), 'Tel. (43) 3242-0000 · WhatsApp (43) 99999-0000 · contato@exemplo.com.br · www.exemplo.com.br');
  assert.equal(orgRegistrationsLine(o), 'IE 123.456');
  assert.equal(orgAddressLine({ city: 'Cidade Exemplo', state: 'PR' }), 'Cidade Exemplo/PR');
  assert.equal(orgContactLine({ phone: '(43) 3242-0000', whatsapp: '(43) 3242-0000' }), 'Tel. (43) 3242-0000');
  assert.equal(orgAddressLine({}), null);
  assert.equal(orgContactLine(null), null);
  assert.equal(orgRegistrationsLine({ stateRegistration: ' ' }), null);
});
