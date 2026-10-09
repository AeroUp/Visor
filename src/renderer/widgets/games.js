'use strict';
(() => {
  const { h, fmt } = FL;

  FL.defineWidget({
    id: 'games',
    title: 'Games',
    icon: 'gamepad',
    order: 4,
    size: { w: 600, h: 370 },
    min: { w: 300, h: 240 },
    place: () => ({ x: 10, y: 30 }),

    mount(body) {
      let tab = 'search';
      let query = '';
      let results = [];
      let nextPage = null;
      let loading = false;
      let seq = 0;
      let favorites = null;
      let favoritesAt = 0;
      let status = null; // { text, joining }

      const searchTab = h('button', { onclick: () => setTab('search') }, FL.icon('search', 15), 'Search');
      const favTab = h('button', { onclick: () => setTab('favorites') }, FL.icon('star', 15), 'Favorites');
      const input = h('input', { class: 'input grow', placeholder: 'Search experiences', spellcheck: 'false' });
      const statusEl = h('div', { class: 'games-status' });
      const grid = h('div', { class: 'games-grid' });
      const scroller = h('div', { class: 'games-scroll' }, grid);

      body.classList.add('games-body');
      body.append(h('div', { class: 'games-top' }, h('div', { class: 'seg' }, searchTab, favTab), input, FL.joinAsPicker()), statusEl, scroller);

      const runSearch = FL.debounce(() => search(false), 350);
      input.addEventListener('input', () => {
        query = input.value;
        runSearch();
      });
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') search(false);
      });
      scroller.addEventListener('scroll', () => {
        if (tab === 'search' && nextPage && !loading && scroller.scrollTop + scroller.clientHeight > scroller.scrollHeight - 120) {
          search(true);
        }
      });

      function setTab(t) {
        tab = t;
        searchTab.classList.toggle('on', t === 'search');
        favTab.classList.toggle('on', t === 'favorites');
        input.hidden = t !== 'search';
        status = null;
        if (t === 'favorites') loadFavorites();
        render();
        if (t === 'search') input.focus();
      }

      async function search(more) {
        const q = query.trim();
        const my = ++seq;
        if (!q) {
          results = [];
          nextPage = null;
          loading = false;
          return render();
        }
        loading = true;
        if (!more) {
          results = [];
          nextPage = null;
        }
        render();
        try {
          const res = await FL.api('search', q, more ? nextPage : null);
          if (my !== seq) return;
          const seen = new Set(results.map((r) => r.universeId));
          results = results.concat(res.items.filter((r) => !seen.has(r.universeId)));
          nextPage = res.nextPageToken;
          status = null;
        } catch (err) {
          if (my !== seq) return;
          status = { text: `Search failed: ${err.message}` };
        }
        loading = false;
        render();
      }

      async function loadFavorites(force) {
        const userId = FL.state.profile && FL.state.profile.id;
        if (!userId) return render();
        if (!force && favorites && Date.now() - favoritesAt < 60000) return render();
        loading = true;
        render();
        try {
          favorites = await FL.api('favorites', userId);
          favoritesAt = Date.now();
          status = null;
        } catch (err) {
          status = { text: `Couldn't load favorites: ${err.message}` };
        }
        loading = false;
        render();
      }

      async function join(game) {
        status = { text: `Joining ${game.name}…`, joining: true };
        render();
        try {
          await FL.launch({ placeId: game.placeId });
        } catch (err) {
          status = { text: `Couldn't start Roblox: ${err.message}` };
          render();
        }
      }

      function card(g) {
        return h(
          'button',
          { class: 'game-card', 'aria-label': `Play ${g.name}`, onclick: () => join(g) },
          h('div', { class: 'thumb' }, FL.img(g.icon), h('span', { class: 'play' }, FL.icon('play', 22))),
          h('div', { class: 'g-name' }, g.name),
          h('div', { class: 'g-sub' }, `${fmt.compact(g.playing)} playing`)
        );
      }

      function render() {
        const list = tab === 'search' ? results : favorites || [];
        FL.clear(
          statusEl,
          status ? h('span', { class: status.joining ? 'joining' : 'error' }, status.joining ? h('i', { class: 'dot' }) : null, status.text) : null
        );

        if (!list.length) {
          if (loading) return FL.clear(grid, h('div', { class: 'grid-msg' }, FL.spinner()));
          let msg;
          if (tab === 'search') msg = query.trim() ? 'No experiences found.' : 'Search for an experience to jump into.';
          else if (!FL.state.profile) msg = 'Join a game or sign in so Visor knows whose favorites to show.';
          else msg = 'No favorites yet. Favorite experiences on Roblox and they show up here.';
          return FL.clear(grid, h('div', { class: 'grid-msg' }, msg));
        }
        FL.clear(grid, list.map(card), loading ? h('div', { class: 'grid-msg span' }, FL.spinner()) : null);
      }

      setTab('search');

      return {
        onShow() {
          if (tab === 'search') setTimeout(() => input.focus(), 50);
          else loadFavorites();
        },
        onState(state, patch) {
          if ('profile' in patch && tab === 'favorites') loadFavorites(true);
        },
      };
    },
  });
})();
