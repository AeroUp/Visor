'use strict';
// Roblox web API client. Requests run in the main process. Each signed-in account lives in its
// own Electron session partition (its own cookie jar); `withAccount(partition, fn)` runs fn's
// requests as that account, and everything else runs in a cookie-less anonymous session.
// Everything except privacy, chat, server avatars, badge ownership and launch tickets works signed out.
const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
// Outside Electron (tools/preview.js) require('electron') is just a path string; fall back to fetch.
const electron = require('electron');
const { session, net } = typeof electron === 'object' ? electron : {};

const LEGACY_PARTITION = 'persist:roblox'; // single-account sign-ins from Fishlay 1.0 (Visor's old name)
const ANON_PARTITION = 'visor-anon'; // in-memory, never signed in
const SEARCH_SESSION = crypto.randomUUID();

const context = new AsyncLocalStorage();
const sessions = new Map(); // partition -> Session
const csrfTokens = new Map(); // partition -> x-csrf-token
let userAgent = null;

const cache = {
  games: new Map(),
  icons: new Map(),
  users: new Map(),
  heads: new Map(),
  universe: new Map(),
  location: new Map(),
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chunk = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
const uniq = (arr) => [...new Set(arr.filter((x) => x !== null && x !== undefined && x !== '').map(String))];

const currentPartition = () => (context.getStore() && context.getStore().partition) || ANON_PARTITION;

function robloxSession(partition = currentPartition()) {
  if (!sessions.has(partition)) {
    const s = session ? session.fromPartition(partition) : { fetch: (url, init) => fetch(url, init), clearStorageData: async () => {} };
    if (userAgent && s.setUserAgent) s.setUserAgent(userAgent);
    sessions.set(partition, s);
  }
  return sessions.get(partition);
}

/** Runs fn with every Roblox request inside it made as the account stored in `partition`. */
function withAccount(partition, fn) {
  return context.run({ partition: partition || ANON_PARTITION }, fn);
}

function configure(opts) {
  if (opts.userAgent) userAgent = opts.userAgent;
}

async function request(url, { method = 'GET', body, retries = 2 } = {}) {
  const partition = currentPartition();
  const csrf = csrfTokens.get(partition) || '';
  const headers = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['x-csrf-token'] = csrf;
  const res = await robloxSession(partition).fetch(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'include',
  });
  if (res.status === 403 && method !== 'GET') {
    const token = res.headers.get('x-csrf-token');
    if (token && token !== csrf && retries > 0) {
      csrfTokens.set(partition, token);
      return request(url, { method, body, retries: retries - 1 });
    }
  }
  if (res.status === 429 && retries > 0) {
    await sleep(1200 * (3 - retries));
    return request(url, { method, body, retries: retries - 1 });
  }
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const msg = (json && ((json.errors && json.errors[0] && json.errors[0].message) || json.message)) || `HTTP ${res.status}`;
    throw new HttpError(res.status, msg);
  }
  return json;
}

// ---------------------------------------------------------------- users

async function authenticatedUser() {
  try {
    const u = await request('https://users.roblox.com/v1/users/authenticated');
    return u && u.id ? { id: String(u.id), name: u.name, displayName: u.displayName } : null;
  } catch (err) {
    if (err.status === 401 || err.status === 403) return null;
    throw err;
  }
}

async function users(ids) {
  const want = uniq(ids).filter((id) => !cache.users.has(id));
  for (const part of chunk(want, 100)) {
    const res = await request('https://users.roblox.com/v1/users', {
      method: 'POST',
      body: { userIds: part.map(Number), excludeBannedUsers: false },
    });
    for (const u of (res && res.data) || []) {
      cache.users.set(String(u.id), { id: String(u.id), name: u.name, displayName: u.displayName });
    }
  }
  const out = {};
  for (const id of uniq(ids)) if (cache.users.has(id)) out[id] = cache.users.get(id);
  return out;
}

