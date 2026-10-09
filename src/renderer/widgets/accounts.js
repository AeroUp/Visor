'use strict';
(() => {
  const { h } = FL;

  FL.defineWidget({
    id: 'accounts',
    title: 'Accounts',
    icon: 'users',
    order: 0,
    size: { w: 420, h: 520 },
    min: { w: 340, h: 300 },
    place: (vw) => ({ x: Math.max(620, vw - 900), y: 10 }),

    mount(body) {
      const games = new Map(); // universeId -> { name, icon }
      const people = new Map(); // userId -> { displayName, name, avatar }
      const confirmRemove = new Set();
      let notice = '';
      let visible = false;

      body.classList.add('acct-body');

      async function resolve() {
        const { clients, accounts } = FL.state.accounts;
        const uids = [...new Set(clients.map((c) => c.game && c.game.universeId).filter((id) => id && !games.has(id)))];
        const users = [...new Set(clients.map((c) => c.userId).filter((id) => id && !people.has(id) && !accounts.some((a) => a.id === id)))];
        if (!uids.length && !users.length) return;
        try {
          if (uids.length) Object.entries(await FL.api('games', uids)).forEach(([id, g]) => games.set(id, g));
          if (users.length) {
            const [names, heads] = await Promise.all([FL.api('users', users), FL.api('headshots', users)]);
            for (const id of users) if (names[id]) people.set(id, { ...names[id], avatar: heads[id] });
          }
        } catch {
          return;
        }
        render();
      }

      const who = (id) => {
        const a = FL.account(id);
        return a || people.get(String(id)) || null;
      };

      async function joinMyServer(acct) {
        const g = FL.state.game;
        if (!g || g.joining) return;
        notice = `Sending ${acct.displayName} to your server…`;
        render();
        try {
          await FL.launch({ placeId: g.placeId, jobId: g.jobId, as: acct.id });
        } catch (err) {
          notice = err.message;
          render();
        }
      }

      async function remove(acct) {
        if (!confirmRemove.has(acct.id)) {
          confirmRemove.add(acct.id);
          render();
          setTimeout(() => {
            confirmRemove.delete(acct.id);
            render();
          }, 3500);
          return;
        }
        confirmRemove.delete(acct.id);
        const payload = await window.visor.call('accounts:remove', acct.id);
        FL.setState({ accounts: payload });
      }

      function windowRow(c) {
        const p = c.userId ? who(c.userId) : null;
        const t = FL.tile('acct-av', 'user');
        t.set(p && p.avatar);
        const g = c.game && c.game.universeId ? games.get(c.game.universeId) : null;
        const doing = !c.game ? 'Roblox home' : c.game.joining ? 'Joining a game…' : g ? `Playing ${g.name}` : 'In a game';
        const name = p ? p.displayName : 'Unknown account';
        return h(
          'div',
          { class: 'row acct-row' + (c.attached ? ' attached' : '') },
          t,
          h(
            'div',
            { class: 'row-main' },
            h('div', { class: 'row-title' }, name, c.attached ? h('span', { class: 'tag green' }, 'This window') : null),
            h('div', { class: 'row-sub' }, doing, !c.confirmed && c.userId ? ' · not confirmed yet' : '', !c.userId ? ' · detected once it joins a game' : '')
          )
        );
      }

      function accountRow(a) {
        const t = FL.tile('acct-av', 'user');
        t.set(a.avatar);
        const inWindow = FL.state.accounts.clients.find((c) => c.userId === a.id);
        const g = FL.state.game;
        const here = FL.state.accounts.activeUserId === a.id;
        const canJoin = g && !g.joining && !here;
        let status = a.expired ? 'Signed out — sign in again' : inWindow ? (inWindow.attached ? 'Playing in this window' : 'Playing in another window') : 'Signed in';
        return h(
          'div',
          { class: 'row acct-row' },
          t,
          h('div', { class: 'row-main' }, h('div', { class: 'row-title' }, a.displayName), h('div', { class: 'row-sub' + (a.expired ? ' error' : '') }, `@${a.name} · ${status}`)),
          a.expired
            ? h('button', { class: 'btn sm primary', onclick: () => window.visor.call('accounts:add') }, 'Sign in')
            : h('button', { class: 'btn sm', disabled: !canJoin, onclick: () => joinMyServer(a) }, 'Join my server'),
          h(
            'button',
            { class: 'icon-btn sm' + (confirmRemove.has(a.id) ? ' danger-btn' : ''), 'aria-label': `Remove ${a.displayName}`, onclick: () => remove(a) },
            confirmRemove.has(a.id) ? FL.icon('check', 15) : FL.icon('x', 15)
          )
        );
      }

      function render() {
        const { clients, accounts, multiInstance } = FL.state.accounts;
        const multiSwitch = h('button', { class: 'switch' + (multiInstance.enabled ? ' on' : ''), role: 'switch', 'aria-checked': String(multiInstance.enabled) });
        multiSwitch.addEventListener('click', async () => {
          const mi = await window.visor.call('settings:multi-instance', !multiInstance.enabled);
          FL.setState({ accounts: { ...FL.state.accounts, multiInstance: mi } });
        });
        let miStatus = 'Off — opening Roblox as another account replaces the window you have open.';
        if (multiInstance.enabled) miStatus = multiInstance.active ? 'On — each launch gets its own Roblox window.' : 'Close every Roblox window once to finish turning this on.';

        FL.clear(
          body,
          h('h4', null, 'Roblox windows'),
          clients.length ? h('div', { class: 'list' }, clients.map(windowRow)) : h('div', { class: 'hint' }, 'No Roblox windows open.'),
          h('h4', null, 'Saved accounts'),
          accounts.length
            ? h('div', { class: 'list' }, accounts.map(accountRow))
            : h('div', { class: 'hint' }, 'Add your accounts to use Messages, online status and badge progress on each of them, and to launch Roblox as any of them.'),
          notice ? h('div', { class: 'note-line' }, notice) : null,
          h('button', { class: 'btn primary acct-add', onclick: () => window.visor.call('accounts:add') }, FL.icon('plus', 16), 'Add account'),
          h('div', { class: 'hint' }, 'You sign in on roblox.com in a separate window; Visor never sees your password. Each account is kept in its own private browser profile.'),
          h('h4', null, 'Multiple Roblox windows'),
          h(
            'div',
            { class: 'card setting-card' },
            h('div', { class: 'setting' }, h('div', { class: 'setting-text' }, h('div', { class: 'setting-label' }, 'Let each account have its own window'), h('div', { class: 'hint' }, miStatus)), multiSwitch),
            multiInstance.enabled ? h('div', { class: 'hint' }, 'While this is on, joining from a link or this overlay opens a new Roblox window instead of switching the current one.') : null
          )
        );
        resolve();
      }

      render();
      return {
        onShow() {
          visible = true;
          notice = '';
          window.visor.call('accounts:refresh').then((payload) => payload && FL.setState({ accounts: payload }));
          render();
        },
        onHide() {
          visible = false;
        },
        onState(state, patch) {
          if (visible && ('accounts' in patch || 'game' in patch || 'profile' in patch)) render();
        },
      };
    },
  });
})();
