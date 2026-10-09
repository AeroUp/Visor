'use strict';
(() => {
  const { h, fmt } = FL;
  const MAX_PAGES = 5;
  const joinLink = (placeId, jobId) => `https://www.roblox.com/games/start?placeId=${placeId}&gameInstanceId=${jobId}`;

  FL.defineWidget({
    id: 'servers',
    title: 'Servers',
    icon: 'server',
    order: 3,
    size: { w: 520, h: 560 },
    min: { w: 400, h: 320 },
    place: (vw, vh) => ({ x: Math.round(vw * 0.54), y: Math.round(vh * 0.27) }),

    mount(body) {
      let placeId = null;
      let servers = [];
      let cursor = null;
      let pages = 0;
      let loading = false;
      let error = '';
      let notice = '';
      let seq = 0;
      let visible = false;
      const avatars = new Map(); // token -> url
      const queued = new Set();

      const infoCard = h('div', { class: 'card srv-info' });
      const countEl = h('span', { class: 'muted' });
      const sortBtn = h('button', { class: 'btn sm', onclick: toggleSort });
      const hideSwitch = h('button', { class: 'switch', role: 'switch', onclick: toggleHideFull });
      const controls = h(
        'div',
        { class: 'card srv-controls' },
        h('div', { class: 'ctl-row' }, h('span', { class: 'muted' }, 'Sort by players'), sortBtn, h('span', { class: 'grow' }), countEl,
          h('button', { class: 'btn sm', onclick: () => load(true) }, FL.icon('refresh', 15), 'Refresh')),
        h('div', { class: 'ctl-row' }, h('label', { class: 'ctl-row toggle-row' }, hideSwitch, h('span', null, 'Hide full servers')), h('span', { class: 'grow' }), FL.joinAsPicker())
      );
      const list = h('div', { class: 'list srv-list' });
      const content = h('div', { class: 'srv-content' }, infoCard, controls, list);
      body.classList.add('srv-body');
      body.append(content);

      const observer = new IntersectionObserver(
        (entries) => {
          for (const e of entries) {
            if (!e.isIntersecting) continue;
            for (const t of (e.target.dataset.tokens || '').split(',')) if (t && !avatars.has(t)) queued.add(t);
            observer.unobserve(e.target);
          }
          flushAvatars();
        },
        { root: list }
      );

      const flushAvatars = FL.debounce(async () => {
        const tokens = [...queued].slice(0, 100);
        if (!tokens.length) return;
        tokens.forEach((t) => queued.delete(t));
        try {
          const res = await FL.api('serverAvatars', tokens);
          for (const t of tokens) avatars.set(t, res[t] || '');
          for (const img of list.querySelectorAll('img[data-token]')) {
            const url = avatars.get(img.dataset.token);
            if (url && !img.src) img.src = url;
          }
        } catch {
          tokens.forEach((t) => avatars.set(t, ''));
        }
        if (queued.size) flushAvatars();
      }, 80);

      const sortOrder = () => FL.state.store.serverSort || 'Desc';
      const hideFull = () => FL.state.store.hideFullServers !== false;

      function toggleSort() {
        FL.save('serverSort', sortOrder() === 'Desc' ? 'Asc' : 'Desc');
        load(true);
      }
      function toggleHideFull() {
        FL.save('hideFullServers', !hideFull());
        load(true);
      }

      async function load(reset) {
        const game = FL.state.game;
        if (!game || game.joining) return render();
        const my = reset ? ++seq : seq;
        if (reset) {
          placeId = game.placeId;
          servers = [];
          cursor = null;
          pages = 0;
          error = '';
          list.scrollTop = 0;
          renderList(true);
        }
        loading = true;
        renderControls();
        try {
          const res = await FL.api('servers', placeId, { cursor, sortOrder: sortOrder(), excludeFull: hideFull() });
          if (my !== seq) return;
          const seen = new Set(servers.map((s) => s.id));
          const fresh = res.servers.filter((s) => !seen.has(s.id));
          servers = servers.concat(fresh);
          cursor = res.nextCursor;
          pages++;
          appendRows(fresh);
        } catch (err) {
          if (my !== seq) return;
          error = err.status === 429 ? 'Roblox is rate-limiting server lists. Try Refresh in a few seconds.' : err.message;
        }
        loading = false;
        renderControls();
        renderList(false);
        if (my === seq && cursor && pages < MAX_PAGES && visible && !error) setTimeout(() => my === seq && load(false), 350);
      }

      function joinServer(jobId) {
        FL.launch({ placeId, jobId }).catch((err) => {
          notice = err.message;
          renderInfo();
        });
      }

      async function serverHop() {
        const game = FL.state.game;
        if (!game) return;
        let pool = servers;
        if (!pool.length) {
          try {
            pool = (await FL.api('servers', game.placeId, { sortOrder: 'Desc', excludeFull: true })).servers;
          } catch (err) {
            notice = `Couldn't load servers: ${err.message}`;
            return renderInfo();
          }
        }
        const candidates = pool.filter((s) => s.id !== game.jobId && s.playing < s.maxPlayers);
        if (!candidates.length) {
          notice = 'No other open servers to hop to.';
          return renderInfo();
        }
        const pick = candidates[Math.floor(Math.random() * candidates.length)];
        notice = `Hopping to a server with ${pick.playing}/${pick.maxPlayers} players…`;
        renderInfo();
        FL.launch({ placeId: game.placeId, jobId: pick.id }).catch((err) => {
          notice = err.message;
          renderInfo();
        });
      }

      function renderInfo() {
        const g = FL.state.game;
        if (!g) return FL.clear(infoCard);
        const kv = (k, v, extra) => h('div', { class: 'kv' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v), extra || null);
        FL.clear(
          infoCard,
          h(
            'div',
            { class: 'kv-grid' },
            kv('Type', fmt.serverType(g.serverType)),
            kv('Location', g.location || (g.joining ? '—' : 'Locating…')),
            kv(
              'Instance ID',
              g.jobId.slice(0, 8) + '…',
              FL.copyButton(() => g.jobId, 'icon-btn xs', 'Copy instance ID')
            ),
            kv('Connected', g.startTime ? fmt.duration(Date.now() - g.startTime) : '—')
          ),
          h('button', { class: 'btn primary', onclick: serverHop, disabled: !!g.joining }, FL.icon('shuffle', 16), 'Server hop'),
          notice ? h('div', { class: 'note-line full' }, notice) : null
        );
      }

      function renderControls() {
        sortBtn.textContent = sortOrder() === 'Desc' ? 'Most players' : 'Fewest players';
        hideSwitch.classList.toggle('on', hideFull());
        hideSwitch.setAttribute('aria-checked', String(hideFull()));
        FL.clear(countEl, loading && !servers.length ? FL.spinner() : `${servers.length}${cursor ? '+' : ''} servers`);
      }

      function row(s) {
        const g = FL.state.game;
        const here = g && s.id === g.jobId;
        const shown = s.tokens.length;
        const players = shown
          ? h(
              'div',
              { class: 'avs' },
              s.tokens.map((t) => {
                const img = h('img', { 'data-token': t, alt: '', draggable: 'false' });
                if (avatars.get(t)) img.src = avatars.get(t);
                return img;
              }),
              s.playing > shown ? h('span', { class: 'more' }, `+${s.playing - shown}`) : null
            )
          : h('div', { class: 'avs-text' }, `${s.playing} / ${s.maxPlayers} players`);
        const pct = s.maxPlayers ? Math.min(100, (s.playing / s.maxPlayers) * 100) : 0;
        const el = h(
          'div',
          { class: 'srv-row' + (here ? ' here' : ''), 'data-tokens': s.tokens.join(',') },
          h('div', { class: 'srv-players' }, players, h('div', { class: 'fill' }, h('span', { style: { width: pct + '%' } }))),
          shown ? h('span', { class: 'stat' }, `${s.playing}/${s.maxPlayers}`) : h('span'),
          h('span', { class: 'stat' }, s.fps !== null ? `${Math.round(s.fps)} FPS` : '— FPS'),
          h('span', { class: 'stat' }, s.ping !== null ? `${Math.round(s.ping)} ms` : '— ms'),
          h(
            'div',
            { class: 'row-actions' },
            FL.copyButton(() => joinLink(placeId, s.id), 'icon-btn xs ghost', 'Copy invite link'),
            here
              ? h('span', { class: 'tag green' }, 'You')
              : h('button', { class: 'icon-btn', 'aria-label': 'Join this server', icon: 'link', onclick: () => joinServer(s.id) })
          )
        );
        if (shown) observer.observe(el);
        return el;
      }

      function appendRows(rows) {
        const msg = list.querySelector('.list-msg');
        if (msg) msg.remove();
        list.append(...rows.map(row));
      }

      function renderList(reset) {
        if (reset) FL.clear(list);
        const msg = list.querySelector('.list-msg');
        if (msg) msg.remove();
        if (error) list.append(h('div', { class: 'list-msg error' }, error));
        else if (!servers.length && !loading) list.append(h('div', { class: 'list-msg' }, 'No servers found.'));
        else if (loading && !servers.length) list.append(h('div', { class: 'list-msg' }, FL.spinner()));
      }

      function render() {
        const g = FL.state.game;
        content.hidden = !g;
        const empty = body.querySelector(':scope > .empty');
        if (empty) empty.remove();
        if (!g) {
          body.append(FL.empty('Join an experience to browse its servers.'));
          return;
        }
        renderInfo();
        renderControls();
      }

      render();
      const tick = setInterval(() => visible && renderInfo(), 30000);

      return {
        onShow() {
          visible = true;
          notice = '';
          render();
          const g = FL.state.game;
          if (g && !g.joining && (g.placeId !== placeId || !servers.length)) load(true);
        },
        onHide() {
          visible = false;
        },
        onState(state, patch) {
          if (!('game' in patch)) return;
          const g = state.game;
          if (g && !g.joining && g.placeId !== placeId && visible) {
            notice = '';
            load(true);
          } else render();
        },
        destroy() {
          clearInterval(tick);
        },
      };
    },
  });
})();
