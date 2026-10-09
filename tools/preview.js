'use strict';
// UI preview: serves the overlay renderer in a normal browser with a mock bridge.
// Uses your real Roblox logs + live public APIs; launching games is stubbed out.
//   npm run preview            -> http://localhost:5178
//   --bg=path/to/shot.png    optional game screenshot behind the overlay
//   --log=path/to/x.log      use a specific Roblox log instead of the newest one
const http = require('http');
const fs = require('fs');
const path = require('path');
const api = require('../src/main/roblox-api');
const { LogWatcher } = require('../src/main/logwatcher');

const PORT = Number(process.env.PORT || 5178);
const arg = (name) => (process.argv.find((a) => a.startsWith(`--${name}=`)) || '').slice(name.length + 3) || null;
const BG = arg('bg');
const LOG = arg('log');
const RENDERER = path.join(__dirname, '..', 'src', 'renderer');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml' };

const watcher = new LogWatcher();
const memory = { hotkey: '`', dim: 0.45, toasts: true, layout: {}, open: [], pinned: [], notes: '', notesSavedAt: null, serverSort: 'Desc', hideFullServers: true };

// --demo: public stand-ins instead of your own account and play history (for screenshots).
const DEMO = process.argv.includes('--demo');
const DEMO_USER = '156'; // builderman, Roblox's own account
const DEMO_PLACES = ['189707', '142823291', '606849621', '920587237', '2753915549'];
let demo = null;
async function demoSnapshot() {
  if (demo) return demo;
  const now = Date.now();
  const universes = await Promise.all(DEMO_PLACES.map((p) => api.universeForPlace(p).catch(() => null)));
  const games = await api.games(universes.filter(Boolean)).catch(() => ({}));
  const g = games[universes[0]] || {};
  const game = {
    jobId: require('crypto').randomUUID(), placeId: DEMO_PLACES[0], universeId: universes[0], serverType: 'Public',
    startTime: now - 7 * 60e3, active: true, name: g.name, creatorName: g.creatorName, icon: g.icon, location: 'Frankfurt, Germany', joining: false,
  };
  const history = DEMO_PLACES.slice(1).map((placeId, i) => ({
    jobId: require('crypto').randomUUID(), placeId, universeId: universes[i + 1], serverType: 'Public',
    startTime: now - (i + 1) * 50 * 60e3 - 25 * 60e3, endTime: now - (i + 1) * 50 * 60e3, userId: DEMO_USER,
  }));
  const profile = await api.profile(DEMO_USER).catch(() => null);
  demo = { game, history, profile: profile && { ...profile, confirmed: true }, userId: DEMO_USER };
  return demo;
}
if (DEMO) {
  memory.open = ['servers', 'accounts', 'history', 'badges'];
  memory.layout = {
    servers: { x: 32, y: 40, w: 520, h: 600 },
    accounts: { x: 578, y: 40, w: 480, h: 330 },
    history: { x: 578, y: 395, w: 480, h: 245 },
    badges: { x: 1084, y: 40, w: 484, h: 600 },
  };
}

async function snapshot() {
  if (DEMO) return demoSnapshot();
  await new Promise((r) => (watcher.live ? r() : watcher.once('update', r)));
  const snap = watcher.snapshot();
  // Pretend we're in the most recent game so every widget has something to show.
  let current = snap.current;
  let history = snap.history;
  if (!current && history.length) {
    const [last, ...rest] = history;
    current = { ...last, startTime: Date.now() - 118000, active: true };
    history = rest;
  }
  let game = null;
  if (current) {
    const universeId = current.universeId || (await api.universeForPlace(current.placeId));
    const g = (await api.games([universeId]))[universeId] || {};
    game = { ...current, universeId, name: g.name, creatorName: g.creatorName, icon: g.icon, location: await api.serverLocation(current.serverIp).catch(() => null), joining: false };
  }
  const userId = snap.userId;
  const profile = userId ? await api.profile(userId).catch(() => null) : null;
  return { game, history, profile: profile && { ...profile, confirmed: true }, userId };
}

