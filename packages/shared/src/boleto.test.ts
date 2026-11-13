import { test } from 'node:test';
import assert from 'node:assert/strict';
import { barcodeToLinhaArrecadacao, barcodeToLinhaBancaria, dvGeralBancario, findBoletoInText, mod10, mod11Arrecadacao, parseBoleto } from './boleto.js';

// linhas fictícias com os dígitos verificadores calculados
const arrec = (seg: string, id: string, cents: number) => {
  const body = `8${seg}${id}` + String(cents).padStart(11, '0') + '0123'.padEnd(29, '7');
  const dv = (id === '6' || id === '7' ? mod10 : mod11Arrecadacao)(body);
  return parseBoleto(barcodeToLinhaArrecadacao(body.slice(0, 3) + dv + body.slice(3)))!;
};
const bancario = (moeda: string) => {
  const b = `748${moeda}013000000025000` + '1234567890123456789012345';
  return parseBoleto(barcodeToLinhaBancaria(b.slice(0, 4) + dvGeralBancario(b) + b.slice(5)))!;
};

test('findBoletoInText: cada tipo de boleto, formatado, colado e com letras duplicadas', () => {
  const cases = [arrec('3', '6', 18990), arrec('2', '6', 9455), arrec('4', '7', 12000), arrec('5', '8', 3421999), arrec('5', '9', 186191), bancario('9')];
  for (const p of cases) {
    assert.equal(p.valid, true);
    assert.equal(findBoletoInText(`Pagador Fulano\nVencimento 20/11/2026\n${p.line}\nValor 1,00`), p.line);
    assert.equal(findBoletoInText(`abc ${p.line.replace(/\D/g, '')} xyz`), p.line);
    assert.equal(findBoletoInText(p.line.replace(/\d/g, (d) => d + d)), p.line);
  }
  assert.equal(arrec('3', '6', 18990).amount, '189.90');
  assert.equal(bancario('9').amount, '250.00');
});

test('findBoletoInText: números que fecham os DVs por acaso não viram boleto (moeda ≠ 9)', () => {
  const fake = bancario('1'); // todos os DVs conferem, mas o código da moeda não é o Real
  assert.equal(fake.valid, true);
  assert.equal(findBoletoInText(`Chave de acesso e outros números ${fake.line} fim`), null);
  assert.equal(findBoletoInText(`123 ${fake.line.replace(/\D/g, '')} 456`), null);
  assert.equal(findBoletoInText('CNPJ 12.345.678/0001-90 fone (43) 3242-0000 CEP 86130-000'), null);
});

test('arrecadação: o DV geral do código de barras também tem de fechar', () => {
  const ok = arrec('2', '6', 18768);
  assert.equal(ok.valid, true);
  // troca o DV geral e refaz só o DV do 1º bloco: os blocos fecham, o código não
  const b = ok.barcode, wrong = b.slice(0, 3) + ((Number(b[3]) + 1) % 10) + b.slice(4);
  const fake = parseBoleto(barcodeToLinhaArrecadacao(wrong))!;
  assert.equal(fake.valid, false);
  assert.equal(findBoletoInText(`números de uma nota ${fake.line} fim`), null);
  // os dois tipos de DV (módulo 10 e módulo 11), em códigos fictícios
  for (const p of [arrec('3', '6', 9455), arrec('5', '8', 233078), arrec('5', '9', 186191)]) assert.equal(parseBoleto(p.barcode)?.valid, true);
});
