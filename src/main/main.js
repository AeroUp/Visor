'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, BrowserWindow, globalShortcut, ipcMain, screen, shell, clipboard, Tray, Menu } = require('electron');

if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

try {
  require('./migration').migrateFromFishlay(
    path.join(app.getPath('appData'), 'Fishlay'),
    app.getPath('userData')
  );
} catch (error) {
  // Do not let the store create defaults and permanently hide a failed migration.
  console.error('Fishlay migration failed; close Fishlay and retry Visor.', error.code || error.name);
  app.quit();
  return;
}

const store = require('./store');
const win32 = require('./win32');
const api = require('./roblox-api');
const accounts = require('./accounts');
const { LogWatcher } = require('./logwatcher');

const ROOT = path.join(__dirname, '..', '..');
const ICON = path.join(ROOT, 'assets', 'icon.png');
const TRAY_ICON = process.platform === 'win32' ? path.join(ROOT, 'assets', 'icon.ico') : ICON; // .ico stays crisp at every DPI
const TICK_MS = 120;
const ROBLOX_GONE_MS = 4000;
// Focus can flicker (or read as "no window") while Windows hands it between windows;
// only react once it has really moved away for this many ticks.
const INACTIVE_TICKS = 3;

app.setAppUserModelId('com.aeroup.visor');

let overlay = null;
let overlayHwnd = 0n;
let authWin = null;
let tray = null;
const watcher = new LogWatcher();

const state = {
  open: false,
  passive: false, // renderer has pinned widgets / toasts showing while closed
  roblox: null, // HWND of the Roblox window the overlay is attached to
  robloxSeenAt: 0,
  clients: new Map(), // pid -> { pid, address, file } — one per open Roblox window
  clientsCheckedAt: 0,
  activeFile: null, // log of the attached window's client
  activeUserId: null, // account playing in the attached window
  bounds: null,
  hotkeyWanted: false,
  hotkeyOk: true,
  hotkeySuspended: false,
  profile: null,
  signedIn: false,
  profileSeq: 0,
  game: null,
  gameSig: '',
  history: [],
  gameSeq: 0,
  zoom: 0,
  inactiveTicks: 0,
  multiActive: false,
};