// Mock accounts: you plus Roblox's own public account standing in for an alt.
let mockAccounts = null;
async function accountsPayload(userId, game) {
  if (!mockAccounts) {
    const ids = [userId, '1'].filter(Boolean);
    const [names, heads] = await Promise.all([api.users(ids), api.headshots(ids)]);
    mockAccounts = ids.map((id, i) => ({ id, name: names[id].name, displayName: names[id].displayName, avatar: heads[id], expired: false, addedAt: i }));
  }
  return {
    accounts: mockAccounts,
    clients: [
      { pid: 1, userId, confirmed: true, attached: true, game: game ? { placeId: game.placeId, universeId: game.universeId, jobId: game.jobId, joining: false } : null },
      { pid: 2, userId: '1', confirmed: false, attached: false, game: null },
    ],
    activeUserId: userId,
    multiInstance: { enabled: !!memory.multiInstance, active: !!memory.multiInstance },
  };
}

async function handleCall(channel, args) {
  switch (channel) {
    case 'app:init': {
      const s = await snapshot();
      return { store: memory, profile: s.profile, signedIn: true, accounts: await accountsPayload(s.userId, s.game), game: s.game, history: s.history, open: true, robloxPresent: true, hotkeyOk: true, startWithWindows: false, version: 'preview' };
    }
    case 'api':
      try {
        return { ok: true, data: await api[args[0]](...args.slice(1)) };
      } catch (err) {
        return { ok: false, status: err.status || 0, error: err.message };
      }
    case 'store:set':
      memory[args[0]] = args[1];
      return null;
    case 'notes:save':
      memory.notes = args[0];
      return (memory.notesSavedAt = Date.now());
    case 'hotkey:set':
      memory.hotkey = args[0];
      return { ok: true, hotkey: args[0] };
    case 'roblox:launch':
      console.log('[preview] would launch', JSON.stringify(args[0]));
      return { ok: true };
    case 'accounts:refresh': {
      const s = await snapshot();
      return accountsPayload(s.userId, s.game);
    }
    case 'accounts:remove': {
      mockAccounts = mockAccounts.filter((a) => a.id !== args[0]);
      const s = await snapshot();
      return accountsPayload(s.userId, s.game);
    }
    case 'settings:multi-instance':
      memory.multiInstance = !!args[0];
      return { enabled: memory.multiInstance, active: memory.multiInstance };
    default:
      console.log('[preview] call', channel, JSON.stringify(args));
      return null;
  }
}

const MOCK = `
window.__listeners = {};
window.visor = {
  on(ch, cb) { (window.__listeners[ch] = window.__listeners[ch] || []).push(cb); return () => {}; },
  async call(ch, ...args) {
    if (ch === 'overlay:close') { window.__emit('overlay:state', { open: false }); setTimeout(() => window.__emit('overlay:state', { open: true }), 1200); return; }
    const r = await fetch('/__call', { method: 'POST', body: JSON.stringify({ ch, args }) });
    return r.json();
  },
};
window.__emit = (ch, data) => (window.__listeners[ch] || []).forEach((cb) => cb(data));
`;

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/__call') {
        let body = '';
        for await (const c of req) body += c;
        const { ch, args } = JSON.parse(body);
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify((await handleCall(ch, args)) ?? null));
      }
      if (url.pathname === '/__mock.js') {
        res.writeHead(200, { 'content-type': 'text/javascript' });
        return res.end(MOCK);
      }
      if (url.pathname === '/__preview.css') {
        res.writeHead(200, { 'content-type': 'text/css' });
        return res.end(BG ? 'html{background:#111 url(/__bg.png) center/cover no-repeat !important}' : 'html{background:#3a4250 !important}');
      }
      if (url.pathname === '/__bg.png' && BG) {
        res.writeHead(200, { 'content-type': 'image/png' });
        return fs.createReadStream(BG).pipe(res);
      }
      const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
      const file = path.join(RENDERER, rel);
      if (!file.startsWith(RENDERER) || !fs.existsSync(file)) {
        res.writeHead(404);
        return res.end('not found');
      }
      let data = fs.readFileSync(file);
      if (rel === 'index.html') {
        data = data
          .toString()
          .replace("default-src 'none';", "default-src 'none'; connect-src 'self';")
          .replace('<link rel="stylesheet" href="styles.css" />', '<link rel="stylesheet" href="/__preview.css" />\n    <link rel="stylesheet" href="styles.css" />')
          .replace('<script src="icons.js"></script>', '<script src="/__mock.js"></script>\n    <script src="icons.js"></script>');
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err && err.stack));
    }
  })
  .listen(PORT, () => {
    if (LOG) watcher.replay(path.resolve(LOG));
    else watcher.start();
    console.log(`Visor preview on http://localhost:${PORT}`);
  });
