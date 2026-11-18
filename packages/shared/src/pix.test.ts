import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc16, findPixInText, parsePix } from './pix.js';

// código dinâmico fictício com espaços no nome do recebedor (como o da guia do FGTS Digital)
const payload = (name: string) => {
  const tlv = (id: string, v: string) => `${id}${String(v.length).padStart(2, '0')}${v}`;
  const body = tlv('00', '01') + tlv('01', '12') + tlv('26', tlv('00', 'br.gov.bcb.pix') + tlv('25', 'pix.example.com/v2/cobv/abc123'))
    + tlv('52', '0000') + tlv('53', '986') + tlv('58', 'BR') + tlv('59', name) + tlv('60', 'Brasilia') + tlv('62', tlv('05', '***')) + '6304';
  return body + crc16(body);
};

test('PIX com espaços no nome do recebedor', () => {
  const code = payload('BANCO EXEMPLO FEDERAL');
  assert.equal(parsePix(code).crcValid, true);
  assert.equal(findPixInText(`Total da Guia: 10,00\n${code} \nPIX Copia e Cola:`), code);
});

test('PIX quebrado em linhas pelo PDF', () => {
  const code = payload('LOJA EXEMPLO');
  const text = `Pague com o PIX\n${code.slice(0, 50)}\n${code.slice(50, 90)}\n${code.slice(90)}\nfim`;
  assert.equal(findPixInText(text), code);
});

test('PIX: texto sem código válido', () => {
  const code = payload('LOJA EXEMPLO');
  const bad = code.slice(0, -1) + (code.endsWith('A') ? 'B' : 'A');
  assert.equal(findPixInText(`${bad} resto`), null);
  assert.equal(findPixInText('nada aqui 000201 6304ABCD'), null);
});
