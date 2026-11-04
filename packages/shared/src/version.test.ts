import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compareVersions, isMajorUpgrade, parseVersion } from './version.js';

test('versões: comparação e salto maior', () => {
  assert.deepEqual(parseVersion('v1.2.3'), [1, 2, 3]);
  assert.equal(parseVersion('1.2'), null);
  assert.ok(compareVersions('1.0.10', '1.0.9') > 0);
  assert.ok(compareVersions('v1.1.0', '1.0.99') > 0);
  assert.equal(compareVersions('v2.0.0', '2.0.0'), 0);
  assert.ok(compareVersions('1.0.0', 'v1.0.1') < 0);
  assert.equal(isMajorUpgrade('1.4.2', 'v2.0.0'), true);
  assert.equal(isMajorUpgrade('1.4.2', 'v1.5.0'), false);
});
