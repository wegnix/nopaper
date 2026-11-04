import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMoneyInput, toCents, fromCents, formatBRL } from './money.js';
import { addMonthsISO, addYearsISO } from './dates.js';
import { parseBoleto, mod10, formatLinhaBancaria, barcodeToLinhaBancaria, dvGeralBancario, findBoletoInText } from './boleto.js';
import { parsePix, crc16 } from './pix.js';
import { billListQuerySchema, isPeriodic, occurrenceDate } from './schemas.js';

test('money parsing', () => {
  assert.equal(parseMoneyInput('1.234,56'), '1234.56');
  assert.equal(parseMoneyInput('1234.5'), '1234.50');
  assert.equal(parseMoneyInput('R$ 17.801,01'), '17801.01');
  assert.equal(parseMoneyInput(411.92), '411.92');
  assert.equal(parseMoneyInput('1.000'), '1000.00');
  assert.equal(parseMoneyInput('abc'), null);
  assert.equal(fromCents(toCents('0.1') + toCents('0.2')), '0.30');
  assert.match(formatBRL('1234.5'), /1\.234,50/);
});

test('date math', () => {
  assert.equal(addMonthsISO('2026-01-31', 1), '2026-02-28');
  assert.equal(addMonthsISO('2026-01-31', 2), '2026-03-31');
  assert.equal(addMonthsISO('2026-11-15', 3), '2027-02-15');
  assert.equal(addYearsISO('2024-02-29', 1), '2025-02-28');
});

test('boleto bancario roundtrip', () => {
  // monta um código de barras sintético válido
  const bank = '341', cur = '9', fator = '1500', valor = '0000012345';
  const free = '1234567890123456789012345';
  const partial = bank + cur + 'X' + fator + valor + free;
  const tmp = partial.replace('X', '0');
  const dv = dvGeralBancario(tmp);
  const b44 = partial.replace('X', String(dv));
  const linha = barcodeToLinhaBancaria(b44);
  const info = parseBoleto(formatLinhaBancaria(linha), '2026-06-01');
  assert.ok(info);
  assert.equal(info!.valid, true);
  assert.equal(info!.amount, '123.45');
  assert.equal(info!.dueDate, '2026-07-07'); // 2025-02-22 + 500 dias
  assert.equal(info!.barcode, b44);
  assert.equal(mod10('0019373700'), mod10('0019373700'));
  const found = findBoletoInText(`Pagável em qualquer banco\nLinha: ${formatLinhaBancaria(linha)}\n`);
  assert.equal(found, formatLinhaBancaria(linha));
});

test('pix brcode', () => {
  const body = '00020126360014br.gov.bcb.pix0114+5543999999999520400005303986540510.005802BR5913FULANO DE TAL6008LONDRINA62070503***6304';
  const code = body + crc16(body);
  const p = parsePix(code);
  assert.equal(p.isBrCode, true);
  assert.equal(p.crcValid, true);
  assert.equal(p.key, '+5543999999999');
  assert.equal(p.keyType, 'phone');
  assert.equal(p.amount, '10.00');
  assert.equal(p.merchantName, 'FULANO DE TAL');
  assert.equal(parsePix('fulano@email.com').keyType, 'email');
});

import { cycleForPurchase, cycleForRef, splitInstallments } from './cards.js';
test('card cycles', () => {
  // fecha dia 5, vence dia 12
  assert.deepEqual(cycleForPurchase('2026-11-03', 5, 12), { ref: '2026-11', closingDate: '2026-11-05', dueDate: '2026-11-12' });
  assert.equal(cycleForPurchase('2026-11-05', 5, 12).ref, '2026-12');
  // fecha dia 25, vence dia 5 (mês seguinte)
  assert.deepEqual(cycleForPurchase('2026-11-10', 25, 5), { ref: '2026-12', closingDate: '2026-11-25', dueDate: '2026-12-05' });
  assert.equal(cycleForPurchase('2026-11-26', 25, 5).ref, '2027-01');
  assert.deepEqual(cycleForRef('2026-03', 30, 7), { ref: '2026-03', closingDate: '2026-02-28', dueDate: '2026-03-07' });
  assert.deepEqual(splitInstallments('100.00', 3), ['33.34', '33.33', '33.33']);
});

test('recorrência: semanal, quinzenal, mensal e anual', () => {
  assert.equal(occurrenceDate('weekly', '2026-11-06', 1), '2026-11-13');
  assert.equal(occurrenceDate('weekly', '2026-12-25', 1), '2027-01-01');
  assert.equal(occurrenceDate('biweekly', '2026-11-06', 2), '2026-12-04');
  assert.equal(occurrenceDate('monthly', '2026-01-31', 1), '2026-02-28');
  assert.equal(occurrenceDate('monthly', '2026-02-28', 1, 31), '2026-03-31');
  assert.equal(occurrenceDate('yearly', '2028-02-29', 1), '2029-02-28');
  assert.equal(isPeriodic('weekly'), true);
  assert.equal(isPeriodic('installments'), false);
});

test('lista: filtro de dias do vencimento', () => {
  assert.deepEqual(billListQuerySchema.parse({ type: 'payable', days: '15,5,15' }).days, [15, 5]);
  assert.equal(billListQuerySchema.parse({ type: 'payable' }).days, undefined);
  assert.equal(billListQuerySchema.safeParse({ type: 'payable', days: '15;drop' }).success, false);
  assert.deepEqual(billListQuerySchema.parse({ type: 'payable', days: '0,32,10' }).days, [10]);
});