async function headshots(ids, size = '150x150') {
  const want = uniq(ids).filter((id) => !cache.heads.has(id));
  for (const part of chunk(want, 100)) {
    const res = await request(
      `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${part.join(',')}&size=${size}&format=Png&isCircular=false`
    );
    for (const t of (res && res.data) || []) {
      if (t.state === 'Completed' && t.imageUrl) cache.heads.set(String(t.targetId), t.imageUrl);
    }
  }
  const out = {};
  for (const id of uniq(ids)) out[id] = cache.heads.get(id) || null;
  return out;
}

async function profile(userId) {
  const id = String(userId);
  const [u, h] = await Promise.all([users([id]), headshots([id])]);
  if (!u[id]) return null;
  return { ...u[id], avatar: h[id] };
}

// ---------------------------------------------------------------- games

async function universeForPlace(placeId) {
  const key = String(placeId);
  if (cache.universe.has(key)) return cache.universe.get(key);
  const res = await request(`https://apis.roblox.com/universes/v1/places/${key}/universe`);
  const id = res && res.universeId ? String(res.universeId) : null;
  if (id) cache.universe.set(key, id);
  return id;
}

async function gameIcons(universeIds) {
  const want = uniq(universeIds).filter((id) => !cache.icons.has(id));
  for (const part of chunk(want, 100)) {
    const res = await request(
      `https://thumbnails.roblox.com/v1/games/icons?universeIds=${part.join(',')}&returnPolicy=PlaceHolder&size=150x150&format=Png&isCircular=false`
    );
    for (const t of (res && res.data) || []) {
      if (t.imageUrl && t.state === 'Completed') cache.icons.set(String(t.targetId), t.imageUrl);
    }
  }
  const out = {};
  for (const id of uniq(universeIds)) out[id] = cache.icons.get(id) || null;
  return out;
}

/** Details + icon for each universe id, keyed by id. Player counts are refreshed every call. */
async function games(universeIds) {
  const ids = uniq(universeIds);
  const fresh = {};
  for (const part of chunk(ids, 50)) {
    const res = await request(`https://games.roblox.com/v1/games?universeIds=${part.join(',')}`);
    for (const g of (res && res.data) || []) {
      const info = {
        universeId: String(g.id),
        placeId: String(g.rootPlaceId),
        name: g.name,
        creatorName: g.creator ? g.creator.name : '',
        creatorType: g.creator ? g.creator.type : '',
        playing: g.playing || 0,
        maxPlayers: g.maxPlayers || 0,
        visits: g.visits || 0,
      };
      cache.games.set(info.universeId, info);
      fresh[info.universeId] = info;
    }
  }
  const icons = await gameIcons(ids).catch(() => ({}));
  const out = {};
  for (const id of ids) {
    const g = fresh[id] || cache.games.get(id);
    if (g) out[id] = { ...g, icon: icons[id] || null };
  }
  return out;
}

async function search(query, pageToken) {
  const q = String(query || '').trim();
  if (!q) return { items: [], nextPageToken: null };
  let url = `https://apis.roblox.com/search-api/omni-search?searchQuery=${encodeURIComponent(q)}&sessionId=${SEARCH_SESSION}&pageType=all`;
  if (pageToken) url += `&pageToken=${encodeURIComponent(pageToken)}`;
  const res = await request(url);
  const items = [];
  for (const group of (res && res.searchResults) || []) {
    if (group.contentGroupType !== 'Game') continue;
    for (const c of group.contents || []) {
      if (!c.universeId || !c.rootPlaceId) continue;
      items.push({
        universeId: String(c.universeId),
        placeId: String(c.rootPlaceId),
        name: c.name,
        creatorName: c.creatorName || '',
        playing: c.playerCount || 0,
      });
    }
  }
  const icons = await gameIcons(items.map((i) => i.universeId)).catch(() => ({}));
  for (const i of items) i.icon = icons[i.universeId] || null;
  return { items, nextPageToken: (res && res.nextPageToken) || null };
}

