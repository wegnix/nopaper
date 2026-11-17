import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manualSchema, manualVisible } from './manuals.js';

const viewer = (perms: string[], isAdmin = false, isSuperadmin = false) => ({ can: (p: string) => isAdmin || perms.includes(p), isAdmin, isSuperadmin });

test('manuais: para quem aparece', () => {
  const contador = viewer(['accounting.upload']);
  assert.equal(manualVisible(['accountant'], contador), true);
  assert.equal(manualVisible(['bills', 'payroll'], contador), false);
  assert.equal(manualVisible(['all'], contador), true);
  // o administrador do espaço envia ao contador: não é o contador
  const admin = viewer([], true);
  assert.equal(manualVisible(['accountant'], admin), false);
  assert.equal(manualVisible(['admin'], admin), true);
  assert.equal(manualVisible(['platform'], admin), false);
  assert.equal(manualVisible(['platform'], viewer([], false, true)), true);
  assert.equal(manualVisible(['bills'], viewer(['receivable.view'])), true);
  assert.equal(manualVisible(['inexistente'], admin), false);
});

test('manuais: cadastro', () => {
  assert.deepEqual(manualSchema.parse({ title: ' Manual do contador ', description: '', audiences: ['accountant', 'accountant'] }), { title: 'Manual do contador', description: null, audiences: ['accountant'] });
  assert.equal(manualSchema.safeParse({ title: 'Manual', audiences: [] }).success, false);
  assert.equal(manualSchema.safeParse({ title: 'Manual', audiences: ['x'] }).success, false);
});
