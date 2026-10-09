'use strict';
// Shared helpers for the overlay UI: DOM builder, formatting, state, API bridge.
(() => {
  const FL = (window.FL = {});

  // ------------------------------------------------------------- DOM

  FL.h = function h(tag, props, ...children) {
    const el = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else if (k === 'icon') el.innerHTML = FL.svg(v); // trusted static markup only
        else if (k === 'value' || k === 'checked' || k === 'disabled') el[k] = v;
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  };

  FL.svg = (name, size = 20) =>
    `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${window.FL_ICONS[name] || ''}</svg>`;

  FL.icon = (name, size = 20, cls = 'ico') => {
    const s = document.createElement('span');
    s.className = cls;
    s.innerHTML = FL.svg(name, size);
    return s;
  };

  // Transparent pixel: a missing image shows its background colour instead of Chromium's broken-image frame.
  FL.BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  /** <img> that falls back to a neutral tile when the CDN url is missing or fails. */
  FL.img = (src, cls = '', alt = '') => {
    const el = FL.h('img', { class: cls, alt, draggable: 'false', loading: 'lazy' });
    el.addEventListener('error', () => {
      el.classList.add('broken');
      el.src = FL.BLANK;
    });
    if (src) el.src = src;
    else {
      el.classList.add('broken');
      el.src = FL.BLANK;
    }
    return el;
  };

  /** Image slot with a glyph underneath that shows whenever there's no picture to show. */
  FL.tile = (cls, glyph) => {
    const img = FL.img(null);
    const el = FL.h('div', { class: 'tile ' + cls }, FL.icon(glyph, 22, 'tile-glyph'), img);
    // Avatars are transparent PNGs, so the glyph must go away once a real picture loads.
    img.addEventListener('load', () => el.classList.toggle('has-img', img.src !== FL.BLANK && !img.classList.contains('broken')));
    el.set = (url) => {
      if (url) {
        if (img.getAttribute('src') !== url) {
          el.classList.remove('has-img');
          img.classList.remove('broken');
          img.src = url;
        }
      } else {
        el.classList.remove('has-img');
        img.classList.add('broken');
        img.src = FL.BLANK;
      }
    };
    return el;
  };

  FL.clear = (el, ...children) => {
    el.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
    return el;
  };

  FL.spinner = () => FL.h('span', { class: 'spinner', role: 'status', 'aria-label': 'Loading' });

  FL.empty = (text, ...extra) => FL.h('div', { class: 'empty' }, FL.h('div', null, FL.h('p', null, text), ...extra));

  // ------------------------------------------------------------- formatting

  const compactFmt = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 });
  const t24 = new Intl.DateTimeFormat([], { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const t12 = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
  const dateFmt = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric', year: 'numeric' });

  FL.fmt = {
    compact: (n) => compactFmt.format(n || 0),
    time24: (t) => (t ? t24.format(new Date(t)) : ''),
    time12: (t) => (t ? t12.format(new Date(t)) : ''),
    date: (t) => (t ? dateFmt.format(new Date(t)) : ''),
    clock(ms) {
      const s = Math.max(0, Math.floor(ms / 1000));
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = String(s % 60).padStart(2, '0');
      return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
    },
    duration(ms) {
      const m = Math.max(0, Math.round(ms / 60000));
      if (m < 1) return 'just now';
      if (m < 60) return `${m} min`;
      const h = Math.floor(m / 60);
      return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
    },
    ago(t) {
      if (!t) return '';
      const d = Date.now() - new Date(t).getTime();
      if (d < 60e3) return 'now';
      if (d < 3600e3) return `${Math.floor(d / 60e3)}m`;
      if (d < 86400e3) return `${Math.floor(d / 3600e3)}h`;
      return `${Math.floor(d / 86400e3)}d`;
    },
    serverType: (t) => ({ Public: 'Public server', Private: 'Private server', Reserved: 'Reserved server' })[t] || 'Server',
  };

  // ------------------------------------------------------------- state

  FL.state = {
    store: {},
    profile: null,
    signedIn: false,
    game: null,
    history: [],
    open: false,
    robloxPresent: false,
    accounts: { accounts: [], clients: [], activeUserId: null, multiInstance: { enabled: false, active: false } },
    hotkeyOk: true,
    startWithWindows: false,
  };
  const subs = new Set();
  FL.subscribe = (fn) => {
    subs.add(fn);
    return () => subs.delete(fn);
  };
  FL.setState = (patch) => {
    Object.assign(FL.state, patch);
    for (const fn of subs) {
      try {
        fn(FL.state, patch);
      } catch (err) {
        console.error(err);
      }
    }
  };
  FL.save = (key, value) => {
    FL.state.store[key] = value;
    window.visor.call('store:set', key, value);
  };

  // ------------------------------------------------------------- main-process bridge

  FL.api = async (method, ...args) => {
    const r = await window.visor.call('api', method, ...args);
    if (!r || !r.ok) {
      const err = new Error((r && r.error) || 'Request failed');
      err.status = r && r.status;
      throw err;
    }
    return r.data;
  };

  /** Joins a game. Unless told otherwise, uses the "Join as" choice (this window's account or a saved one). */
  FL.launch = async (target) => {
    const as = target.as || FL.joinAs();
    const r = await window.visor.call('roblox:launch', { ...target, as });
    if (!r || !r.ok) throw new Error((r && r.error) || 'Couldn’t start Roblox');
    return r;
  };

  /** Saved account to join with, or 'window' for whatever account the focused Roblox window uses. */
  FL.joinAs = () => {
    const id = FL.state.store.joinAs;
    return id && id !== 'window' && FL.state.accounts.accounts.some((a) => a.id === id && !a.expired) ? id : 'window';
  };

  FL.account = (id) => FL.state.accounts.accounts.find((a) => a.id === String(id)) || null;
  FL.copy = (text) => window.visor.call('clipboard:write', text);

  /** Copy button that flashes a check mark instead of relying on a hover tooltip. */
  FL.copyButton = (getText, cls, label) => {
    const btn = FL.h('button', { class: cls + ' copy-btn', 'aria-label': label, icon: 'copy' });
    let t;
    btn.addEventListener('click', () => {
      FL.copy(getText());
      btn.innerHTML = FL.svg('check');
      btn.classList.add('copied');
      clearTimeout(t);
      t = setTimeout(() => {
        btn.innerHTML = FL.svg('copy');
        btn.classList.remove('copied');
      }, 1200);
    });
    return btn;
  };

  // ------------------------------------------------------------- "join as" picker

  /** Small dropdown choosing which account joins games. Hidden until an account is saved. */
  FL.joinAsPicker = () => {
    const { h } = FL;
    const label = h('span', { class: 'ja-label' });
    const face = FL.tile('ja-av', 'window');
    const btn = h('button', { class: 'ja-btn', 'aria-haspopup': 'menu' }, h('span', { class: 'ja-pre' }, 'Join as'), face, label, FL.icon('chevronDown', 14, 'ja-chev'));
    const wrap = h('div', { class: 'ja' }, btn);
    let menu = null;

    const close = () => {
      if (menu) menu.remove();
      menu = null;
      document.removeEventListener('pointerdown', outside, true);
    };
    const outside = (e) => {
      if (menu && !menu.contains(e.target) && !btn.contains(e.target)) close();
    };
    const pick = (id) => {
      FL.save('joinAs', id);
      close();
      render();
    };

    btn.addEventListener('click', () => {
      if (menu) return close();
      const cur = FL.joinAs();
      const p = FL.state.profile;
      const item = (id, avatar, glyph, title, sub) => {
        const t = FL.tile('ja-av', glyph);
        t.set(avatar);
        return h('button', { class: 'menu-item ja-item', onclick: () => pick(id) }, t, h('span', { class: 'ja-text' }, h('span', null, title), sub ? h('span', { class: 'ja-sub' }, sub) : null), id === cur ? FL.icon('check', 16, 'check') : h('span'));
      };
      menu = h(
        'div',
        { class: 'menu ja-menu', role: 'menu' },
        item('window', null, 'window', 'This Roblox window', p ? `Currently ${p.displayName}` : 'Whoever is signed in there'),
        FL.state.accounts.accounts.filter((a) => !a.expired).map((a) => item(a.id, a.avatar, 'user', a.displayName, `@${a.name} · opens its own window`))
      );
      const r = btn.getBoundingClientRect();
      menu.style.left = Math.min(r.left, window.innerWidth - 300) + 'px';
      menu.style.top = r.bottom + 6 + 'px';
      document.body.append(menu);
      document.addEventListener('pointerdown', outside, true);
    });

    function render() {
      const accts = FL.state.accounts.accounts.filter((a) => !a.expired);
      wrap.hidden = !accts.length;
      const a = FL.joinAs() === 'window' ? null : FL.account(FL.joinAs());
      face.set(a ? a.avatar : null);
      label.textContent = a ? a.displayName : 'This window';
    }
    FL.subscribe((state, patch) => {
      if ('accounts' in patch || 'profile' in patch) render();
      if ('open' in patch && !state.open) close();
    });
    render();
    return wrap;
  };

  // ------------------------------------------------------------- widgets registry

  FL.widgets = {};
  FL.defineWidget = (def) => {
    FL.widgets[def.id] = def;
  };

  FL.debounce = (fn, ms) => {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  };
})();
