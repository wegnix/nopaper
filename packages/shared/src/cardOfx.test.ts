import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseOfx } from './bank.js';
import { cardOfxImportSchema, cardOfxLines, cardDescKeys, matchExistingCardTx, parseCardMemo, suggestCardRef } from './cardOfx.js';

// fatura de cartão fictícia no formato do Sicoob (CCSTMTRS; negativo = gasto)
const OFX = `OFXHEADER:100
DATA:OFXSGML
CHARSET:1252
<OFX>
<SIGNONMSGSRSV1><SONRS><FI><ORG>Banco Exemplo</ORG><FID>756</FID></FI></SONRS></SIGNONMSGSRSV1>
<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><CURDEF>BRL</CURDEF>
<CCACCTFROM><ACCTID>1234567</ACCTID></CCACCTFROM>
<BANKTRANLIST><DTSTART>20261110120000[-3:BRT]</DTSTART><DTEND>20261110120000[-3:BRT]</DTEND>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20260904120000[-3:BRT]</DTPOSTED><TRNAMT>100.00</TRNAMT><FITID>1</FITID><MEMO>PAGAMENTO-BOLETO BANCARIO</MEMO></STMTTRN>
<STMTTRN><TRNTYPE>PAYMENT</TRNTYPE><DTPOSTED>20260823120000[-3:BRT]</DTPOSTED><TRNAMT>-100.00</TRNAMT><FITID>2</FITID><MEMO>LOJA EXEMPLO*Loja  02/12   SAO PAULO</MEMO></STMTTRN>
<STMTTRN><TRNTYPE>PAYMENT</TRNTYPE><DTPOSTED>20260910120000[-3:BRT]</DTPOSTED><TRNAMT>-60.00</TRNAMT><FITID>3</FITID><MEMO>MERCADO TESTE                 CURITIBA</MEMO></STMTTRN>
<STMTTRN><TRNTYPE>PAYMENT</TRNTYPE><DTPOSTED>20260924120000[-3:BRT]</DTPOSTED><TRNAMT>-127.90</TRNAMT><FITID>4</FITID><MEMO>MARKET*PLACE          Osasco</MEMO></STMTTRN>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20260924120000[-3:BRT]</DTPOSTED><TRNAMT>127.90</TRNAMT><FITID>5</FITID><MEMO>MARKET*PLACE          Osasco</MEMO></STMTTRN>
<STMTTRN><TRNTYPE>PAYMENT</TRNTYPE><DTPOSTED>20260929120000[-3:BRT]</DTPOSTED><TRNAMT>-30.00</TRNAMT><FITID>6</FITID><MEMO>SEGURO*1 de 4V          SAO PAULO</MEMO></STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>-317.90</BALAMT><DTASOF>20260929120000[-3:BRT]</DTASOF></LEDGERBAL>
</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;

test('memo do cartão: descrição sem cidade e parcela NN/NN', () => {
  assert.deepEqual(parseCardMemo('AMAZON BRV            01/06   SAO PAULO'), { description: 'AMAZON BRV', installment: 1, installments: 6 });
  assert.deepEqual(parseCardMemo('NETFLIX.COMV                  SAO PAULO'), { description: 'NETFLIX.COMV', installment: null, installments: null });
  // "1 de 4" no nome do estabelecimento não é parcela do cartão
  assert.equal(parseCardMemo('SEGURO*1 de 4V          SAO PAULO').installment, null);
  assert.equal(parseCardMemo('LOJA  13/12  CIDADE').installment, null);
  assert.equal(parseCardMemo('EC          *POSTOXY          OSASCO').description, 'EC*POSTOXY');
});

test('linhas da fatura: sinal invertido, pagamento, estorno e parcelas', () => {
  const st = parseOfx(OFX).statements[0];
  assert.equal(st.kind, 'creditcard');
  const lines = cardOfxLines(st);
  assert.deepEqual(lines.map((l) => [l.kind, l.amount]), [['payment', '-100.00'], ['purchase', '100.00'], ['purchase', '60.00'], ['purchase', '127.90'], ['refund', '-127.90'], ['purchase', '30.00']]);
  assert.equal(lines[1].description, 'LOJA EXEMPLO*Loja');
  assert.deepEqual([lines[1].installment, lines[1].installments], [2, 12]);
  assert.equal(lines[2].memo, 'MERCADO TESTE CURITIBA');
  // fecha dia 1, vence dia 11: compras de setembro → fatura de outubro; a parcela 2 de agosto também
  assert.equal(suggestCardRef(lines, 1, 11), '2026-10');
});

test('reconhece o que já está na fatura', () => {
  const lines = cardOfxLines(parseOfx(OFX).statements[0]);
  const m = matchExistingCardTx(lines, [
    { id: 'p2', amount: '100.00', purchaseDate: '2026-08-23', installmentNumber: 2, totalInstallments: 12 },
    { id: 'p1', amount: '100.00', purchaseDate: '2026-08-23', installmentNumber: 1, totalInstallments: 12 },
    { id: 'm', amount: '60.00', purchaseDate: '2026-09-12', installmentNumber: 1, totalInstallments: 1 },
    { id: 'x', amount: '60.00', purchaseDate: '2026-09-20', installmentNumber: 1, totalInstallments: 1 },
  ]);
  assert.equal(m.get('2'), 'p2');
  assert.equal(m.get('3'), 'm');
  assert.equal(m.size, 2);
});

test('chaves de categoria e validação', () => {
  assert.deepEqual(cardDescKeys('MERCADOLIVRE*FLASHCO'), ['mercadolivre*flashco', 'mercadolivre*']);
  assert.deepEqual(cardDescKeys('Padaria São João'), ['padaria sao joao', 'padaria sao joao*']);
  const base = { fitId: '1', date: '2026-09-10', description: 'X', amount: '10.00', categoryId: '00000000-0000-4000-8000-000000000000' };
  assert.ok(cardOfxImportSchema.safeParse({ fileName: 'f.ofx', ref: '2026-10', items: [{ ...base, installment: 2, installments: 12 }] }).success);
  assert.ok(!cardOfxImportSchema.safeParse({ fileName: 'f.ofx', ref: '2026-10', items: [{ ...base, installment: 2, installments: null }] }).success);
});
