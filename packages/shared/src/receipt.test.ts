import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChargeReceipt } from './receipt.js';

// dados fictícios, no formato do recibo de honorários de um escritório de contabilidade
const RECEIPT = [
  'ESCRITORIO DE CONTABILIDADE EXEMPLO',
  'PIX CPF: Nº 52998224725 ou PIX FONE: 11987654321',
  'CPF: 52998224725',
  'Fone: (11)3333-4444 - E-mail: CONTATO@EXEMPLO.COM',
  'RUA DAS FLORES, 100 - CEP 01000-000 - SAO PAULO - SP',
  'RECIBO: 1001 REF.: 10/2026 VENCIMENTO: 01/11/2026',
  'CLIENTE: 12 EMPRESA MODELO LTDA',
  'Recebi a importância abaixo proveniente de:',
  'HONORARIOS CONTABEIS 825,00',
  'SUBTOTAL: 825,00',
  'ACRÉSCIMO: __________',
  'TOTAL: __________',
  'Para maior clareza, firmamos o presente: Data ____/ ____ / ______',
  'Assinatura',
].join('\n');

test('recibo de cobrança: lê valor, vencimento, chave PIX, emissor e referência', () => {
  assert.deepEqual(parseChargeReceipt(RECEIPT), {
    amount: '825.00', dueDate: '2026-11-01', pixKey: '52998224725', issuer: 'ESCRITORIO DE CONTABILIDADE EXEMPLO', ref: '2026-10',
  });
});
test('recibo de cobrança: total impresso vale mais que o subtotal; sem total, soma o acréscimo', () => {
  assert.equal(parseChargeReceipt(RECEIPT.replace('TOTAL: __________', 'TOTAL: 1.840,50'))?.amount, '1840.50');
  assert.equal(parseChargeReceipt(RECEIPT.replace('ACRÉSCIMO: __________', 'ACRÉSCIMO: 16,50'))?.amount, '841.50');
});
test('recibo de cobrança: sem subtotal usa a linha do honorário', () => {
  assert.equal(parseChargeReceipt(RECEIPT.replace('SUBTOTAL: 825,00\n', ''))?.amount, '825.00');
});
test('recibo de cobrança: data impossível não vira vencimento', () => {
  assert.equal(parseChargeReceipt(RECEIPT.replace('01/11/2026', '31/02/2026'))?.dueDate, null);
});
test('recibo de cobrança: não reconhece outro tipo de documento nem recibo sem valor', () => {
  assert.equal(parseChargeReceipt('Relatório de vendas\nTOTAL: 825,00\nVENCIMENTO: 01/11/2026'), null);
  assert.equal(parseChargeReceipt('RECIBO: 1\nRecebi a importância abaixo\nTOTAL: ______'), null);
  // texto embaralhado (rótulos longe dos valores): nada de vencimento inventado
  assert.equal(parseChargeReceipt('VENCIMENTO: RECIBO:\nRecebi a importância\nSUBTOTAL:\nHONORARIOS CONTABEIS 825,00\n12454 01/11/2026')?.dueDate, null);
});
