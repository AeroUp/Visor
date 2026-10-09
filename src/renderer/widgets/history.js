'use strict';
(() => {
  const { h, fmt } = FL;

  FL.defineWidget({
    id: 'history',
    title: 'Game history',
    icon: 'history',
    order: 5,
    size: { w: 480, h: 420 },
    min: { w: 320, h: 220 },
    place: (vw, vh) => ({ x: 40, y: Math.min(400, vh - 520) }),

    mount(body) {
      const info = new Map(); // universeId -> game details
      const pending = new Set();
      const names = new Map(); // userId -> display name, for histories spanning several accounts
      const list = h('div', { class: 'list' });
      let message = '';

      body.append(
        h(
          'p',
          { class: 'intro' },
          'Game history is only recorded for your current Roblox session. Games will appear here as you leave them or teleport within them. Not all servers will be rejoinable.'
        ),
        list
      );

      async function enrich(entries) {
        const want = [...new Set(entries.map((e) => e.universeId).filter((id) => id && !info.has(id) && !pending.has(id)))];
        if (!want.length) return;
        want.forEach((id) => pending.add(id));
        try {
          const res = await FL.api('games', want);
          for (const [id, g] of Object.entries(res)) info.set(id, g);
        } catch {
          // keep placeholders; we'll retry next render
        }
        want.forEach((id) => pending.delete(id));
        render();
      }

      async function enrichNames(ids) {
        const want = ids.filter((id) => !names.has(id) && !FL.account(id));
        if (!want.length) return;
        want.forEach((id) => names.set(id, ''));
        try {
          const res = await FL.api('users', want);
          for (const id of want) if (res[id]) names.set(id, res[id].displayName);
        } catch {
          want.forEach((id) => names.delete(id));
          return;
        }
        render();
      }

      const nameOf = (id) => (FL.account(id) ? FL.account(id).displayName : names.get(id) || '');

      async function rejoin(entry, g, btn) {
        btn.disabled = true;
        message = `Rejoining ${g ? g.name : 'server'}…`;
        render();
        // Rejoin as the account that played it when that's a different saved account.
        const as = entry.userId && entry.userId !== FL.state.accounts.activeUserId && FL.account(entry.userId) ? entry.userId : undefined;
        try {
          if (entry.serverType === 'Public') await FL.launch({ placeId: entry.placeId, jobId: entry.jobId, as });
          else if (entry.serverType === 'Private' && entry.accessCode) await FL.launch({ placeId: entry.placeId, accessCode: entry.accessCode, as });
          else await FL.launch({ placeId: (g && g.placeId) || entry.placeId, as });
        } catch (err) {
          message = `Couldn't start Roblox: ${err.message}`;
          render();
        }
      }

      function row(entry, multi) {
        const g = info.get(entry.universeId);
        const direct = entry.serverType === 'Public' || (entry.serverType === 'Private' && entry.accessCode);
        const btn = h(
          'button',
          {
            class: direct ? 'btn primary' : 'btn',
          },
          direct ? 'Rejoin' : 'Play'
        );
        btn.addEventListener('click', () => rejoin(entry, g, btn));
        const sub = [multi && entry.userId ? nameOf(entry.userId) : '', g && g.creatorName, `${fmt.time24(entry.startTime)} - ${fmt.time24(entry.endTime)}`].filter(Boolean).join(' • ');
        return h(
          'div',
          { class: 'row' },
          FL.img(g && g.icon, 'row-icon'),
          h(
            'div',
            { class: 'row-main' },
            h('div', { class: 'row-title' }, g ? g.name : `Place ${entry.placeId}`),
            h('div', { class: 'row-sub' }, sub, entry.serverType !== 'Public' ? h('span', { class: 'tag' }, entry.serverType) : null)
          ),
          btn
        );
      }

      function render() {
        const entries = FL.state.history || [];
        enrich(entries);
        const users = [...new Set(entries.map((e) => e.userId).filter(Boolean))];
        const multi = users.length > 1;
        if (multi) enrichNames(users);
        if (!entries.length) {
          FL.clear(list, FL.empty('Nothing here yet. Leave or switch games and they’ll show up here.'));
        } else {
          FL.clear(list, message ? h('div', { class: 'note-line' }, message) : null, entries.map((e) => row(e, multi)));
        }
      }

      render();
      return {
        onShow() {
          message = '';
          render();
        },
        onState(state, patch) {
          if ('history' in patch || 'accounts' in patch) render();
        },
      };
    },
  });
})();
