'use strict';
// Follows the Roblox clients' own log files to work out which game/server each client is in and
// which account it's playing on. Nothing is injected into Roblox: this is the same approach
// Bloxstrap/Fishstrap use.
//
// Every RobloxPlayerBeta process writes its own log, so each log is tracked as a separate
// "client". Several can be alive at once: a second account's window, or the short-lived process
// Roblox starts to hand a roblox:// link to the running client.
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');

const LOG_DIR = path.join(process.env.LOCALAPPDATA || '', 'Roblox', 'logs');
const PLAYER_LOG = /^[\d.]+_(\d{8}T\d{6}Z)_Player_[0-9A-F]+_last\.log$/i;
const CHUNK = 1 << 20;
const MAX_HISTORY = 50;
// A rejoin of the same server within this window is treated as one continuous visit.
const RECONNECT_MERGE_MS = 90 * 1000;
// Logs nobody has written to for this long belong to clients that have closed; we stop reading
// them (but remember how far we got, so they're never re-read from the top).
const FOLLOW_IDLE_MS = 15 * 60 * 1000;
// Only announce joins that just happened — never ones found while catching up on an older log.
const LIVE_JOIN_MS = 30 * 1000;

const MARK = {
  joining: '! Joining game',
  privateServer: 'GameJoinUtil::joinGamePostPrivateServer',
  reservedServer: 'GameJoinUtil::initiateTeleportToReservedServer',
  loadTime: 'game_join_loadtime:',
  udmux: 'UDMUX Address = ',
  joined: '[FLog::Network] serverId:',
  disconnect: 'Time to disconnect replication data',
  leave: 'leaveUGCGameInternal',
};

const RE = {
  timestamp: /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z)/,
  joining: /! Joining game '([0-9a-f-]{36})' place (\d+) at ([\d.]+)/i,
  accessCode: /"accessCode":"([0-9a-f-]{36})"/i,
  universe: /universeid:(\d+)/,
  user: /userid:(\d+)/,
  udmux: /UDMUX Address = ([\d.]+), Port = \d+ \| RCC Server Address = ([\d.]+)/,
  joined: /serverId: ([\d.]+)\|\d+/,
};

const stampToMs = (s) =>
  Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +s.slice(9, 11), +s.slice(11, 13), +s.slice(13, 15));

function listLogs() {
  let names;
  try {
    names = fs.readdirSync(LOG_DIR);
  } catch {
    return [];
  }
  const now = Date.now();
  const out = [];
  for (const name of names) {
    const m = PLAYER_LOG.exec(name);
    if (!m) continue;
    const file = path.join(LOG_DIR, name);
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    const mtime = st.mtimeMs > now + 60000 ? 0 : st.mtimeMs; // some files carry bogus future timestamps
    out.push({ file, stamp: stampToMs(m[1]), mtime, size: st.size });
  }
  return out;
}

class LogWatcher extends EventEmitter {
  constructor() {
    super();
    this.clients = new Map(); // log path -> client state
    this.history = [];
    this.hints = []; // { userId, at }: accounts Visor just launched, to label their client early
    this.buf = Buffer.alloc(CHUNK);
    this.live = false;
    this.busy = false;
    this.startedAt = Date.now();
    this.emitTimer = null;
  }

  async start() {
    this.startedAt = Date.now();
    // Rebuild state from the log Roblox is writing right now, plus any other client that has
    // been writing recently (e.g. a second account's window).
    const logs = listLogs();
    const newest = logs.reduce((a, b) => (!a || b.mtime > a.mtime ? b : a), null);
    if (newest) this.track(newest.file, newest.stamp);
    for (const l of logs) if (this.startedAt - l.mtime < 120000) this.track(l.file, l.stamp);
    await this.replayTracked();
    this.scanTimer = setInterval(() => this.scan(), 1500);
    this.pollTimer = setInterval(() => this.poll(), 400);
  }

  /** Replays one specific log (used by tools/preview.js). */
  async replay(file) {
    this.track(file);
    await this.replayTracked();
  }

  async replayTracked() {
    this.busy = true;
    await this.readAll();
    this.busy = false;
    this.live = true;
    this.changed(true);
  }

  stop() {
    clearInterval(this.scanTimer);
    clearInterval(this.pollTimer);
  }

  // ------------------------------------------------------------------ clients & accounts

  track(file, stamp) {
    if (this.clients.has(file)) return this.clients.get(file);
    if (stamp === undefined) {
      const m = PLAYER_LOG.exec(path.basename(file));
      stamp = m ? stampToMs(m[1]) : 0;
    }
    const client = {
      file,
      stamp,
      offset: 0,
      partial: '',
      lastGrowth: Date.now(),
      lastEvent: 0,
      current: null, // { jobId, placeId, universeId, serverType, accessCode, serverIp, joinTime, startTime, active }
      pending: { type: null, accessCode: null },
      userId: null, // confirmed from the log once a game is joined
      hintUserId: this.hintFor(stamp),
      closed: false,
      dormant: false,
      seenMtime: 0,
    };
    this.clients.set(file, client);
    return client;
  }