async function favorites(userId) {
  const res = await request(
    `https://games.roblox.com/v2/users/${encodeURIComponent(userId)}/favorite/games?accessFilter=2&limit=50&sortOrder=Desc`
  );
  const base = ((res && res.data) || []).map((g) => ({
    universeId: String(g.id),
    placeId: String(g.rootPlace ? g.rootPlace.id : ''),
    name: g.name,
    creatorName: g.creator ? g.creator.name : '',
    playing: 0,
  }));
  const details = await games(base.map((g) => g.universeId)).catch(() => ({}));
  return base.map((g) => ({ ...g, ...(details[g.universeId] || {}), name: g.name }));
}

// ---------------------------------------------------------------- servers

async function servers(placeId, { cursor = '', sortOrder = 'Desc', excludeFull = true } = {}) {
  const url =
    `https://games.roblox.com/v1/games/${encodeURIComponent(placeId)}/servers/Public` +
    `?sortOrder=${sortOrder === 'Asc' ? 'Asc' : 'Desc'}&excludeFullGames=${excludeFull ? 'true' : 'false'}&limit=100` +
    (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '');
  const res = await request(url);
  return {
    servers: ((res && res.data) || []).map((s) => ({
      id: s.id,
      playing: s.playing || 0,
      maxPlayers: s.maxPlayers || 0,
      fps: typeof s.fps === 'number' ? s.fps : null,
      ping: typeof s.ping === 'number' ? s.ping : null,
      tokens: (s.playerTokens || []).slice(0, 5),
    })),
    nextCursor: (res && res.nextPageCursor) || null,
  };
}

/** Player tokens from the server list -> headshot urls (tokens are only returned when signed in). */
async function serverAvatars(tokens) {
  const out = {};
  for (const part of chunk(uniq(tokens), 100)) {
    const res = await request('https://thumbnails.roblox.com/v1/batch', {
      method: 'POST',
      body: part.map((token) => ({
        requestId: token,
        type: 'AvatarHeadShot',
        targetId: 0,
        token,
        format: 'png',
        size: '48x48',
      })),
    });
    for (const t of (res && res.data) || []) if (t.imageUrl) out[t.requestId] = t.imageUrl;
  }
  return out;
}

// ---------------------------------------------------------------- badges

async function badges(universeId, userId) {
  const list = [];
  let cursor = '';
  for (let page = 0; page < 5; page++) {
    const res = await request(
      `https://badges.roblox.com/v1/universes/${encodeURIComponent(universeId)}/badges?limit=100&sortOrder=Asc` +
        (cursor ? `&cursor=${encodeURIComponent(cursor)}` : '')
    );
    for (const b of (res && res.data) || []) {
      if (b.enabled === false) continue;
      list.push({
        id: String(b.id),
        name: b.displayName || b.name,
        description: b.displayDescription || b.description || '',
        winRate: b.statistics ? b.statistics.winRatePercentage : null,
        awardedCount: b.statistics ? b.statistics.awardedCount : null,
        icon: null,
        awardedAt: null,
      });
    }
    cursor = res && res.nextPageCursor;
    if (!cursor) break;
  }

  const byId = new Map(list.map((b) => [b.id, b]));
  for (const part of chunk(list.map((b) => b.id), 100)) {
    try {
      const res = await request(
        `https://thumbnails.roblox.com/v1/badges/icons?badgeIds=${part.join(',')}&size=150x150&format=Png&isCircular=false`
      );
      for (const t of (res && res.data) || []) {
        const b = byId.get(String(t.targetId));
        if (b && t.imageUrl) b.icon = t.imageUrl;
      }
    } catch {
      // icons are cosmetic
    }
  }

  let ownershipKnown = false;
  if (userId && list.length) {
    try {
      for (const part of chunk(list.map((b) => b.id), 100)) {
        const res = await request(
          `https://badges.roblox.com/v1/users/${encodeURIComponent(userId)}/badges/awarded-dates?badgeIds=${part.join(',')}`
        );
        for (const a of (res && res.data) || []) {
          const b = byId.get(String(a.badgeId));
          if (b) b.awardedAt = a.awardedDate;
        }
      }
      ownershipKnown = true;
    } catch {
      ownershipKnown = false; // needs sign-in (or a public inventory)
    }
  }
  return { badges: list, ownershipKnown };
}

