'use strict';
(() => {
  const { h } = FL;

  const KEY_NAMES = {
    Backquote: '`',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backslash: '\\',
    Semicolon: ';',
    Quote: "'",
    Comma: ',',
    Period: '.',
    Slash: '/',
    Space: 'Space',
    Tab: 'Tab',
    Insert: 'Insert',
    Home: 'Home',
    End: 'End',
    PageUp: 'PageUp',
    PageDown: 'PageDown',
    Delete: 'Delete',
    ArrowUp: 'Up',
    ArrowDown: 'Down',
    ArrowLeft: 'Left',
    ArrowRight: 'Right',
    Pause: 'Pause',
  };

  function accelFromEvent(e) {
    const code = e.code;
    let key = KEY_NAMES[code];
    if (!key) {
      if (/^Key[A-Z]$/.test(code)) key = code.slice(3);
      else if (/^Digit\d$/.test(code)) key = code.slice(5);
      else if (/^F([1-9]|1\d|2[0-4])$/.test(code)) key = code;
      else if (/^Numpad\d$/.test(code)) key = 'num' + code.slice(6);
    }
    if (!key) return null; // modifier on its own — keep listening
    const mods = [];
    if (e.ctrlKey) mods.push('Control');
    if (e.altKey) mods.push('Alt');
    if (e.shiftKey) mods.push('Shift');
    if (e.metaKey) mods.push('Super');
    if (!mods.length && /^([A-Z0-9]|Space|Tab)$/.test(key)) {
      return { error: 'Letters, numbers, Space and Tab need Ctrl, Alt or Shift so they don’t break typing in Roblox.' };
    }
    return { accel: [...mods, key].join('+') };
  }

  FL.prettyHotkey = (accel) => String(accel || '').replace(/^`$/, '` (~ key)').replace('Control', 'Ctrl').replace('Super', 'Win').split('+').join(' + ');

  FL.defineWidget({
    id: 'settings',
    title: 'Settings',
    icon: 'sliders',
    inBar: false,
    size: { w: 420, h: 540 },
    min: { w: 340, h: 320 },
    place: (vw, vh) => ({ x: Math.round(vw / 2 - 210), y: Math.max(16, Math.round(vh / 2 - 320)) }),

    mount(body) {
      let capturing = false;
      let hotkeyMsg = '';

      const hotkeyBtn = h('button', { class: 'kbd-btn', onclick: startCapture });
      const hotkeyNote = h('div', { class: 'hint' });
      const dim = h('input', { type: 'range', min: '0', max: '80', step: '5', class: 'range' });
      const toastSwitch = h('button', { class: 'switch', role: 'switch' });
      const bootSwitch = h('button', { class: 'switch', role: 'switch' });
      const account = h('div', { class: 'card account' });

      const setting = (label, desc, control) =>
        h('div', { class: 'setting' }, h('div', { class: 'setting-text' }, h('div', { class: 'setting-label' }, label), desc ? h('div', { class: 'hint' }, desc) : null), control);

      body.classList.add('settings-body');
      body.append(
        h('h4', null, 'Overlay'),
        h('div', { class: 'card' },
          setting('Open / close hotkey', 'Works while Roblox is focused.', hotkeyBtn),
          hotkeyNote,
          setting('Dim game while open', null, dim),
          setting('Server toasts', 'Show where you connected when you join a server.', toastSwitch),
          setting('Start with Windows', null, bootSwitch)
        ),
        h('h4', null, 'Roblox accounts'),
        account,
        h('h4', null, 'Layout'),
        h('div', { class: 'card' },
          setting('Widget positions', 'Move every widget back to its default spot.', h('button', { class: 'btn sm', onclick: () => FL.resetLayout() }, 'Reset'))
        ),
        h('div', { class: 'settings-foot' },
          h('span', { class: 'hint' }, 'Visor reads Roblox’s log files and public web APIs. Nothing is injected into the game client.'),
          h('button', { class: 'btn sm danger', onclick: () => window.visor.call('app:quit') }, 'Quit Visor')
        )
      );

      dim.addEventListener('input', () => {
        const v = Number(dim.value) / 100;
        document.documentElement.style.setProperty('--dim', String(v));
        saveDim(v);
      });
      const saveDim = FL.debounce((v) => FL.save('dim', v), 250);

      toastSwitch.addEventListener('click', () => {
        FL.save('toasts', !FL.state.store.toasts);
        render();
      });
      bootSwitch.addEventListener('click', async () => {
        const on = await window.visor.call('settings:login-item', !FL.state.startWithWindows);
        FL.setState({ startWithWindows: on });
        render();
      });

      function onKey(e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey) return stopCapture('');
        const r = accelFromEvent(e);
        if (!r) return;
        if (r.error) {
          hotkeyMsg = r.error;
          return render();
        }
        window.visor.call('hotkey:set', r.accel).then((res) => {
          FL.state.store.hotkey = res.hotkey;
          FL.setState({ hotkeyOk: res.ok || FL.state.hotkeyOk });
          stopCapture(res.ok ? '' : res.error);
        });
      }

      function startCapture() {
        if (capturing) return;
        capturing = true;
        hotkeyMsg = '';
        window.visor.call('hotkey:suspend', true);
        window.addEventListener('keydown', onKey, true);
        render();
      }

      function stopCapture(msg) {
        capturing = false;
        hotkeyMsg = msg || '';
        window.removeEventListener('keydown', onKey, true);
        window.visor.call('hotkey:suspend', false);
        render();
      }

      function renderAccount() {
        const list = FL.state.accounts.accounts;
        const faces = h('div', { class: 'acct-faces' }, list.slice(0, 4).map((x) => {
          const t = FL.tile('acct-face', 'user');
          t.set(x.avatar);
          return t;
        }));
        FL.clear(
          account,
          h('div', { class: 'acct-row' },
            list.length ? faces : null,
            h('div', { class: 'row-main' },
              h('div', { class: 'row-title' }, list.length ? `${list.length} account${list.length === 1 ? '' : 's'} signed in` : 'No accounts added'),
              h('div', { class: 'row-sub' }, list.length ? list.map((x) => '@' + x.name).join(', ') : 'Optional — unlocks Messages, online status, badge progress and launching as each account.')
            ),
            h('button', { class: 'btn sm', onclick: () => FL.openWidget('accounts') }, 'Manage')
          )
        );
      }

      function render() {
        hotkeyBtn.classList.toggle('capturing', capturing);
        FL.clear(hotkeyBtn, capturing ? 'Press a key…' : FL.prettyHotkey(FL.state.store.hotkey));
        const warn = !FL.state.hotkeyOk && !capturing ? 'This hotkey couldn’t be registered (another app may own it). Pick a different one.' : '';
        FL.clear(hotkeyNote, hotkeyMsg || warn);
        hotkeyNote.hidden = !(hotkeyMsg || warn);
        hotkeyNote.classList.toggle('error', true);
        dim.value = String(Math.round((FL.state.store.dim ?? 0.45) * 100));
        toastSwitch.classList.toggle('on', FL.state.store.toasts !== false);
        bootSwitch.classList.toggle('on', !!FL.state.startWithWindows);
        renderAccount();
      }

      render();
      return {
        onShow: render,
        onHide() {
          if (capturing) stopCapture('');
        },
        onOverlay(open) {
          if (!open && capturing) stopCapture('');
        },
        onState(state, patch) {
          if ('accounts' in patch || 'profile' in patch || 'signedIn' in patch || 'hotkeyOk' in patch || 'startWithWindows' in patch) render();
        },
      };
    },
  });
})();
