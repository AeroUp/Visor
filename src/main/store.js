'use strict';
// Tiny JSON settings store in Electron's userData folder.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  hotkey: '`',
  dim: 0.45,
  toasts: true,
  layout: {}, // widgetId -> { x, y, w, h }
  open: [], // widget ids open in the overlay
  pinned: [], // widget ids that stay visible while the overlay is closed
  notes: '',
  notesSavedAt: null,
  lastUserId: null,
  serverSort: 'Desc',
  hideFullServers: true,
  accounts: [], // { id, name, displayName, partition, addedAt }
  accountsMigrated: false,
  joinAs: 'window', // 'window' = the account in the Roblox window you're in, or a saved account id
  multiInstance: false,
};

let file;
let data;
let saveTimer;

function load() {
  file = path.join(app.getPath('userData'), 'visor.json');
  try {
    data = { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch {
    data = { ...DEFAULTS };
  }
}

function flush() {
  if (!data) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function get(key) {
  if (!data) load();
  return key === undefined ? { ...data } : data[key];
}

function set(key, value) {
  if (!data) load();
  data[key] = value;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, 300);
}

module.exports = { get, set, flush, DEFAULTS };
