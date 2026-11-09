import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountKey, candidatesFor, decodeOfx, normBank, ofxAmount, ofxDate, parseOfx, suggestMatches, txDescription, type MatchBill } from './bank.js';

// OFX 1.02 (SGML) fictício, no padrão dos bancos brasileiros
const SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
ENCODING:USASCII
CHARSET:1252

<OFX>
<SIGNONMSGSRSV1><SONRS><STATUS><CODE>0</CODE></STATUS><DTSERVER>20261109120000[-3:BRT]</DTSERVER>
<FI><ORG>Banco Exemplo</ORG><FID>0756</FID></FI></SONRS></SIGNONMSGSRSV1>
<BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>BRL</CURDEF>
<BANKACCTFROM><BANKID>0756</BANKID><BRANCHID>0001-9</BRANCHID><ACCTID>12345-6</ACCTID><ACCTTYPE>CHECKING</ACCTTYPE></BANKACCTFROM>
<BANKTRANLIST><DTSTART>20261001120000[-3:BRT]</DTSTART><DTEND>20261031120000[-3:BRT]</DTEND>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261010120000[-3:BRT]</DTPOSTED><TRNAMT>-150.00</TRNAMT><FITID>A1</FITID><MEMO>DÉB.CONV.ENERGIA ELÉTRICA</MEMO></STMTTRN>
<STMTTRN><TRNTYPE>CREDIT</TRNTYPE><DTPOSTED>20261005120000[-3:BRT]</DTPOSTED><TRNAMT>1200.00</TRNAMT><FITID>A2</FITID><MEMO>PIX RECEBIDO</MEMO><NAME>Recebimento Pix ANA EXEMPLO</NAME></STMTTRN>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261020120000[-3:BRT]</DTPOSTED><TRNAMT>-80,50</TRNAMT><MEMO>PIX EMITIDO</MEMO><NAME>Pagamento Pix ***.111.222-**</NAME></STMTTRN>
<STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261020120000[-3:BRT]</DTPOSTED><TRNAMT>-80,50</TRNAMT><MEMO>PIX EMITIDO</MEMO><NAME>Pagamento Pix ***.111.222-**</NAME></STMTTRN>
</BANKTRANLIST>
<LEDGERBAL><BALAMT>969.50</BALAMT><DTASOF>20261031120000[-3:BRT]</DTASOF></LEDGERBAL>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;

test('lê OFX SGML (1252, datas e valores)', () => {
  const bytes = new Uint8Array([...SGML].map((c) => c.charCodeAt(0))); // latin1/1252: 1 byte por caractere
  const r = parseOfx(decodeOfx(bytes));
  assert.equal(r.warnings.length, 0);
  assert.equal(r.statements.length, 1);
  const s = r.statements[0];
  assert.deepEqual([s.bankId, s.branchId, s.accountId, s.from, s.to, s.balance, s.balanceDate], ['756', '0001-9', '12345-6', '2026-10-01', '2026-10-31', '969.50', '2026-10-31']);
  assert.deepEqual(s.transactions.map((t) => [t.date, t.amount]), [['2026-10-10', '-150.00'], ['2026-10-05', '1200.00'], ['2026-10-20', '-80.50'], ['2026-10-20', '-80.50']]);
  assert.equal(s.transactions[0].memo, 'DÉB.CONV.ENERGIA ELÉTRICA');
  // sem FITID: identificador pelos dados, e o 2º igual ganha #2
  assert.notEqual(s.transactions[2].fitId, s.transactions[3].fitId);
  assert.match(s.transactions[3].fitId, /#2$/);
});

test('OFX com datas ISO 8601 e XML (OFX 2)', () => {
  const xml = SGML.replace(/<DTPOSTED>20261010120000\[-3:BRT\]/, '<DTPOSTED>2026-10-10T00:00:00Z').replace(/<(TRNTYPE|DTPOSTED|TRNAMT|FITID|MEMO|NAME)>([^<\n]*)/g, '<$1>$2</$1>');
  const s = parseOfx(xml).statements[0];
  assert.equal(s.transactions[0].date, '2026-10-10'); // meia-noite UTC não volta um dia
  assert.equal(s.transactions[0].memo, 'DÉB.CONV.ENERGIA ELÉTRICA');
  assert.equal(ofxDate('20261030'), '2026-10-30');
  assert.equal(ofxDate('2026-13-01'), null);
  assert.equal(ofxAmount('1.234,56'), '1234.56');
  assert.equal(ofxAmount('-1234.5'), '-1234.50');
});

test('arquivo que não é OFX', () => {
  const r = parseOfx('Data;Descrição;Valor\n01/10;PIX;10,00');
  assert.equal(r.statements.length, 0);
  assert.equal(r.warnings.length, 1);
});

test('reconhece a conta (banco, agência e conta)', () => {
  assert.equal(normBank('0756'), '756');
  assert.equal(normBank('1'), '001');
  assert.equal(accountKey('0756', '0001-9', '012345-6'), accountKey('756', '00019', '12345-6'));
  assert.notEqual(accountKey('756', '0001-9', '12345-6'), accountKey('756', '0001-9', '12345-7'));
});

const bill = (over: Partial<MatchBill>): MatchBill => ({ id: 'b', type: 'payable', description: 'Conta', relatedPerson: null, amount: '150.00', dueDate: '2026-10-10', status: 'pending', paidAt: null, paidAmount: null, ...over });

test('sugere pares por valor + data, com a descrição desempatando', () => {
  const txs = [
    { id: 't1', date: '2026-10-10', amount: '-150.00', memo: 'DÉB.CONV.ENERGIA ELÉTRICA', name: null },
    { id: 't2', date: '2026-10-05', amount: '1200.00', memo: 'PIX RECEBIDO', name: 'Recebimento Pix ANA EXEMPLO' },
    { id: 't3', date: '2026-10-20', amount: '-80.50', memo: null, name: null },
  ];
  const bills = [
    bill({ id: 'agua', description: 'Água', dueDate: '2026-10-10' }),
    bill({ id: 'luz', description: 'Energia elétrica', dueDate: '2026-10-12' }),
    bill({ id: 'aluguel', type: 'receivable', description: 'Aluguel', relatedPerson: 'Ana Exemplo', amount: '1200.00', dueDate: '2026-10-05', status: 'paid', paidAt: '2026-10-05', paidAmount: '1200.00' }),
    bill({ id: 'longe', amount: '80.50', dueDate: '2026-11-15' }), // fora da janela de 10 dias
    bill({ id: 'saida-receber', type: 'receivable', amount: '150.00' }), // entrada não casa com saída
  ];
  const m = suggestMatches(txs, bills);
  assert.deepEqual(m.map((x) => [x.txId, x.billId]).sort(), [['t1', 'luz'], ['t2', 'aluguel']]); // "energia" vence a "água" no mesmo valor
  assert.match(m.find((x) => x.txId === 't2')!.reason, /mesmo dia do pagamento/);
  // conta já usada não volta como candidata
  assert.deepEqual(candidatesFor(txs[0], bills, new Set(['luz'])).map((b) => b.id), ['agua']);
});

test('descrição sugerida para conta nova', () => {
  assert.equal(txDescription({ memo: 'PIX EMITIDO OUTRA IF', name: 'Pagamento Pix ***.111.222-**' }), 'PIX EMITIDO OUTRA IF');
  assert.equal(txDescription({ memo: 'TRANSF.REALIZADA', name: 'FAV.: MARIA EXEMPLO' }), 'FAV.: MARIA EXEMPLO');
  assert.equal(txDescription({ memo: null, name: null }), 'Lançamento do extrato');
});