  /** Visor is launching Roblox as this account; label the client that's about to start. */
  expectClient(userId) {
    const now = Date.now();
    this.hints = this.hints.filter((h) => now - h.at < 180000);
    this.hints.push({ userId: String(userId), at: now });
  }

  hintFor(stamp) {
    const h = this.hints.find((x) => stamp >= x.at - 5000 && stamp <= x.at + 120000);
    return h ? h.userId : null;
  }

  /** The log written by the RobloxPlayerBeta process that started at `createdMs`. */
  logForProcess(createdMs) {
    let best = null;
    for (const l of listLogs()) {
      const d = l.stamp - createdMs; // the log is created a few seconds after the process
      if (d < -10000 || d > 180000) continue;
      if (!best || Math.abs(d) < Math.abs(best.stamp - createdMs)) best = l;
    }
    if (!best) return null;
    this.track(best.file, best.stamp);
    return best.file;
  }

  accountOf(client) {
    return client ? client.userId || client.hintUserId : null;
  }

  latestClient() {
    let best = null;
    for (const c of this.clients.values()) {
      if (c.closed) continue;
      if (!best || c.lastEvent > best.lastEvent || (c.lastEvent === best.lastEvent && c.stamp > best.stamp)) best = c;
    }
    return best;
  }

  /** Most recently active account across all clients (the old single-client behaviour). */
  get userId() {
    const c = this.latestClient();
    return this.accountOf(c);
  }

  snapshot(file) {
    const c = (file && this.clients.get(file)) || (file ? null : this.latestClient());
    const cur = c && c.current;
    return {
      file: c ? c.file : null,
      logFile: c ? path.basename(c.file) : null,
      current: cur && cur.active ? { ...cur } : null,
      joining: cur && !cur.active ? { ...cur } : null,
      userId: this.accountOf(c),
      userConfirmed: !!(c && c.userId),
      history: this.history.slice(),
    };
  }

  /** Called by main when a Roblox window disappears for good (no file = every client). */
  clientClosed(file) {
    const targets = file ? [this.clients.get(file)].filter(Boolean) : [...this.clients.values()];
    let changed = false;
    for (const c of targets) {
      c.closed = true;
      if (c.current) {
        if (c.current.active) this.endSession(c, Date.now());
        else c.current = null;
        changed = true;
      }
    }
    if (changed) this.changed();
  }

  /**
   * The current log only names the player once a game is joined. Before that, borrow the
   * account from the most recent earlier session so the bar can still show who you are.
   */
  async recentUserId() {
    const logs = listLogs()
      .sort((a, b) => b.stamp - a.stamp)
      .slice(0, 6);
    for (const { file } of logs) {
      const id = await firstUserId(file).catch(() => null);
      if (id) return id;
    }
    return null;
  }

  // ------------------------------------------------------------------ reading

  scan() {
    const now = Date.now();
    for (const l of listLogs()) {
      const c = this.clients.get(l.file);
      if (c) {
        // A parked log that's being written again: resume where we left off.
        if (c.dormant && l.mtime > c.seenMtime) c.dormant = false;
        c.seenMtime = l.mtime;
      } else if (l.mtime >= this.startedAt - 2000) {
        // New clients and link hand-off processes start new logs; follow anything written since we started.
        const added = this.track(l.file, l.stamp);
        added.seenMtime = l.mtime;
        // A log from a client that started long before us just got touched: only follow new lines,
        // so hours-old visits don't land in this session's history.
        if (l.stamp < this.startedAt - 60000) added.offset = l.size;
      }
    }
    for (const c of this.clients.values()) {
      if (!c.dormant && this.clients.size > 1 && now - c.lastGrowth > FOLLOW_IDLE_MS) c.dormant = true;
    }
  }

