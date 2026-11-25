import { test } from 'node:test';
import assert from 'node:assert/strict';
import { distRequestXml, nfeBillDescription, parseDistResponse, parseNfe, parseNfeEvent, parseNfeSummary, sameCnpjRoot } from './nfe.js';

// dados fictícios no leiaute oficial (CNPJs de exemplo válidos, chave inventada)
const KEY = '41261111222333000181550010000012341000012345';
const NFE = `<?xml version="1.0" encoding="UTF-8"?><nfeProc versao="4.00" xmlns="http://www.portalfiscal.inf.br/nfe"><NFe><infNFe Id="NFe${KEY}" versao="4.00">
<ide><cUF>41</cUF><natOp>VENDA DE MERCADORIA</natOp><mod>55</mod><serie>1</serie><nNF>1234</nNF><dhEmi>2026-11-20T18:40:00-03:00</dhEmi><tpNF>1</tpNF></ide>
<emit><CNPJ>11222333000181</CNPJ><xNome>DISTRIBUIDORA EXEMPLO &amp; CIA LTDA</xNome><xFant>EXEMPLO</xFant><enderEmit><xLgr>RUA A</xLgr><xMun>CURITIBA</xMun></enderEmit></emit>
<dest><CNPJ>11444777000161</CNPJ><xNome>FARMACIA MODELO</xNome></dest>
<det nItem="1"><prod><cProd>1</cProd></prod></det><det nItem="2"><prod><cProd>2</cProd></prod></det>
<total><ICMSTot><vProd>300.00</vProd><vNF>300.5</vNF></ICMSTot></total>
<cobr><fat><nFat>1234</nFat><vLiq>300.50</vLiq></fat><dup><nDup>001</nDup><dVenc>2026-12-20</dVenc><vDup>150.25</vDup></dup><dup><nDup>002</nDup><dVenc>2027-01-19</dVenc><vDup>150.25</vDup></dup></cobr>
<pag><detPag><tPag>15</tPag><vPag>300.50</vPag></detPag></pag>
<infAdic><infCpl>PEDIDO 99</infCpl></infAdic></infNFe></NFe>
<protNFe versao="4.00"><infProt><chNFe>${KEY}</chNFe><cStat>100</cStat></infProt></protNFe></nfeProc>`;

test('NF-e completa: emitente, duplicatas e pagamento', () => {
  const n = parseNfe(NFE)!;
  assert.equal(n.key, KEY);
  assert.equal(n.number, '1234');
  assert.equal(n.issuedAt, '2026-11-20');
  assert.equal(n.emitterDocument, '11222333000181');
  assert.equal(n.emitterName, 'DISTRIBUIDORA EXEMPLO & CIA LTDA');
  assert.equal(n.recipientDocument, '11444777000161');
  assert.equal(n.total, '300.50');
  assert.deepEqual(n.duplicates, [
    { number: '001', dueDate: '2026-12-20', amount: '150.25' },
    { number: '002', dueDate: '2027-01-19', amount: '150.25' },
  ]);
  assert.deepEqual(n.paymentKinds, ['15']);
  assert.equal(n.itemCount, 2);
  assert.equal(n.operation, '1');
  assert.equal(nfeBillDescription(n), 'DISTRIBUIDORA EXEMPLO & CIA LTDA — NF 1234');
});

test('NF-e sem cobrança e não NF-e', () => {
  const n = parseNfe(NFE.replace(/<cobr>[\s\S]*<\/cobr>/, ''))!;
  assert.deepEqual(n.duplicates, []);
  assert.equal(parseNfe('<html>x</html>'), null);
});

test('resumo e evento de cancelamento', () => {
  const s = parseNfeSummary(`<resNFe versao="1.01" xmlns="http://www.portalfiscal.inf.br/nfe"><chNFe>${KEY}</chNFe><CNPJ>11222333000181</CNPJ><xNome>DISTRIBUIDORA EXEMPLO</xNome><IE>1</IE><dhEmi>2026-11-20T18:40:00-03:00</dhEmi><tpNF>1</tpNF><vNF>300.50</vNF><cSitNFe>1</cSitNFe></resNFe>`)!;
  assert.equal(s.key, KEY);
  assert.equal(s.total, '300.50');
  assert.equal(s.situation, 'authorized');
  const e = parseNfeEvent(`<resEvento xmlns="http://www.portalfiscal.inf.br/nfe"><cOrgao>41</cOrgao><CNPJ>11222333000181</CNPJ><chNFe>${KEY}</chNFe><dhEvento>2026-11-21T09:00:00-03:00</dhEvento><tpEvento>110111</tpEvento><nSeqEvento>1</nSeqEvento><xEvento>Cancelamento</xEvento></resEvento>`)!;
  assert.equal(e.type, '110111');
  assert.equal(e.key, KEY);
});

test('retorno da distribuição e pedido', () => {
  const r = parseDistResponse(`<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope"><soap:Body><nfeDistDFeInteresseResponse><nfeDistDFeInteresseResult><retDistDFeInt versao="1.01" xmlns="http://www.portalfiscal.inf.br/nfe"><tpAmb>1</tpAmb><cStat>138</cStat><xMotivo>Documento(s) localizado(s)</xMotivo><ultNSU>000000000000012</ultNSU><maxNSU>000000000000020</maxNSU><loteDistDFeInt><docZip NSU="000000000000011" schema="resNFe_v1.01.xsd">H4sI</docZip><docZip NSU="000000000000012" schema="procNFe_v4.00.xsd">H4sJ</docZip></loteDistDFeInt></retDistDFeInt></nfeDistDFeInteresseResult></nfeDistDFeInteresseResponse></soap:Body></soap:Envelope>`);
  assert.equal(r.cStat, '138');
  assert.equal(r.ultNSU, '000000000000012');
  assert.equal(r.docs.length, 2);
  assert.equal(r.docs[1]!.schema, 'procNFe_v4.00.xsd');
  const x = distRequestXml({ production: true, uf: 41, document: '11.444.777/0001-61', lastNsu: '12' });
  assert.match(x, /<tpAmb>1<\/tpAmb><cUFAutor>41<\/cUFAutor><CNPJ>11444777000161<\/CNPJ><distNSU><ultNSU>000000000000012<\/ultNSU>/);
  assert.ok(sameCnpjRoot('11.444.777/0001-61', '11444777000242'));
  assert.ok(!sameCnpjRoot('11444777000161', '11222333000181'));
});