// Small rolling diagnostic log in %APPDATA%\Visor\visor.log
let logFile = null;
function log(...parts) {
  try {
    if (!logFile) {
      logFile = path.join(app.getPath('userData'), 'visor.log');
      if (fs.existsSync(logFile) && fs.statSync(logFile).size > 512 * 1024) fs.renameSync(logFile, logFile + '.old');
    }
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${parts.join(' ')}\n`);
  } catch {
    // logging must never break the overlay
  }
}

const send = (channel, data) => {
  if (overlay && !overlay.isDestroyed()) overlay.webContents.send(channel, data);
};

// ------------------------------------------------------------------ overlay window

function createOverlay() {
  overlay = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    thickFrame: false,
    title: 'Visor',
    icon: ICON,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  overlay.setMenu(null);
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.setIgnoreMouseEvents(true);
  overlayHwnd = overlay.getNativeWindowHandle().readBigUInt64LE(0);
  win32.disableTransitions(overlayHwnd);
  overlay.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  overlay.webContents.on('will-navigate', (e) => e.preventDefault());
  overlay.webContents.on('did-finish-load', () => {
    state.zoom = 0;
    applyZoom();
  });
  overlay.loadFile(path.join(ROOT, 'src', 'renderer', 'index.html'));
}

function hideOverlay() {
  if (overlay && overlay.isVisible()) overlay.hide();
}

function openOverlay() {
  if (!state.roblox || authWin) return;
  log('open');
  state.open = true;
  syncBounds();
  overlay.setIgnoreMouseEvents(false);
  if (!overlay.isVisible()) overlay.show();
  overlay.setAlwaysOnTop(true, 'screen-saver');
  overlay.focus();
  overlay.webContents.focus();
  send('overlay:state', { open: true });
}

function closeOverlay(restoreFocus = true, reason = 'user') {
  if (!state.open) return;
  log('close', reason);
  state.open = false;
  overlay.setIgnoreMouseEvents(true);
  send('overlay:state', { open: false });
  if (restoreFocus && state.roblox) win32.setForeground(state.roblox);
}

function toggleOverlay() {
  if (state.open) closeOverlay();
  else openOverlay();
}

function syncBounds() {
  if (!state.roblox) return;
  const r = win32.clientRect(state.roblox);
  if (!r || r.width < 50 || r.height < 50) return;
  const d = screen.screenToDipRect(null, r);
  const b = { x: Math.round(d.x), y: Math.round(d.y), width: Math.round(d.width), height: Math.round(d.height) };
  const p = state.bounds;
  if (!p || p.x !== b.x || p.y !== b.y || p.width !== b.width || p.height !== b.height) {
    state.bounds = b;
    overlay.setBounds(b);
    applyZoom();
  }
}

function applyZoom() {
  if (!state.bounds) return;
  const z = Math.min(1.4, Math.max(0.7, Math.min(state.bounds.width / 1920, state.bounds.height / 1080)));
  if (Math.abs(z - state.zoom) < 0.01) return;
  state.zoom = z;
  overlay.webContents.setZoomFactor(z);
}

// ------------------------------------------------------------------ hotkey

function setHotkey(on) {
  on = on && !state.hotkeySuspended;
  if (on === state.hotkeyWanted) return;
  state.hotkeyWanted = on;
  if (on) {
    let ok = false;
    try {
      ok = globalShortcut.register(store.get('hotkey'), toggleOverlay);
    } catch {
      ok = false;
    }
    log('hotkey', store.get('hotkey'), ok ? 'registered' : 'FAILED');
    if (ok !== state.hotkeyOk) {
      state.hotkeyOk = ok;
      send('settings:update', { hotkey: store.get('hotkey'), hotkeyOk: ok });
    }
  } else {
    globalShortcut.unregisterAll();
  }
}

function changeHotkey(accel) {
  const prev = store.get('hotkey');
  globalShortcut.unregisterAll();
  let ok = false;
  try {
    ok = globalShortcut.register(accel, toggleOverlay);
  } catch {
    ok = false;
  }
  globalShortcut.unregisterAll();
  if (!ok) {
    state.hotkeyWanted = false; // re-register the previous one on the next tick
    return { ok: false, hotkey: prev, error: `“${accel}” is unavailable (another app may be using it).` };
  }
  store.set('hotkey', accel);
  state.hotkeyOk = true;
  state.hotkeyWanted = false;
  updateTray();
  return { ok: true, hotkey: accel };
}

// ------------------------------------------------------------------ Roblox windows & clients

/** Matches every open Roblox window to the log its process writes. Returns true if anything changed. */
function trackClients(windows) {
  let changed = false;
  const alive = new Set(windows.map((w) => w.pid));
  for (const [pid, c] of state.clients) {
    if (alive.has(pid)) continue;
    if (c.file) watcher.clientClosed(c.file);
    state.clients.delete(pid);
    log('roblox client closed', pid);
    changed = true;
  }
  for (const w of windows) {
    let c = state.clients.get(w.pid);
    if (!c) {
      c = { pid: w.pid, address: w.address, file: null };
      state.clients.set(w.pid, c);
      changed = true;
    }
    c.address = w.address;
    if (!c.file) {
      const created = win32.processCreatedAt(w.pid);
      c.file = created ? watcher.logForProcess(created) : null;
      if (c.file) {
        log('roblox client', w.pid, '->', path.basename(c.file));
        changed = true;
      }
    }
  }
  return changed;
}

function tick() {
  if (!overlay) return;
  const now = Date.now();
  const windows = win32.robloxWindows();
  if (windows.length !== state.clients.size || now - state.clientsCheckedAt > 1000) {
    state.clientsCheckedAt = now;
    if (trackClients(windows)) sendAccountsSoon();
  }

  const fg = win32.foreground();
  const fgAddr = win32.addr(fg);
  // Attach to the Roblox window you're in; while the overlay itself has focus, stay where we were.
  const fgWindow = windows.find((w) => w.address === fgAddr);
  const kept = state.roblox ? windows.find((w) => w.address === win32.addr(state.roblox)) : null;
  const target = fgWindow || kept || windows[0];

  if (!target) {
    if (state.roblox && now - state.robloxSeenAt > ROBLOX_GONE_MS) {
      state.roblox = null;
      state.bounds = null;
      watcher.clientClosed();
      send('roblox:present', false);
      log('roblox window gone');
    }
    if (!state.roblox) {
      if (state.open) closeOverlay(false);
      hideOverlay();
      setHotkey(false);
    }
    return;
  }

  if (!state.roblox) {
    send('roblox:present', true);
    log('roblox window found', String(target.address));
  }
  if (!state.roblox || win32.addr(state.roblox) !== target.address) state.bounds = null;
  state.roblox = target.hwnd;
  state.robloxSeenAt = now;

  const client = state.clients.get(target.pid);
  const file = (client && client.file) || null;
  if (file !== state.activeFile) {
    state.activeFile = file;
    log('attached to', target.pid, file ? path.basename(file) : '(log not found yet)');
    refreshProfile();
    onWatcherUpdate();
  }

  if (!fgAddr) return; // focus is mid-transition; keep the current state
  const fgIsRoblox = fgAddr === target.address;
  const fgIsOurs = fgAddr === overlayHwnd || (!!fg && win32.processId(fg) === process.pid);
  const active = !authWin && !win32.isMinimized(target.hwnd) && (fgIsRoblox || fgIsOurs);
  if (active) state.inactiveTicks = 0;
  else if (++state.inactiveTicks < INACTIVE_TICKS) return;

  setHotkey(active);
  if (!active) {
    if (state.open && !fgIsOurs) closeOverlay(false, 'focus moved to another app');
    hideOverlay();
    return;
  }

  syncBounds();
  // The window stays up (transparent and click-through when closed) the whole time Roblox is
  // focused, so opening is just a repaint — no window show animation or first-paint delay.
  if (!overlay.isVisible()) {
    overlay.showInactive();
    overlay.setAlwaysOnTop(true, 'screen-saver');
  }
}

function syncMultiInstance() {
  const wanted = !!store.get('multiInstance');
  const active = win32.holdRobloxSingleton(wanted);
  if (active !== state.multiActive) {
    state.multiActive = active;
    log('multi-instance', active ? 'active' : wanted ? 'waiting for Roblox to close' : 'off');
    sendAccountsSoon();
  }
}

// ------------------------------------------------------------------ accounts

/** The saved account for the window the overlay is attached to (used for all signed-in API calls). */
function activeAccount() {
  const a = accounts.byId(state.activeUserId);
  return a && !a.expired ? a : null;
}

let accountsTimer = null;
function sendAccountsSoon() {
  clearTimeout(accountsTimer);
  accountsTimer = setTimeout(() => send('accounts:update', accountsPayload()), 80);
}

function accountsPayload() {
  const attached = state.roblox ? win32.addr(state.roblox) : 0n;
  const clients = [...state.clients.values()].map((c) => {
    const s = c.file ? watcher.snapshot(c.file) : null;
    const g = s && (s.current || s.joining);
    return {
      pid: c.pid,
      userId: s ? s.userId : null,
      confirmed: !!(s && s.userConfirmed),
      attached: c.address === attached,
      game: g ? { placeId: g.placeId, universeId: g.universeId, jobId: g.jobId, joining: !s.current } : null,
    };
  });
  const wanted = !!store.get('multiInstance');
  return {
    accounts: accounts.publicList(),
    clients,
    activeUserId: state.activeUserId,
    multiInstance: { enabled: wanted, active: wanted && state.multiActive },
  };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Opens Roblox signed in as `account` — the same ticket hand-off roblox.com's Play button uses. */
async function launchAs(account, { placeId, jobId, accessCode }) {
  const ticket = await api.withAccount(account.partition, () => api.authTicket());
  const tracker = String(Math.floor(1e10 + Math.random() * 9e10));
  let launcher = 'https://assetgame.roblox.com/game/PlaceLauncher.ashx?';
  if (accessCode && GUID.test(accessCode)) launcher += `request=RequestPrivateGame&accessCode=${accessCode}&`;
  else if (jobId && GUID.test(jobId)) launcher += `request=RequestGameJob&gameId=${jobId}&`;
  else launcher += 'request=RequestGame&';
  launcher += `browserTrackerId=${tracker}&placeId=${placeId}&isPlayTogetherGame=false&joinAttemptId=${crypto.randomUUID()}&joinAttemptOrigin=PlayButton`;
  const uri =
    `roblox-player:1+launchmode:play+gameinfo:${ticket}+launchtime:${Date.now()}` +
    `+placelauncherurl:${encodeURIComponent(launcher)}+browsertrackerid:${tracker}` +
    '+robloxLocale:en_us+gameLocale:en_us+channel:+LaunchExp:InApp';
  watcher.expectClient(account.id);
  log('launch as', account.id, 'place', placeId, jobId ? 'server ' + jobId : '');
  await shell.openExternal(uri);
}

// ------------------------------------------------------------------ data: profile, game, history

async function refreshProfile() {
  const seq = ++state.profileSeq;
  const snap = watcher.snapshot(state.activeFile || undefined);
  let userId = snap.userId;
  const confirmed = snap.userConfirmed;
  // A client only names its account once it joins a game; until then make a best guess.
  if (!userId && accounts.all().length === 1) userId = accounts.all()[0].id;
  if (!userId) userId = store.get('lastUserId') || (await watcher.recentUserId());
  let p = null;
  if (userId) {
    try {
      p = await api.profile(userId);
    } catch {
      const a = accounts.byId(userId);
      p = { id: String(userId), name: a ? a.name : '', displayName: a ? a.displayName : 'Roblox player', avatar: a ? a.avatar : null };
    }
  }
  if (seq !== state.profileSeq) return;
  if (userId && confirmed) store.set('lastUserId', String(userId));
  const changedUser = state.activeUserId !== (userId ? String(userId) : null);
  state.activeUserId = userId ? String(userId) : null;
  state.profile = p ? { ...p, confirmed } : null;
  state.signedIn = !!activeAccount();
  if (changedUser) log('account in attached window', state.activeUserId || 'unknown', confirmed ? '' : '(guess)');
  send('profile:update', { profile: state.profile, signedIn: state.signedIn });
  sendAccountsSoon();
}

async function onWatcherUpdate() {
  const seq = ++state.gameSeq;
  const snap = watcher.snapshot(state.activeFile || undefined);
  // The window's account can change (in-app account switch, or a replay that just finished).
  if (snap.userId && snap.userId !== state.activeUserId) refreshProfile();
  state.history = snap.history.map(({ file, ...h }) => h);
  send('history:update', state.history);
  sendAccountsSoon();

  const cur = snap.current || snap.joining;
  const sig = cur ? `${cur.placeId}:${cur.jobId}:${snap.current ? 'in' : 'joining'}` : 'none';
  if (sig !== state.gameSig) {
    state.gameSig = sig;
    log('game', cur ? `${snap.current ? 'in' : 'joining'} place ${cur.placeId}` : 'none', snap.logFile || '');
  }
  if (!cur) {
    state.game = null;
    send('game:update', null);
    return;
  }
  // Show what we know immediately, then fill in name/icon/location.
  const base = { ...cur, joining: !snap.current };
  if (state.game && state.game.jobId === cur.jobId) Object.assign(base, pickGameInfo(state.game), { location: state.game.location });
  state.game = base;
  send('game:update', base);

  let universeId = cur.universeId;
  if (!universeId) universeId = await api.universeForPlace(cur.placeId).catch(() => null);
  const details = universeId ? (await api.games([universeId]).catch(() => ({})))[universeId] : null;
  const location = snap.current && cur.serverIp ? await api.serverLocation(cur.serverIp).catch(() => null) : null;
  if (seq !== state.gameSeq) return;
  state.game = { ...base, universeId, ...(details ? pickGameInfo(details) : {}), location: location || base.location || null };
  send('game:update', state.game);
}

function pickGameInfo(g) {
  return { name: g.name, creatorName: g.creatorName, icon: g.icon, maxPlayers: g.maxPlayers, rootPlaceId: g.rootPlaceId || g.placeId };
}

const toasted = new Map(); // jobId -> when we last announced it

async function onJoin(session) {
  log('joined place', session.placeId, session.serverType, 'as', session.userId || '?');
  if (!store.get('toasts')) return;
  const now = Date.now();
  for (const [k, at] of toasted) if (now - at > 120000) toasted.delete(k);
  if (toasted.has(session.jobId)) return; // reconnects to the same server stay quiet
  toasted.set(session.jobId, now);
  const type = { Public: 'public', Private: 'private', Reserved: 'reserved' }[session.serverType] || 'public';
  const location = await api.serverLocation(session.serverIp).catch(() => null);
  let who = '';
  if (state.clients.size > 1 && session.userId) {
    const p = await api.profile(session.userId).catch(() => null);
    if (p) who = `${p.displayName}: `;
  }
  send('toast', {
    title: `${who}Connected to ${type} server`,
    lines: location ? [`Location: ${location}`] : [],
  });
}

// ------------------------------------------------------------------ add-account window

function openSignIn() {
  if (authWin) {
    authWin.focus();
    return;
  }
  closeOverlay(false);
  hideOverlay();
  // Every account gets a brand-new cookie jar, so signing in here never touches another account.
  const partition = accounts.newPartition();
  const ses = api.robloxSession(partition);
  let added = false;
  authWin = new BrowserWindow({
    width: 520,
    height: 760,
    title: 'Add a Roblox account · Visor',
    icon: ICON,
    autoHideMenuBar: true,
    alwaysOnTop: true,
    webPreferences: { session: ses, contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  authWin.setMenu(null);
  authWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://www.roblox.com/')) authWin.loadURL(url);
    else openExternal(url);
    return { action: 'deny' };
  });
  const check = async (_e, url) => {
    try {
      if (/^\/(login|signup|newlogin)/i.test(new URL(url).pathname)) return;
    } catch {
      return;
    }
    const me = await api.withAccount(partition, () => api.authenticatedUser()).catch(() => null);
    if (me && authWin && !added) {
      added = true;
      await accounts.add(partition, me);
      log('account added', me.id);
      authWin.close();
    }
  };
  authWin.webContents.on('did-navigate', check);
  authWin.webContents.on('did-navigate-in-page', check);
  authWin.on('closed', async () => {
    authWin = null;
    if (!added) ses.clearStorageData().catch(() => {}); // abandoned sign-in leaves nothing behind
    await accounts.refresh().catch(() => {});
    refreshProfile();
    if (state.roblox) win32.setForeground(state.roblox);
  });
  authWin.loadURL('https://www.roblox.com/login');
}

// ------------------------------------------------------------------ helpers

function openExternal(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'https:' && /(^|\.)roblox\.com$/.test(u.hostname)) shell.openExternal(u.toString());
  } catch {
    // ignore malformed urls
  }
}

function launchUrl({ placeId, jobId, accessCode }) {
  let url = `roblox://experiences/start?placeId=${placeId}`;
  if (accessCode && GUID.test(accessCode)) url += `&accessCode=${accessCode}`;
  else if (jobId && GUID.test(jobId)) url += `&gameInstanceId=${jobId}`;
  return url;
}

const API_METHODS = new Set([
  'games',
  'search',
  'favorites',
  'servers',
  'serverAvatars',
  'badges',
  'profile',
  'users',
  'headshots',
  'getOnlineStatus',
  'setOnlineStatus',
  'chatConversations',
  'chatMessages',
  'chatSend',
]);
const STORE_KEYS = new Set(['layout', 'open', 'pinned', 'dim', 'toasts', 'serverSort', 'hideFullServers', 'joinAs']);

function loginItemArgs() {
  return app.isPackaged ? { path: process.execPath, args: [] } : { path: process.execPath, args: [ROOT] };
}

// ------------------------------------------------------------------ IPC

function registerIpc() {
  ipcMain.handle('app:init', () => ({
    store: store.get(),
    profile: state.profile,
    signedIn: state.signedIn,
    game: state.game,
    history: state.history,
    accounts: accountsPayload(),
    open: state.open,
    robloxPresent: !!state.roblox,
    hotkeyOk: state.hotkeyOk,
    startWithWindows: app.getLoginItemSettings(loginItemArgs()).openAtLogin,
    version: app.getVersion(),
  }));

  ipcMain.handle('overlay:close', () => closeOverlay(true));
  ipcMain.handle('overlay:passive', (_e, on) => {
    state.passive = !!on;
  });

  ipcMain.handle('store:set', (_e, key, value) => {
    if (STORE_KEYS.has(key)) store.set(key, value);
  });

  ipcMain.handle('notes:save', (_e, text) => {
    const savedAt = Date.now();
    store.set('notes', String(text || '').slice(0, 200000));
    store.set('notesSavedAt', savedAt);
    return savedAt;
  });

  // Signed-in calls run as the account playing in the window the overlay is attached to.
  ipcMain.handle('api', async (_e, method, ...args) => {
    if (!API_METHODS.has(method)) return { ok: false, error: 'Unknown method' };
    const acct = activeAccount();
    try {
      return { ok: true, data: await api.withAccount(acct && acct.partition, () => api[method](...args)) };
    } catch (err) {
      return { ok: false, status: err.status || 0, error: err.message || String(err) };
    }
  });

  ipcMain.handle('roblox:launch', async (_e, target = {}) => {
    try {
      if (!/^\d+$/.test(String(target.placeId))) throw new Error('Invalid place id');
      const as = target.as && target.as !== 'window' ? accounts.byId(target.as) : null;
      if (target.as && target.as !== 'window' && !as) throw new Error('That account isn’t signed in to Visor any more.');
      if (as) await launchAs(as, target);
      else await shell.openExternal(launchUrl(target));
      setTimeout(() => closeOverlay(true), 900);
      return { ok: true };
    } catch (err) {
      log('launch failed', err.message);
      return { ok: false, error: err.message || String(err) };
    }
  });

  ipcMain.handle('clipboard:write', (_e, text) => clipboard.writeText(String(text || '')));
  ipcMain.handle('open:external', (_e, url) => openExternal(url));

  ipcMain.handle('auth:signin', () => openSignIn());
  ipcMain.handle('auth:signout', async () => {
    const a = activeAccount();
    if (a) await accounts.remove(a.id);
    await refreshProfile();
  });
  ipcMain.handle('accounts:add', () => openSignIn());
  ipcMain.handle('accounts:remove', async (_e, id) => {
    await accounts.remove(id);
    log('account removed', id);
    await refreshProfile();
    return accountsPayload();
  });
  ipcMain.handle('accounts:refresh', async () => {
    await accounts.refresh().catch(() => {});
    await refreshProfile();
    return accountsPayload();
  });
  ipcMain.handle('settings:multi-instance', (_e, on) => {
    store.set('multiInstance', !!on);
    syncMultiInstance();
    return accountsPayload().multiInstance;
  });

  ipcMain.handle('hotkey:suspend', (_e, on) => {
    state.hotkeySuspended = !!on;
    if (on) {
      globalShortcut.unregisterAll();
      state.hotkeyWanted = false;
    }
  });
  ipcMain.handle('hotkey:set', (_e, accel) => changeHotkey(String(accel || '')));

  ipcMain.handle('settings:login-item', (_e, on) => {
    app.setLoginItemSettings({ openAtLogin: !!on, ...loginItemArgs() });
    return app.getLoginItemSettings(loginItemArgs()).openAtLogin;
  });

  ipcMain.handle('app:quit', () => app.quit());
}

// ------------------------------------------------------------------ tray

function updateTray() {
  if (!tray) return;
  tray.setToolTip(`Visor — press ${store.get('hotkey')} in Roblox`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `Open overlay (${store.get('hotkey')})`, click: openFromTray },
      { label: 'Add a Roblox account…', click: openSignIn },
      { type: 'separator' },
      updates.state === 'ready'
        ? { label: `Restart to update to ${updates.version}`, click: () => updates.install() }
        : {
            label: updates.state === 'downloading' ? `Downloading ${updates.version}…` : `Visor ${app.getVersion()} · check for updates`,
            enabled: !!updates.check && updates.state !== 'downloading',
            click: () => updates.check(),
          },
      { type: 'separator' },
      { label: 'Quit Visor', click: () => app.quit() },
    ])
  );
}

