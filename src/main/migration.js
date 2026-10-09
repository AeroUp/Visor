'use strict';
// Run before Electron opens sessions. Keep the source untouched and commit the
// settings last, so an interrupted copy can be retried on the next launch.
const fs = require('fs');
const path = require('path');

function migrateFromFishlay(oldDir, newDir) {
  const source = path.join(oldDir, 'fishlay.json');
  const settings = path.join(newDir, 'visor.json');
  if (!fs.existsSync(source) || fs.existsSync(settings)) return false;
  const contents = fs.readFileSync(source, 'utf8');
  const parsed = JSON.parse(contents);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid Fishlay settings');
  }
  fs.mkdirSync(newDir, { recursive: true });
  const oldParts = path.join(oldDir, 'Partitions');
  const newParts = path.join(newDir, 'Partitions');
  if (fs.existsSync(oldParts)) {
    fs.mkdirSync(newParts, { recursive: true });
    for (const entry of fs.readdirSync(oldParts, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dest = path.join(newParts, entry.name);
      if (fs.existsSync(dest)) continue;
      const staging = fs.mkdtempSync(path.join(newDir, '.migration-'));
      try {
        const copy = path.join(staging, entry.name);
        fs.cpSync(path.join(oldParts, entry.name), copy, { recursive: true });
        fs.renameSync(copy, dest);
      } finally {
        fs.rmSync(staging, { recursive: true, force: true });
      }
    }
  }
  const temp = path.join(newDir, 'visor.json.migrating');
  fs.writeFileSync(temp, contents);
  fs.renameSync(temp, settings);
  return true;
}

module.exports = { migrateFromFishlay };
