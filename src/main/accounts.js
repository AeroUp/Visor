'use strict';
// Saved Roblox accounts. Each one is signed in on roblox.com inside its own Electron session
// partition (its own cookie jar), so accounts never mix and Visor never sees a password.
const crypto = require('crypto');
const store = require('./store');
const api = require('./roblox-api');

let list = []; // { id, name, displayName, partition, addedAt, avatar?, expired? }

function load() {
  list = (store.get('accounts') || []).filter((a) => a && a.id && a.partition).map((a) => ({ ...a, id: String(a.id) }));
}

function save() {
  store.set(
    'accounts',
    list.map(({ id, name, displayName, partition, addedAt }) => ({ id, name, displayName, partition, addedAt }))
  );
}

const all = () => list.slice();
const byId = (id) => (id ? list.find((a) => a.id === String(id)) || null : null);
const newPartition = () => `persist:acct-${crypto.randomBytes(6).toString('hex')}`;

/** Public view for the renderer (no partition names). */
const publicList = () => list.map(({ id, name, displayName, avatar, expired, addedAt }) => ({ id, name, displayName, avatar, expired: !!expired, addedAt }));

/** Records an account that just finished signing in inside `partition`. */
async function add(partition, me) {
  const old = byId(me.id);
  if (old && old.partition !== partition) {
    // Signed in again: keep the fresh session, drop the stale one.
    await api.robloxSession(old.partition).clearStorageData().catch(() => {});
  }
  list = list.filter((a) => a.id !== String(me.id));
  list.push({ id: String(me.id), name: me.name, displayName: me.displayName, partition, addedAt: Date.now() });
  save();
}

async function remove(id) {
  const a = byId(id);
  if (!a) return;
  await api.withAccount(a.partition, () => api.signOut()).catch(() => {});
  list = list.filter((x) => x !== a);
  save();
}

/** Checks every stored session, refreshes names and avatars, and migrates the 1.0 sign-in. */
async function refresh() {
  if (!store.get('accountsMigrated')) {
    const me = await api.withAccount(api.LEGACY_PARTITION, () => api.authenticatedUser()).catch(() => null);
    if (me && !byId(me.id)) list.push({ id: String(me.id), name: me.name, displayName: me.displayName, partition: api.LEGACY_PARTITION, addedAt: Date.now() });
    store.set('accountsMigrated', true);
  }
  const heads = await api.headshots(list.map((a) => a.id)).catch(() => ({}));
  await Promise.all(
    list.map(async (a) => {
      if (heads[a.id]) a.avatar = heads[a.id];
      let me;
      try {
        me = await api.withAccount(a.partition, () => api.authenticatedUser());
      } catch {
        return; // offline: leave the status as it was
      }
      a.expired = !me;
      if (me) {
        a.name = me.name;
        a.displayName = me.displayName;
      }
    })
  );
  save();
}

load();

module.exports = { all, byId, publicList, newPartition, add, remove, refresh };