function openFromTray() {
  const hwnd = state.roblox || win32.findRoblox();
  if (!hwnd) {
    tray.displayBalloon({ title: 'Visor', content: 'Start Roblox first. The overlay attaches to the Roblox window.', iconType: 'info' });
    return;
  }
  win32.forceForeground(hwnd);
  state.roblox = hwnd;
  state.robloxSeenAt = Date.now();
  setTimeout(() => {
    openOverlay();
    win32.forceForeground(overlayHwnd);
  }, 80);
}

// ------------------------------------------------------------------ updates

// Installed builds update themselves from GitHub Releases: download in the background,
// tell the user, apply on restart (or on the next quit).
const updates = { state: 'idle', version: null, check: null, install: null };

function setupUpdates() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch {
    return;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = { info: (m) => log('update', m), warn: (m) => log('update warn', m), error: (m) => log('update error', m), debug: () => {} };
  autoUpdater.on('update-available', (info) => {
    Object.assign(updates, { state: 'downloading', version: info.version });
    updateTray();
  });
  autoUpdater.on('update-downloaded', (info) => {
    Object.assign(updates, { state: 'ready', version: info.version });
    updateTray();
    send('toast', { title: `Visor ${info.version} is ready`, lines: ['Restart it from the tray icon to update.'] });
    if (tray) tray.displayBalloon({ title: `Visor ${info.version} is ready`, content: 'Right-click the tray icon, then Restart to update.', iconType: 'info' });
  });
  autoUpdater.on('error', (err) => log('update error', err && err.message));
  updates.check = () => autoUpdater.checkForUpdates().catch((err) => log('update check failed', err && err.message));
  updates.install = () => autoUpdater.quitAndInstall(false, true);
  setTimeout(updates.check, 15000);
  setInterval(updates.check, 6 * 3600e3);
  updateTray();
}

