import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkVacation, monthsWorked, parseVacationReport, vacationEntitlement, vacationPeriods, vacationUrgency } from './vacations.js';

// Os números abaixo são os de um relatório real de contador ("Períodos Aquisitivos Abertos", data base 01/09/2026),
// com os nomes trocados: o cálculo daqui tem de dar o mesmo saldo, proporcional e limite sem dobra.
const today = '2026-09-01';

test('direito conforme as faltas injustificadas (art. 130)', () => {
  assert.deepEqual([0, 5, 6, 14, 15, 23, 24, 32, 33].map(vacationEntitlement), [30, 30, 24, 24, 18, 18, 12, 12, 0]);
});

test('meses trabalhados: fração de mais de 14 dias conta como mês', () => {
  assert.equal(monthsWorked('2026-02-01', today), 7);
  assert.equal(monthsWorked('2026-01-07', today), 8); // 7 meses + 25 dias
  assert.equal(monthsWorked('2026-08-10', today), 1); // 22 dias
  assert.equal(monthsWorked('2026-08-20', today), 0); // 12 dias
  assert.equal(monthsWorked('2025-01-01', '2026-06-01'), 12);
});

test('período vencido com saldo cheio e o seguinte em aquisição (limite = fim do concessivo − dias a gozar)', () => {
  const p = vacationPeriods({ admission: '2018-02-01', from: '2025-02-01', today });
  assert.equal(p.length, 2);
  assert.deepEqual([p[0]!.start, p[0]!.end, p[0]!.status, p[0]!.balance, p[0]!.limitStart], ['2025-02-01', '2026-01-31', 'vested', 30, '2027-01-01']);
  assert.deepEqual([p[0]!.concessiveStart, p[0]!.concessiveEnd], ['2026-02-01', '2027-01-31']);
  assert.deepEqual([p[1]!.start, p[1]!.status, p[1]!.accrued, p[1]!.limitStart], ['2026-02-01', 'accruing', 17.5, '2028-01-01']);
});

test('metade já gozada: saldo 15 e limite mais tarde', () => {
  const p = vacationPeriods({ admission: '2018-05-02', from: '2025-05-02', today, entries: [{ periodStart: '2025-05-02', startDate: null, days: 15, soldDays: 0 }] });
  assert.deepEqual([p[0]!.balance, p[0]!.taken, p[0]!.limitStart], [15, 15, '2027-04-16']);
  assert.deepEqual([p[1]!.accrued, p[1]!.limitStart], [10, '2028-04-01']);
});

test('só o período em aquisição (admitido há menos de um ano, ou anterior já resolvido)', () => {
  const a = vacationPeriods({ admission: '2020-01-07', from: '2026-01-07', today });
  assert.deepEqual([a.length, a[0]!.accrued, a[0]!.limitStart, a[0]!.toEnjoy], [1, 20, '2027-12-07', 20]);
  const b = vacationPeriods({ admission: '2026-08-10', today });
  assert.deepEqual([b.length, b[0]!.accrued, b[0]!.limitStart], [1, 2.5, '2028-07-10']);
  assert.deepEqual(vacationPeriods({ admission: '2026-08-01', today })[0]!.accrued, 2.5);
});

test('programadas, vendidas, dobra e urgência', () => {
  const base = { admission: '2018-02-01', from: '2025-02-01' };
  const sched = vacationPeriods({ ...base, today, entries: [{ periodStart: '2025-02-01', startDate: '2026-11-02', days: 20, soldDays: 10 }] });
  assert.deepEqual([sched[0]!.scheduled, sched[0]!.sold, sched[0]!.balance, sched[0]!.limitStart, sched[0]!.toEnjoy], [20, 10, 0, null, 20]);
  // período resolvido some da lista quando as férias já foram gozadas
  const done = vacationPeriods({ ...base, today: '2026-12-01', entries: [{ periodStart: '2025-02-01', startDate: '2026-11-02', days: 20, soldDays: 10 }] });
  assert.deepEqual(done.map((p) => p.start), ['2026-02-01']);
  // perto do limite e depois dele
  const near = vacationPeriods({ ...base, today: '2026-12-10' })[0]!;
  assert.equal(near.daysToLimit, 22);
  assert.equal(vacationUrgency(near, [120, 60, 30]), 'due');
  assert.equal(vacationUrgency(vacationPeriods({ ...base, today: '2026-10-01' })[0]!, [120, 60, 30]), 'soon');
  assert.equal(vacationUrgency(vacationPeriods({ ...base, today: '2026-06-01' })[0]!, [120, 60, 30]), 'ok');
  const late = vacationPeriods({ ...base, today: '2027-01-15' })[0]!;
  assert.equal(vacationUrgency(late, [120, 60, 30]), 'late');
  assert.equal(late.doubledDays, 13); // faltam 17 dias de concessivo para 30 de saldo
  const over = vacationPeriods({ ...base, today: '2027-03-01' })[0]!;
  assert.deepEqual([over.status, over.doubledDays], ['overdue', 30]);
  // programada passando do fim do concessivo
  const cross = vacationPeriods({ ...base, today, entries: [{ periodStart: '2025-02-01', startDate: '2027-01-18', days: 30, soldDays: 0 }] })[0]!;
  assert.equal(cross.doubledDays, 16);
  // faltas reduzem o direito; direito perdido zera
  assert.equal(vacationPeriods({ ...base, today, adjusts: [{ periodStart: '2025-02-01', absences: 10, forfeited: false }] })[0]!.balance, 24);
  assert.deepEqual(vacationPeriods({ ...base, today, adjusts: [{ periodStart: '2025-02-01', absences: 0, forfeited: true }] }).map((p) => p.start), ['2026-02-01']);
});

