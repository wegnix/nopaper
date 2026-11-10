import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CARD_CATEGORIES, classifySpending } from './spending.js';

test('tipo de estabelecimento pelo nome', () => {
  const cases: Array<[string, string]> = [
    ['IOF OPERACAO EXTERIOR', 'fees'],
    ['MERCADOLIVRE*LOJAX', 'online'], ['MERCADO*VENDEDOR', 'online'], ['AMAZON BRV', 'online'], ['AMAZON PRIME CANAIS', 'subscriptions'],
    ['SUPERMERCADO BOM PRECO', 'supermarket'], ['MERCADOS DO BAIRRO', 'supermarket'],
    ['SEGURADORA*AUTO01', 'insurance'], ['PORTO SEGURO*1 de 4V', 'insurance'],
    ['NETFLIX.COMV', 'subscriptions'], ['APPLE.COM/BILLV', 'subscriptions'],
    ['GITHUB* SPONSORS', 'tech'],
    ['EC*SHELLXY', 'fuel'], ['abastec*app', 'fuel'], ['AUTO POSTO CENTRAL', 'fuel'],
    ['UBER *TRIP', 'transport'], ['IFOOD *RESTAURANTE', 'food'], ['PADARIA SÃO JOÃO', 'food'],
    ['DROGASIL 123', 'health'], ['HOTEL AGUAS QUENTES', 'leisure'], ['LEROY MERLIN', 'construction'],
    ['LOJA DESCONHECIDA XYZ', 'other'],
  ];
  for (const [d, k] of cases) assert.equal(classifySpending(d), k, d);
});

test('categorias padrão do cartão: chaves e cores sem repetir', () => {
  assert.equal(new Set(DEFAULT_CARD_CATEGORIES.map((c) => c.key)).size, DEFAULT_CARD_CATEGORIES.length);
  assert.equal(new Set(DEFAULT_CARD_CATEGORIES.map((c) => c.color)).size, DEFAULT_CARD_CATEGORIES.length);
});
