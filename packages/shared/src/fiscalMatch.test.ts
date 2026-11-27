import { test } from 'node:test';
import assert from 'node:assert/strict';
import { descriptionRoot, fiscalLinkNoteLine, nameTokens, notesAfterLink, scoreBillForNote, type NoteMatchNote } from './fiscalMatch.js';

// dados fictícios
const KEY = '41261111222333000181550010000012341000012345';
const fuel: NoteMatchNote = {
  number: '000777', key: KEY, issuedAt: '2026-11-19', total: '204.05', emitterName: 'COMERCIO DE COMBUSTIVEIS EXEMPLO LTDA',
  duplicates: [{ number: '001', dueDate: '2026-12-12', amount: '204.05' }],
  details: { items: [], itemCount: 1, vehicle: { plate: 'XYZ1A23', model: 'GOL', km: null }, tradeName: null },
};
const bill = (description: string, amount: string, dueDate: string, notes: string | null = null) => ({ description, relatedPerson: null, notes, amount, dueDate });

test('placa na descrição: encontrada mesmo com outro valor (conta do mês do posto)', () => {
  const r = scoreBillForNote(fuel, bill('POSTO CENTRAL - GOL XYZ1A23', '961.57', '2026-12-15'));
  assert.equal(r.level, 'found');
  assert.deepEqual(r.reasons, ['due', 'plate', 'model']);
  // sem a placa na descrição, o modelo sozinho é "talvez" (ex.: "POSTO - GERADOR")
  assert.equal(scoreBillForNote(fuel, bill('POSTO CENTRAL - GOL', '50.00', '2027-01-20')).level, 'maybe');
  // mesmo modelo, outra placa: é outro carro
  assert.equal(scoreBillForNote(fuel, bill('POSTO CENTRAL - GOL ABC1234', '50.00', '2027-01-20')).level, 'none');
  assert.equal(scoreBillForNote(fuel, bill('POSTO CENTRAL - GOL ABC-1234', '50.00', '2027-01-20')).level, 'none');
});

test('valor + vencimento: encontrada; só o nome: talvez; nada: fora', () => {
  assert.equal(scoreBillForNote(fuel, bill('QUALQUER', '204.05', '2026-12-12')).level, 'found');
  assert.equal(scoreBillForNote(fuel, bill('COMBUSTIVEIS EXEMPLO', '50.00', '2027-01-20')).level, 'maybe');
  assert.equal(scoreBillForNote(fuel, bill('ALUGUEL', '1000.00', '2026-12-12')).level, 'none');
});

test('número da NF, chave e vínculo aprendido', () => {
  const n = { ...fuel, details: null, emitterName: 'FORNECEDOR X' };
  assert.ok(scoreBillForNote(n, bill('FIBRA NF777', '10.00', '2027-03-01')).reasons.includes('number'));
  assert.ok(scoreBillForNote(n, bill('FIBRA NF-e 0777', '10.00', '2027-03-01')).reasons.includes('number'));
  assert.ok(!scoreBillForNote(n, bill('FIBRA 7770', '10.00', '2027-03-01')).reasons.includes('number'));
  assert.equal(scoreBillForNote(n, bill('A', '1.00', '2027-03-01', `obs\nNF-e 777 — chave ${KEY}`)).level, 'found');
  const learned = scoreBillForNote(n, bill('POSTO CENTRAL -', '603.20', '2026-12-15'), [descriptionRoot('POSTO CENTRAL - SAVEIRO ABC1234')]);
  assert.ok(learned.reasons.includes('learned'));
  assert.equal(learned.level, 'maybe');
});

test('auxiliares', () => {
  assert.deepEqual(nameTokens('COMERCIO DE COMBUSTIVEIS EXEMPLO LTDA'), ['COMBUSTIVEIS', 'EXEMPLO']);
  assert.equal(descriptionRoot('POSTO CENTRAL - SAVEIRO ABC1234'), 'POSTO CENTRAL');
  assert.equal(descriptionRoot('POSTO CENTRAL -'), 'POSTO CENTRAL');
  assert.equal(descriptionRoot('FORNECEDOR BOBINAS DE FIBRA NF123'), 'FORNECEDOR BOBINAS');
  const line = fiscalLinkNoteLine({ number: '777', series: '12', total: '204.05', key: KEY });
  assert.equal(line, `NF-e 777 série 12 (R$ 204,05) — chave ${KEY}`);
  assert.equal(notesAfterLink(null, line, KEY), line);
  assert.equal(notesAfterLink('Pago no PIX  ', line, KEY), `Pago no PIX\n${line}`);
  assert.equal(notesAfterLink(`x ${KEY}`, line, KEY), `x ${KEY}`);
});