// ------------------------------------------------------------------ lifecycle

app.whenReady().then(() => {
  log('start', app.getVersion(), process.argv.slice(1).join(' '));
  api.configure({ userAgent: app.userAgentFallback.replace(/ (Electron|visor)\/\S+/gi, '') });

  registerIpc();
  createOverlay();

  tray = new Tray(TRAY_ICON);
  tray.on('click', openFromTray);
  updateTray();
  setupUpdates();

  watcher.on('update', onWatcherUpdate);
  watcher.on('join', onJoin);
  watcher.on('user', (file) => {
    if (!state.activeFile || file === state.activeFile) refreshProfile();
    sendAccountsSoon();
  });
  watcher.on('error', (err) => log('log watcher error', err && err.message));
  watcher.start();

  accounts
    .refresh()
    .catch(() => {})
    .then(() => log('accounts', accounts.all().map((a) => `${a.id}:${a.expired ? 'signed-out' : 'ok'}`).join(' ') || 'none'))
    .then(refreshProfile);
  syncMultiInstance();

  setInterval(tick, TICK_MS);
  setInterval(syncMultiInstance, 2000);
});

app.on('second-instance', (_e, argv) => {
  log('second instance', argv.slice(1).join(' '));
  if (argv.includes('--toggle') && state.open) closeOverlay(true);
  else openFromTray();
});
app.on('window-all-closed', () => {
  // Keep running in the tray.
});
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  win32.holdRobloxSingleton(false);
  store.flush();
  watcher.stop();
});