// ---------------------------------------------------------------- server location

async function serverLocation(ip) {
  if (!ip || !/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return null;
  if (cache.location.has(ip)) return cache.location.get(ip);
  const res = await (net ? net.fetch : fetch)(`https://ipinfo.io/${ip}/json`, { headers: { accept: 'application/json' } });
  if (!res.ok) return null;
  const j = await res.json();
  let country = j.country || '';
  try {
    country = new Intl.DisplayNames(['en'], { type: 'region' }).of(country) || country;
  } catch {
    // keep the ISO code
  }
  const label = [j.city, j.region, country].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(', ');
  cache.location.set(ip, label || null);
  return label || null;
}

// ---------------------------------------------------------------- online status privacy

const ONLINE_KEY = 'whoCanSeeMyOnlineStatus';
const FALLBACK_ONLINE_OPTIONS = ['AllUsers', 'FriendsFollowersAndFollowing', 'FriendsAndFollowing', 'Friends', 'NoOne'];

function findKey(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return undefined;
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const hit = findKey(v, key, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

function optionValue(o) {
  if (typeof o === 'string') return o;
  if (!o || typeof o !== 'object') return null;
  return o.optionValue || o.value || o.name || (o.option && (o.option.optionValue || o.option.value)) || null;
}

async function getOnlineStatus() {
  let node;
  try {
    node = findKey(await request('https://apis.roblox.com/user-settings-api/v1/user-settings/settings-and-options'), ONLINE_KEY);
  } catch (err) {
    if (err.status === 401) throw err;
  }
  if (node === undefined) node = findKey(await request('https://apis.roblox.com/user-settings-api/v1/user-settings'), ONLINE_KEY);
  if (node === undefined) throw new HttpError(404, 'Online status setting not found');

  let current = null;
  let options = [];
  if (typeof node === 'string') current = node;
  else if (node && typeof node === 'object') {
    current = node.currentValue || node.value || node.current || null;
    options = (node.options || node.availableOptions || []).map(optionValue).filter(Boolean);
  }
  if (!options.length) options = FALLBACK_ONLINE_OPTIONS.slice();
  if (current && !options.includes(current)) options.push(current);
  return { current, options };
}

async function setOnlineStatus(value) {
  if (typeof value !== 'string' || !/^[A-Za-z]+$/.test(value)) throw new Error('Invalid option');
  await request('https://apis.roblox.com/user-settings-api/v1/user-settings', {
    method: 'POST',
    body: { [ONLINE_KEY]: value },
  });
  return getOnlineStatus();
}

// ---------------------------------------------------------------- chat
// Roblox's web chat (platform-chat-api). Field names are read defensively because this
// API is undocumented and has changed shape before.

const CHAT = 'https://apis.roblox.com/platform-chat-api/v1';
const pick = (o, ...keys) => {
  for (const k of keys) if (o && o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
};

function normMessage(m) {
  return {
    id: String(pick(m, 'id', 'message_id', 'messageId') || ''),
    text: String(pick(m, 'content', 'text', 'message') || ''),
    senderId: String(pick(m, 'sender_user_id', 'senderUserId', 'senderTargetId') || (m.sender && (m.sender.id || m.sender.user_id)) || ''),
    sentAt: pick(m, 'created_at', 'createdAt', 'sent', 'sent_at') || null,
  };
}

async function chatConversations(myId) {
  const res = await request(`${CHAT}/get-user-conversations?cursor=&pageSize=30&include_user_data=true&include_messages=true`);
  const raw = pick(res, 'conversations', 'data') || [];
  const convos = raw.map((c) => {
    const participants = (pick(c, 'participant_user_ids', 'participantUserIds') || (c.participants || []).map((p) => p.targetId || p.user_id || p.id) || [])
      .map(String);
    const msgs = pick(c, 'messages') || (c.last_message ? [c.last_message] : []);
    return {
      id: String(pick(c, 'id', 'conversation_id', 'conversationId')),
      name: pick(c, 'name', 'title') || '',
      type: pick(c, 'type', 'conversationType') || '',
      participants,
      last: msgs.length ? normMessage(msgs[0]) : null,
      unread: pick(c, 'unread_message_count', 'unreadMessageCount') || 0,
    };
  });
  const others = uniq(convos.flatMap((c) => c.participants)).filter((id) => id !== String(myId));
  const [names, heads] = await Promise.all([users(others).catch(() => ({})), headshots(others).catch(() => ({}))]);
  for (const c of convos) {
    const other = c.participants.filter((id) => id !== String(myId));
    if (!c.name) c.name = other.map((id) => (names[id] ? names[id].displayName : 'User')).join(', ') || 'Conversation';
    c.avatar = other.length ? heads[other[0]] : null;
  }
  return convos;
}

async function chatMessages(conversationId) {
  const res = await request(`${CHAT}/get-conversation-messages?conversation_id=${encodeURIComponent(conversationId)}&cursor=&pageSize=40`);
  const msgs = (pick(res, 'messages', 'data') || []).map(normMessage);
  const ids = uniq(msgs.map((m) => m.senderId));
  const names = await users(ids).catch(() => ({}));
  for (const m of msgs) m.senderName = names[m.senderId] ? names[m.senderId].displayName : '';
  return msgs;
}

async function chatSend(conversationId, text) {
  const content = String(text || '').trim();
  if (!content) return null;
  return request(`${CHAT}/send-messages`, {
    method: 'POST',
    body: { conversation_id: conversationId, messages: [{ content }] },
  });
}

// ---------------------------------------------------------------- auth

/**
 * One-time ticket that lets RobloxPlayerLauncher sign the client in as this account — the same
 * thing roblox.com's Play button does.
 */
async function authTicket() {
  const partition = currentPartition();
  const post = (token) =>
    robloxSession(partition).fetch('https://auth.roblox.com/v1/authentication-ticket', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': token || '', referer: 'https://www.roblox.com/', origin: 'https://www.roblox.com' },
      referrer: 'https://www.roblox.com/',
      body: '{}',
      credentials: 'include',
    });
  let res = await post(csrfTokens.get(partition));
  const token = res.headers.get('x-csrf-token');
  if (res.status === 403 && token) {
    csrfTokens.set(partition, token);
    res = await post(token);
  }
  const ticket = res.headers.get('rbx-authentication-ticket');
  if (!ticket) {
    throw new HttpError(res.status, res.status === 401 ? 'This account’s session expired. Sign in to it again.' : `Roblox refused a launch ticket (HTTP ${res.status}).`);
  }
  return ticket;
}

async function signOut() {
  const partition = currentPartition();
  try {
    await request('https://auth.roblox.com/v2/logout', { method: 'POST', body: {} });
  } catch {
    // Clearing local storage below is what matters.
  }
  csrfTokens.delete(partition);
  await robloxSession(partition).clearStorageData();
}

module.exports = {
  LEGACY_PARTITION,
  ANON_PARTITION,
  withAccount,
  configure,
  authTicket,
  robloxSession,
  authenticatedUser,
  users,
  headshots,
  profile,
  universeForPlace,
  games,
  search,
  favorites,
  servers,
  serverAvatars,
  badges,
  serverLocation,
  getOnlineStatus,
  setOnlineStatus,
  chatConversations,
  chatMessages,
  chatSend,
  signOut,
};