  async poll() {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.readAll();
    } finally {
      this.busy = false;
    }
  }

  async readAll() {
    for (const [file, c] of this.clients) {
      if (c.dormant) continue;
      try {
        await this.readFile(c);
      } catch (err) {
        if (err.code === 'ENOENT') this.clients.delete(file);
        // Otherwise it's briefly locked; the next poll retries.
      }
    }
  }

  async readFile(c) {
    const fh = await fs.promises.open(c.file, 'r');
    try {
      const { size } = await fh.stat();
      if (size < c.offset) {
        c.offset = 0;
        c.partial = '';
      }
      if (size > c.offset) {
        c.lastGrowth = Date.now();
        c.closed = false;
      }
      const buf = this.buf;
      while (c.offset < size) {
        const { bytesRead } = await fh.read(buf, 0, Math.min(CHUNK, size - c.offset), c.offset);
        if (!bytesRead) break;
        c.offset += bytesRead;
        const text = c.partial + buf.toString('utf8', 0, bytesRead);
        const lines = text.split('\n');
        c.partial = lines.pop();
        for (const line of lines) this.handleLine(line, c);
      }
    } finally {
      await fh.close();
    }
  }

  handleLine(line, client) {
    if (!line.includes('[FLog::')) return;
    const at = () => {
      const m = RE.timestamp.exec(line);
      return m ? Date.parse(m[1]) : Date.now();
    };

    if (line.includes(MARK.privateServer)) {
      client.pending.type = 'Private';
      const m = RE.accessCode.exec(line);
      if (m) client.pending.accessCode = m[1];
      return;
    }
    if (line.includes(MARK.reservedServer)) {
      client.pending.type = 'Reserved';
      return;
    }
    if (line.includes(MARK.joining)) {
      const m = RE.joining.exec(line);
      if (!m) return;
      const t = at();
      if (client.current && client.current.active) this.endSession(client, t);
      client.lastEvent = t;
      client.current = {
        jobId: m[1],
        placeId: m[2],
        universeId: null,
        serverType: client.pending.type || 'Public',
        accessCode: client.pending.accessCode,
        serverIp: null,
        joinTime: t,
        startTime: null,
        active: false,
      };
      client.pending = { type: null, accessCode: null };
      this.changed();
      return;
    }

    const cur = client.current;
    if (!cur) return;

    if (line.includes(MARK.loadTime)) {
      const u = RE.universe.exec(line);
      const id = RE.user.exec(line);
      if (u) cur.universeId = u[1];
      if (id && id[1] !== '0' && id[1] !== client.userId) {
        client.userId = id[1];
        if (this.live) this.emit('user', client.file, client.userId);
      }
      this.changed();
    } else if (line.includes(MARK.udmux)) {
      const m = RE.udmux.exec(line);
      if (m) cur.serverIp = m[1];
    } else if (line.includes(MARK.joined)) {
      if (cur.active) return;
      const m = RE.joined.exec(line);
      if (m && !cur.serverIp) cur.serverIp = m[1];
      cur.active = true;
      cur.startTime = at();
      client.lastEvent = cur.startTime;
      const i = this.history.findIndex((h) => h.jobId === cur.jobId && h.file === client.file);
      if (i >= 0 && cur.startTime - this.history[i].endTime < RECONNECT_MERGE_MS) {
        cur.startTime = this.history[i].startTime;
        this.history.splice(i, 1);
      }
      if (this.live && Date.now() - cur.startTime < LIVE_JOIN_MS) this.emit('join', { ...cur, file: client.file, userId: this.accountOf(client) });
      this.changed();
    } else if (line.includes(MARK.disconnect) || line.includes(MARK.leave)) {
      if (cur.active) this.endSession(client, at());
      else client.current = null; // join never completed
      this.changed();
    }
  }

  endSession(client, t) {
    const c = client.current;
    client.current = null;
    if (!c || !c.active) return;
    const entry = {
      jobId: c.jobId,
      placeId: c.placeId,
      universeId: c.universeId,
      serverType: c.serverType,
      accessCode: c.accessCode,
      serverIp: c.serverIp,
      startTime: c.startTime,
      endTime: t,
      userId: this.accountOf(client),
      file: client.file,
    };
    this.history.unshift(entry);
    this.history.sort((x, y) => y.endTime - x.endTime);
    if (this.history.length > MAX_HISTORY) this.history.length = MAX_HISTORY;
    if (this.live) this.emit('leave', entry);
  }

  changed(force) {
    if (!this.live && !force) return;
    clearTimeout(this.emitTimer);
    this.emitTimer = setTimeout(() => this.emit('update'), force ? 0 : 60);
  }
}

async function firstUserId(file, limit = 24 * CHUNK) {
  const fh = await fs.promises.open(file, 'r');
  try {
    const buf = Buffer.alloc(CHUNK);
    let carry = '';
    for (let pos = 0; pos < limit; pos += CHUNK) {
      const { bytesRead } = await fh.read(buf, 0, CHUNK, pos);
      if (!bytesRead) break;
      const text = carry + buf.toString('utf8', 0, bytesRead);
      const m = /game_join_loadtime:[^\n]*?userid:(\d+)/.exec(text);
      if (m && m[1] !== '0') return m[1];
      carry = text.slice(-400);
    }
    return null;
  } finally {
    await fh.close();
  }
}

module.exports = { LogWatcher, LOG_DIR, listLogs };
