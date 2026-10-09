'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { migrateFromFishlay } = require('../src/main/migration');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-migration-test-'));
const oldDir = path.join(root, 'Fishlay');
const newDir = path.join(root, 'Visor');
const settings = path.join(newDir, 'visor.json');
const sample = { hotkey: 'PageUp', notes: 'test notes', accounts: [{ id: '123', partition: 'persist:acct-test' }] };
const sourceSession = path.join(oldDir, 'Partitions', 'acct-test', 'Network');
const destSession = path.join(newDir, 'Partitions', 'acct-test', 'Network', 'Cookies');
const originalCopy = fs.cpSync;
try {
  assert.equal(migrateFromFishlay(oldDir, newDir), false);
  fs.mkdirSync(sourceSession, { recursive: true });
  fs.writeFileSync(path.join(oldDir, 'fishlay.json'), JSON.stringify(sample));
  fs.writeFileSync(path.join(sourceSession, 'Cookies'), 'synthetic session fixture');
  fs.cpSync = (src, dest) => {
    fs.mkdirSync(dest, { recursive: true });
    fs.writeFileSync(path.join(dest, 'partial'), 'incomplete');
    throw new Error('simulated locked session');
  };
  assert.throws(() => migrateFromFishlay(oldDir, newDir), /simulated locked/);
  assert.equal(fs.existsSync(settings), false);
  assert.equal(fs.existsSync(path.dirname(destSession)), false);
  assert.equal(fs.readdirSync(newDir).some(name => name.startsWith('.migration-')), false);
  fs.cpSync = originalCopy;
  assert.equal(migrateFromFishlay(oldDir, newDir), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), sample);
  assert.equal(fs.readFileSync(destSession, 'utf8'), 'synthetic session fixture');
  assert.equal(fs.readFileSync(path.join(sourceSession, 'Cookies'), 'utf8'), 'synthetic session fixture');
  fs.writeFileSync(settings, JSON.stringify({ notes: 'new Visor notes' }));
  assert.equal(migrateFromFishlay(oldDir, newDir), false);
  assert.equal(JSON.parse(fs.readFileSync(settings)).notes, 'new Visor notes');
  const invalidDir = path.join(root, 'Invalid');
  fs.writeFileSync(path.join(oldDir, 'fishlay.json'), 'invalid JSON');
  assert.throws(() => migrateFromFishlay(oldDir, invalidDir), SyntaxError);
  assert.equal(fs.existsSync(path.join(invalidDir, 'visor.json')), false);
  console.log('Migration tests passed (copy, retry after failure, source preservation, existing settings, invalid settings).');
} finally {
  fs.cpSync = originalCopy;
  fs.rmSync(root, { recursive: true, force: true });
}
