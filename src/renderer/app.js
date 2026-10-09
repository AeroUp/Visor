'use strict';
// Overlay shell: bottom bar, profile/online-status menu, widget windows, toasts.
(() => {
  const { h, fmt } = FL;
  const fl = window.visor;
  const root = document.documentElement;
  const widgetsEl = document.getElementById('widgets');
  const barWrap = document.getElementById('bar-wrap');
  const toastsEl = document.getElementById('toasts');

  const frames = new Map(); // id -> frame
  let openSet = new Set();
  let pinnedSet = new Set();
  let z = 10;

  // ------------------------------------------------------------------ bar

  const avatar = FL.tile('avatar', 'user');
  const displayName = h('div', { class: 'dn' }, 'Roblox');
  const userName = h('div', { class: 'un' });
  const profileBtn = h(
    'button',
    { class: 'bar-profile', 'aria-label': 'Who can see you’re online', onclick: () => (menuOpen ? closeMenu() : openMenu()) },
    avatar,
    h('div', { class: 'names' }, displayName, userName),
    FL.icon('chevronUp', 16, 'chev')
  );

  const gameIcon = FL.tile('game-icon', 'roblox');
  const gameTitle = h('div', { class: 'game-title' });
  const gameSub = h('div', { class: 'game-sub' });
  const gameBox = h('div', { class: 'bar-game' }, gameIcon, h('div', { class: 'game-text' }, gameTitle, gameSub));

  const btnWrap = h('div', { class: 'bar-widgets' });
  const barButtons = new Map();
  Object.values(FL.widgets)
    .filter((d) => d.inBar !== false)
    .sort((a, b) => a.order - b.order)
    .forEach((def) => {
      const b = h(
        'button',
        { class: 'wbtn', 'aria-label': def.title, onclick: () => toggleWidget(def.id) },
        FL.icon(def.icon, 20),
        h('span', { class: 'lbl' }, h('span', null, def.title))
      );
      barButtons.set(def.id, b);
      btnWrap.append(b);
    });

  const settingsBtn = h('button', { class: 'round-btn', 'aria-label': 'Settings', icon: 'sliders', onclick: () => toggleWidget('settings') });
  const closeBtn = h('button', { class: 'round-btn', 'aria-label': 'Close overlay', icon: 'x', onclick: () => fl.call('overlay:close') });
  const menuEl = h('div', { class: 'menu', hidden: true });
  const sep = () => h('div', { class: 'sep' });
  barWrap.append(
    menuEl,
    h('div', { id: 'bar' }, profileBtn, sep(), gameBox, sep(), btnWrap, sep(), h('div', { class: 'bar-end' }, settingsBtn, closeBtn))
  );

  function renderProfile() {
    const p = FL.state.profile;
    avatar.set(p && p.avatar);
    displayName.textContent = p ? p.displayName : 'Roblox';
    // Until this window's client joins a game, Roblox's log doesn't say which account it is.
    const unsure = p && !p.confirmed && FL.state.accounts.accounts.length > 1;
    userName.textContent = p && p.name ? `@${p.name}${unsure ? ' · detecting' : ''}` : 'Join a game to detect';
  }

  let timerEl = null;
  function renderGame() {
    const g = FL.state.game;
    timerEl = null;
    gameBox.classList.toggle('idle', !g);
    if (!g) {
      gameIcon.set(null);
      gameTitle.textContent = FL.state.robloxPresent ? 'Roblox home' : 'Roblox';
      FL.clear(gameSub, FL.state.robloxPresent ? 'Not in an experience' : 'Waiting for Roblox…');
      return;
    }
    gameIcon.set(g.icon);
    gameTitle.textContent = g.name || (g.joining ? 'Joining…' : 'Roblox experience');
    if (g.joining) {
      FL.clear(gameSub, 'Joining server…');
    } else {
      timerEl = h('span', { class: 'timer' }, fmt.clock(Date.now() - g.startTime));
      FL.clear(gameSub, 'Session ', timerEl);
    }
  }
  setInterval(() => {
    const g = FL.state.game;
    if (timerEl && g && g.startTime) timerEl.textContent = fmt.clock(Date.now() - g.startTime);
  }, 1000);

  // ------------------------------------------------------------------ online status menu

  const STATUS_LABELS = {
    AllUsers: 'Everyone',
    FriendsFollowersAndFollowing: 'Friends, followers & following',
    FriendsAndFollowing: 'Friends & following',
    Friends: 'Friends',
    TrustedFriends: 'Trusted friends',
    TrustedConnections: 'Trusted friends',
    NoOne: 'No one',
  };
  const statusLabel = (v) => STATUS_LABELS[v] || String(v).replace(/([a-z])([A-Z])/g, '$1 $2');

  let menuOpen = false;

  async function openMenu() {
    menuOpen = true;
    menuEl.hidden = false;
    profileBtn.classList.add('active');
    renderMenu({ loading: FL.state.signedIn });
    if (!FL.state.signedIn) return;
    try {
      const status = await FL.api('getOnlineStatus');
      if (menuOpen) renderMenu({ status });
    } catch (err) {
      if (menuOpen) renderMenu({ error: err.status === 401 ? 'Your Roblox session expired. Sign in again.' : `Couldn’t load your setting: ${err.message}` });
    }
  }

  function closeMenu() {
    menuOpen = false;
    menuEl.hidden = true;
    profileBtn.classList.remove('active');
  }

  async function choose(value, status) {
    if (value === status.current) return;
    renderMenu({ status: { ...status, current: value }, saving: true });
    try {
      const next = await FL.api('setOnlineStatus', value);
      if (menuOpen) renderMenu({ status: next });
    } catch (err) {
      if (menuOpen) renderMenu({ status, error: `Couldn’t change it: ${err.message}` });
    }
  }

  function renderMenu({ loading, status, error, saving }) {
    const p = FL.state.profile;
    const head = h(
      'div',
      { class: 'menu-head' },
      h('div', { class: 'menu-title' }, 'Who can see you’re online'),
      h('div', { class: 'menu-desc' }, 'Changes your Roblox account setting. Anyone who can’t see you’re online can’t join you either.')
    );
    let content;
    if (!FL.state.signedIn) {
      content = h(
        'div',
        { class: 'menu-pad' },
        h('div', { class: 'menu-desc pad-b' }, p ? `Add ${p.displayName} to Visor to change this.` : 'Add your Roblox account to change this.'),
        h('button', { class: 'btn primary full', onclick: () => (closeMenu(), fl.call('accounts:add')) }, FL.icon('login', 16), p && p.name ? `Sign in as @${p.name}` : 'Sign in with Roblox')
      );
    } else if (loading) {
      content = h('div', { class: 'menu-pad center' }, FL.spinner());
    } else {
      content = [
        status
          ? status.options.map((v) =>
              h(
                'button',
                { class: 'menu-item', disabled: !!saving, onclick: () => choose(v, status) },
                h('span', null, statusLabel(v)),
                v === status.current ? FL.icon('check', 16, 'check') : null
              )
            )
          : null,
        error ? h('div', { class: 'menu-pad error' }, error) : null,
      ];
    }
    FL.clear(
      menuEl,
      head,
      content,
      h('div', { class: 'menu-sep' }),
      h(
        'button',
        { class: 'menu-item', onclick: () => (closeMenu(), FL.openWidget('accounts')) },
        h('span', null, FL.state.accounts.accounts.length ? 'Switch or manage accounts' : 'Add accounts'),
        FL.icon('users', 15, 'muted-ico')
      ),
      p
        ? h(
            'button',
            { class: 'menu-item', onclick: () => fl.call('open:external', `https://www.roblox.com/users/${p.id}/profile`) },
            h('span', null, 'View Roblox profile'),
            FL.icon('external', 15, 'muted-ico')
          )
        : null
    );
  }

  document.addEventListener('pointerdown', (e) => {
    if (menuOpen && !menuEl.contains(e.target) && !profileBtn.contains(e.target)) closeMenu();
  });

  // ------------------------------------------------------------------ widget windows

  function clampRect(r, def) {
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    r.w = Math.round(Math.max(def.min.w, Math.min(r.w, vw - 8)));
    r.h = Math.round(Math.max(def.min.h, Math.min(r.h, vh - 8)));
    r.x = Math.round(Math.max(0, Math.min(r.x, vw - r.w)));
    r.y = Math.round(Math.max(0, Math.min(r.y, vh - r.h)));
    return r;
  }

  function defaultRect(def) {
    return { ...def.place(window.innerWidth, window.innerHeight), w: def.size.w, h: def.size.h };
  }

  function applyRect(frame) {
    const { el, rect } = frame;
    el.style.left = rect.x + 'px';
    el.style.top = rect.y + 'px';
    el.style.width = rect.w + 'px';
    el.style.height = rect.h + 'px';
  }

  function saveLayout() {
    const layout = { ...(FL.state.store.layout || {}) };
    for (const f of frames.values()) layout[f.id] = { ...f.rect };
    FL.save('layout', layout);
  }

  function raise(frame) {
    frame.el.style.zIndex = String(++z);
  }

  function ensureFrame(id) {
    if (frames.has(id)) return frames.get(id);
    const def = FL.widgets[id];
    const pinBtn = h('button', { class: 'icon-btn sm w-pin', 'aria-label': 'Pin — keep visible while the overlay is closed', icon: 'pin' });
    const closeB = h('button', { class: 'icon-btn sm', 'aria-label': 'Close', icon: 'x' });
    const head = h('header', { class: 'w-head' }, FL.icon('grip', 16, 'w-grip'), FL.icon(def.icon, 16, 'w-ico'), h('h3', null, def.title), pinBtn, closeB);
    const body = h('div', { class: 'w-body' });
    const resize = h('div', { class: 'w-resize' });
    const el = h('section', { class: 'widget' + (pinnedSet.has(id) ? ' pinned' : ''), 'data-id': id }, head, body, resize);
    widgetsEl.append(el);

    const saved = FL.state.store.layout && FL.state.store.layout[id];
    const frame = { id, def, el, body, rect: clampRect(saved ? { ...saved } : defaultRect(def), def), inst: {} };
    frames.set(id, frame);
    applyRect(frame);
    raise(frame);

    pinBtn.addEventListener('click', () => togglePin(id));
    closeB.addEventListener('click', () => setOpen(id, false));
    el.addEventListener('pointerdown', () => raise(frame), true);
    dragHandle(frame, head, (f, dx, dy, o) => {
      f.rect.x = o.x + dx;
      f.rect.y = o.y + dy;
    });
    dragHandle(frame, resize, (f, dx, dy, o) => {
      f.rect.w = o.w + dx;
      f.rect.h = o.h + dy;
    });

    try {
      frame.inst = def.mount(body, { close: () => setOpen(id, false) }) || {};
    } catch (err) {
      console.error(err);
      body.append(FL.empty(`This widget failed to load: ${err.message}`));
    }
    return frame;
  }

  function dragHandle(frame, handle, apply) {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const sx = e.clientX;
      const sy = e.clientY;
      const origin = { ...frame.rect };
      frame.el.classList.add('dragging');
      const move = (ev) => {
        apply(frame, ev.clientX - sx, ev.clientY - sy, origin);
        clampRect(frame.rect, frame.def);
        applyRect(frame);
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        frame.el.classList.remove('dragging');
        saveLayout();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    });
  }

  const call = (frame, hook, ...args) => {
    try {
      if (frame && frame.inst && typeof frame.inst[hook] === 'function') frame.inst[hook](...args);
    } catch (err) {
      console.error(err);
    }
  };

  function setOpen(id, on) {
    if (!FL.widgets[id]) return;
    const frame = on ? ensureFrame(id) : frames.get(id);
    if (on) openSet.add(id);
    else openSet.delete(id);
    if (frame) {
      frame.el.classList.toggle('shown', on);
      if (on) {
        raise(frame);
        if (FL.state.open) call(frame, 'onShow');
      } else call(frame, 'onHide');
    }
    FL.save('open', [...openSet]);
    syncButtons();
    updatePassive();
  }

  function toggleWidget(id) {
    setOpen(id, !openSet.has(id));
  }

  FL.openWidget = (id) => setOpen(id, true);

  function togglePin(id) {
    if (pinnedSet.has(id)) pinnedSet.delete(id);
    else pinnedSet.add(id);
    const f = frames.get(id);
    if (f) f.el.classList.toggle('pinned', pinnedSet.has(id));
    FL.save('pinned', [...pinnedSet]);
    updatePassive();
  }

  function syncButtons() {
    for (const [id, b] of barButtons) b.classList.toggle('on', openSet.has(id));
    settingsBtn.classList.toggle('on', openSet.has('settings'));
  }

  FL.resetLayout = () => {
    FL.save('layout', {});
    for (const f of frames.values()) {
      f.rect = clampRect(defaultRect(f.def), f.def);
      applyRect(f);
    }
  };

  window.addEventListener('resize', () => {
    for (const f of frames.values()) {
      clampRect(f.rect, f.def);
      applyRect(f);
    }
  });

  // ------------------------------------------------------------------ overlay state

  let lastPassive = null;
  function updatePassive() {
    const pinnedVisible = [...pinnedSet].some((id) => openSet.has(id));
    const passive = pinnedVisible || toastsEl.children.length > 0;
    if (passive !== lastPassive) {
      lastPassive = passive;
      fl.call('overlay:passive', passive);
    }
  }

  function setOverlayOpen(open) {
    document.body.classList.toggle('open', open);
    if (!open) closeMenu();
    FL.setState({ open });
    for (const f of frames.values()) {
      if (!openSet.has(f.id)) continue;
      call(f, 'onOverlay', open);
      if (open) call(f, 'onShow');
      else if (!pinnedSet.has(f.id)) call(f, 'onHide');
    }
    if (!open && document.activeElement) document.activeElement.blur();
  }

  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (menuOpen) closeMenu();
    else fl.call('overlay:close');
  });

  // ------------------------------------------------------------------ toasts

  function toast({ title, lines }) {
    const el = h(
      'div',
      { class: 'toast' },
      h('div', { class: 't-app' }, FL.icon('visorBadge', 22, 't-logo'), 'Visor'),
      h('div', { class: 't-title' }, title),
      (lines || []).map((l) => h('div', { class: 't-line' }, l))
    );
    toastsEl.append(el);
    updatePassive();
    setTimeout(() => {
      el.classList.add('out');
      setTimeout(() => {
        el.remove();
        updatePassive();
      }, 320);
    }, 6500);
  }

  // ------------------------------------------------------------------ wiring

  const seen = new Set();
  const patchFromEvent = (patch) => {
    Object.keys(patch).forEach((k) => seen.add(k));
    FL.setState(patch);
  };

  fl.on('overlay:state', ({ open }) => setOverlayOpen(open));
  fl.on('profile:update', ({ profile, signedIn }) => patchFromEvent({ profile, signedIn }));
  fl.on('game:update', (game) => patchFromEvent({ game }));
  fl.on('history:update', (history) => patchFromEvent({ history }));
  fl.on('roblox:present', (robloxPresent) => patchFromEvent({ robloxPresent }));
  fl.on('accounts:update', (accounts) => patchFromEvent({ accounts }));
  fl.on('settings:update', ({ hotkey, hotkeyOk }) => {
    FL.state.store.hotkey = hotkey;
    FL.setState({ hotkeyOk });
  });
  fl.on('toast', toast);

  FL.subscribe((state, patch) => {
    if ('profile' in patch || 'signedIn' in patch || 'accounts' in patch) renderProfile();
    if ('game' in patch || 'robloxPresent' in patch) renderGame();
    for (const f of frames.values()) call(f, 'onState', state, patch);
  });

  (async function init() {
    const s = await fl.call('app:init');
    FL.state.store = s.store;
    root.style.setProperty('--dim', String(s.store.dim ?? 0.45));
    openSet = new Set((s.store.open || []).filter((id) => FL.widgets[id]));
    pinnedSet = new Set((s.store.pinned || []).filter((id) => FL.widgets[id]));

    const patch = {
      profile: s.profile,
      signedIn: s.signedIn,
      game: s.game,
      history: s.history || [],
      robloxPresent: s.robloxPresent,
      accounts: s.accounts || FL.state.accounts,
      hotkeyOk: s.hotkeyOk,
      startWithWindows: s.startWithWindows,
    };
    for (const k of seen) delete patch[k];
    FL.setState(patch);
    renderProfile();
    renderGame();

    for (const id of openSet) {
      const f = ensureFrame(id);
      f.el.classList.add('shown');
      f.el.classList.toggle('pinned', pinnedSet.has(id));
    }
    syncButtons();
    updatePassive();
    setOverlayOpen(s.open);
    document.body.classList.add('ready');
  })();
})();