test('regras de fracionamento, abono e início (art. 134 e 143)', () => {
  const p = { start: '2025-02-01', end: '2026-01-31', entitled: 30, concessiveEnd: '2027-01-31' };
  assert.deepEqual(checkVacation(p, { startDate: '2026-11-02', days: 30, soldDays: 0 }, [], today), []);
  const split = checkVacation(p, { startDate: '2026-11-02', days: 10, soldDays: 0 }, [{ periodStart: p.start, startDate: '2026-06-01', days: 10, soldDays: 0 }], today);
  assert.ok(split.some((w) => w.includes('14 dias')));
  assert.ok(checkVacation(p, { startDate: '2026-11-02', days: 4, soldDays: 0 }, [{ periodStart: p.start, startDate: '2026-06-01', days: 14, soldDays: 0 }], today).some((w) => w.includes('menos de 5')));
  assert.ok(checkVacation(p, { startDate: '2026-11-02', days: 15, soldDays: 15 }, [], today).some((w) => w.includes('1/3')));
  assert.ok(checkVacation(p, { startDate: '2026-11-06', days: 30, soldDays: 0 }, [], today).some((w) => w.includes('sexta ou sábado')));
  assert.ok(checkVacation(p, { startDate: '2026-09-14', days: 30, soldDays: 0 }, [], today).some((w) => w.includes('30 dias')));
  assert.ok(checkVacation(p, { startDate: '2027-01-18', days: 30, soldDays: 0 }, [], today).some((w) => w.includes('em dobro')));
  assert.ok(checkVacation(p, { startDate: '2026-01-05', days: 30, soldDays: 0 }, [], today).some((w) => w.includes('antes de o período')));
});

test('relatório do contador: linhas, data base e colunas vazias', () => {
  const head = [{ x: 16, w: 80, s: 'Contrato do Empregado' }, { x: 186, w: 40, s: 'Lim.S/Dobra' }, { x: 239, w: 30, s: 'Admissão' }, { x: 296, w: 80, s: 'Período (inicial/final)' }, { x: 389, w: 20, s: 'Faltas' }, { x: 425, w: 20, s: 'Afast' }, { x: 484, w: 20, s: 'Saldo' }, { x: 535, w: 20, s: 'Pago' }, { x: 562, w: 8, s: 'Tp' }, { x: 586, w: 10, s: 'Qtd' }];
  const line = (code: string, name: string, lim: string, adm: string, per: string, bal: string, paid: string, tp: string, extra: Array<{ x: number; s: string }> = []) =>
    [{ x: 39, w: 100, s: `${code} ${name}` }, { x: 191, w: 40, s: lim }, { x: 236, w: 40, s: adm }, { x: 293, w: 90, s: per }, ...extra.map((e) => ({ ...e, w: 10 })), { x: 486, w: 20, s: bal }, { x: 539, w: 20, s: paid }, { x: 564, w: 5, s: tp }, { x: 591, w: 8, s: '07' }];
  const r = parseVacationReport([
    [{ x: 16, w: 100, s: '1234-EMPRESA EXEMPLO LTDA' }, { x: 470, w: 60, s: '01/09/2026 14:29' }, { x: 563, w: 30, s: 'Pág:0001' }],
    [{ x: 42, w: 400, s: 'Períodos Aquisitivos Abertos de Férias com a Data Final entre 01/01/1950 até 31/12/2100 Data Base: 01/09/2026' }],
    head,
    line('7', 'FULANO DE TAL', '01/01/2027', '01/02/2018', '01/02/2025 à 31/01/2026', '30,00', '0,00', 'V'),
    line('4', 'BELTRANA DA SILVA', '16/04/2027', '02/05/2018', '02/05/2025 à 01/05/2026', '15,00', '15,00', 'V'),
    line('9', 'SICRANO SOUZA', '01/07/2028', '01/08/2019', '01/08/2026 à 31/07/2027', '2,50', '0,00', 'A', [{ x: 392, s: '7' }, { x: 428, s: '30' }]),
    [{ x: 16, w: 300, s: 'Total Empresa: 1234 - EMPRESA EXEMPLO LTDA' }],
  ]);
  assert.equal(r.baseDate, '2026-09-01');
  assert.equal(r.company, 'EMPRESA EXEMPLO LTDA');
  assert.equal(r.rows.length, 3);
  assert.deepEqual(r.rows[0], { code: '7', name: 'FULANO DE TAL', limit: '2027-01-01', admission: '2018-02-01', periodStart: '2025-02-01', periodEnd: '2026-01-31', absences: 0, leave: 0, balance: 30, paid: 0, kind: 'V' });
  assert.deepEqual([r.rows[1]!.balance, r.rows[1]!.paid], [15, 15]);
  assert.deepEqual([r.rows[2]!.absences, r.rows[2]!.leave, r.rows[2]!.balance, r.rows[2]!.kind], [7, 30, 2.5, 'A']);
});
