import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPixBrCode, parsePix, pixKeyCandidates } from './pix.js';
import { itfWidths } from './boleto.js';

test('PIX: copia e cola montado a partir da chave volta igual na leitura', () => {
  const code = buildPixBrCode({ key: '529.982.247-25', keyType: 'cpf', amount: '1234.5', name: 'Farmácia São João & Cia Ltda — matriz' })!;
  const p = parsePix(code);
  assert.equal(p.crcValid, true);
  assert.equal(p.key, '52998224725');
  assert.equal(p.amount, '1234.50');
  assert.equal(p.merchantName, 'FARMACIA SAO JOAO CIA LTD');
  assert.equal(p.merchantCity, 'BRASIL');
  // exemplo do manual do BR Code (chave aleatória, sem valor): mesmo conteúdo, só o nome em maiúsculas
  const manual = '00020126580014br.gov.bcb.pix0136123e4567-e12b-12d1-a456-4266554400005204000053039865802BR5913Fulano de Tal6008BRASILIA62070503***63041D3D';
  assert.equal(parsePix(manual).crcValid, true);
  const nosso = buildPixBrCode({ key: '123e4567-e12b-12d1-a456-426655440000', keyType: 'random', name: 'Fulano de Tal', city: 'Brasília' })!;
  assert.equal(nosso.slice(0, -4), manual.slice(0, -4).replace('Fulano de Tal', 'FULANO DE TAL'));
  assert.equal(parsePix(nosso).crcValid, true);
});

test('PIX: celular, e-mail, sem valor e chave inválida', () => {
  assert.equal(parsePix(buildPixBrCode({ key: '(65) 99999-1234', keyType: 'phone' })!).key, '+5565999991234');
  assert.equal(parsePix(buildPixBrCode({ key: '+55 65 99999-1234', keyType: 'phone' })!).key, '+5565999991234');
  const semValor = parsePix(buildPixBrCode({ key: 'Fulano@Exemplo.com', keyType: 'email', amount: '0.00' })!);
  assert.equal(semValor.key, 'fulano@exemplo.com');
  assert.equal(semValor.amount, null);
  assert.equal(semValor.merchantName, 'RECEBEDOR');
  assert.equal(buildPixBrCode({ key: 'joão@exemplo.com', keyType: 'email' }), null);
});

test('PIX: 11 dígitos que servem de CPF e de celular pedem escolha', () => {
  assert.deepEqual(pixKeyCandidates('529.982.247-25'), ['cpf']);
  assert.deepEqual(pixKeyCandidates('52998224725'), ['cpf', 'phone']);
  assert.deepEqual(pixKeyCandidates('(65) 99999-1234'), ['phone']);
  assert.deepEqual(pixKeyCandidates('11144477735'), ['cpf']);
  assert.deepEqual(pixKeyCandidates('fulano@exemplo.com'), ['email']);
  assert.deepEqual(pixKeyCandidates('qualquer coisa'), []);
  // acha um número DDD+9… que também fecha como CPF
  let amb = '';
  for (let n = 0; n < 100000 && !amb; n++) {
    const d = `659${String(n).padStart(8, '0')}`;
    if (pixKeyCandidates(d).length === 2) amb = d;
  }
  assert.ok(amb, 'deveria existir um número ambíguo');
  assert.deepEqual(pixKeyCandidates(amb), ['cpf', 'phone']);
});

test('boleto: barras do Intercalado 2 de 5', () => {
  // "12": 1 = WNNNW nas barras, 2 = NWNNW nos espaços
  assert.deepEqual(itfWidths('12'), [1, 1, 1, 1, 3, 1, 1, 3, 1, 1, 1, 1, 3, 3, 3, 1, 1]);
  const w = itfWidths('0'.repeat(44));
  assert.equal(w.length, 4 + 44 * 5 + 3);
  assert.equal(w.reduce((a, b) => a + b, 0), 4 + 44 * 9 + 5);
  assert.deepEqual(itfWidths('123'), []);
  assert.deepEqual(itfWidths('12a4'), []);
});
