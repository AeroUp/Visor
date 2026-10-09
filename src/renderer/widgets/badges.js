'use strict';
(() => {
  const { h, fmt } = FL;

  // Roblox's own difficulty bands, by % of players who earned the badge.
  function difficulty(rate) {
    if (rate === null || rate === undefined) return '';
    const p = rate * 100;
    if (p >= 90) return 'Freebie';
    if (p >= 80) return 'Cake walk';
    if (p >= 50) return 'Easy';
    if (p >= 20) return 'Moderate';
    if (p >= 10) return 'Challenging';
    if (p >= 5) return 'Hard';
    if (p >= 1) return 'Extreme';
    if (p >= 0.1) return 'Insane';
    return 'Impossible';
  }
  const pct = (rate) => {
    const p = rate * 100;
    return `${p >= 10 ? p.toFixed(0) : p >= 1 ? p.toFixed(1) : p.toFixed(2)}%`;
  };

  FL.defineWidget({
    id: 'badges',
    title: 'Badges',
    icon: 'trophy',
    order: 2,
    size: { w: 440, h: 480 },
    min: { w: 320, h: 260 },
    place: (vw) => ({ x: Math.round(vw * 0.3), y: 50 }),

    mount(body) {
      const cache = new Map(); // `${universeId}:${userId}` -> { at, data }
      let data = null;
      let error = '';
      let loading = false;
      let filter = 'all';
      let key = '';
      let visible = false;

      const head = h('div', { class: 'badge-head' });
      const list = h('div', { class: 'list badge-list' });
      body.classList.add('badge-body');
      body.append(head, list);

      async function load(force) {
        const g = FL.state.game;
        if (!g || !g.universeId) {
          data = null;
          key = '';
          return render();
        }
        const userId = FL.state.profile && FL.state.profile.id;
        const k = `${g.universeId}:${userId || ''}`;
        const hit = cache.get(k);
        if (!force && hit && Date.now() - hit.at < 120000) {
          key = k;
          data = hit.data;
          return render();
        }
        key = k;
        loading = true;
        error = '';
        render();
        try {
          const res = await FL.api('badges', g.universeId, userId);
          if (key !== k) return;
          cache.set(k, { at: Date.now(), data: res });
          data = res;
        } catch (err) {
          if (key !== k) return;
          error = err.message;
        }
        loading = false;
        render();
      }

      function chip(id, label) {
        return h('button', { class: filter === id ? 'on' : '', onclick: () => ((filter = id), render()) }, label);
      }

      function row(b) {
        const owned = !!b.awardedAt;
        const meta = [b.winRate !== null ? `${pct(b.winRate)} · ${difficulty(b.winRate)}` : '', b.awardedCount ? `${fmt.compact(b.awardedCount)} awarded` : '']
          .filter(Boolean)
          .join(' · ');
        return h(
          'div',
          { class: 'row badge-row' + (owned ? ' owned' : '') },
          h('div', { class: 'badge-icon' }, FL.img(b.icon), owned ? h('span', { class: 'badge-check' }, FL.icon('check', 12)) : null),
          h(
            'div',
            { class: 'row-main' },
            h('div', { class: 'row-title' }, b.name),
            b.description ? h('div', { class: 'row-desc' }, b.description) : null,
            h('div', { class: 'row-sub' }, owned ? h('span', { class: 'earned' }, `Earned ${fmt.date(b.awardedAt)}`) : null, owned && meta ? ' · ' : null, meta)
          )
        );
      }

      function render() {
        const g = FL.state.game;
        if (!g) {
          FL.clear(head);
          return FL.clear(list, FL.empty('Join an experience to see its badges.'));
        }
        if (loading && !data) {
          FL.clear(head);
          return FL.clear(list, h('div', { class: 'list-msg' }, FL.spinner()));
        }
        if (error) {
          FL.clear(head);
          return FL.clear(list, FL.empty(`Couldn't load badges: ${error}`, h('button', { class: 'btn sm', onclick: () => load(true) }, 'Try again')));
        }
        if (!data) {
          FL.clear(head);
          return FL.clear(list, h('div', { class: 'list-msg' }, FL.spinner()));
        }

        const all = data.badges;
        const owned = all.filter((b) => b.awardedAt).length;
        if (!all.length) {
          FL.clear(head);
          return FL.clear(list, FL.empty(`${g.name || 'This experience'} has no badges.`));
        }

        if (data.ownershipKnown) {
          FL.clear(
            head,
            h('div', { class: 'badge-summary' }, h('strong', null, `${owned} of ${all.length}`), ' badges earned'),
            h('div', { class: 'progress' }, h('span', { style: { width: `${(owned / all.length) * 100}%` } })),
            h('div', { class: 'seg small' }, chip('all', 'All'), chip('earned', 'Earned'), chip('missing', 'Not earned'))
          );
        } else {
          FL.clear(
            head,
            h('div', { class: 'badge-summary' }, h('strong', null, String(all.length)), ' badges'),
            h(
              'div',
              { class: 'hint' },
              FL.state.signedIn ? 'Badge progress is unavailable for this account.' : 'Sign in to see which badges you’ve earned. ',
              FL.state.signedIn ? null : h('button', { class: 'link-btn', onclick: () => window.visor.call('accounts:add') }, 'Sign in')
            )
          );
        }

        let shown = all;
        if (data.ownershipKnown && filter === 'earned') shown = all.filter((b) => b.awardedAt);
        if (data.ownershipKnown && filter === 'missing') shown = all.filter((b) => !b.awardedAt);
        FL.clear(list, shown.length ? shown.map(row) : FL.empty(filter === 'earned' ? 'No badges earned yet.' : 'You’ve earned them all!'));
      }

      render();
      return {
        onShow() {
          visible = true;
          load(false);
        },
        onHide() {
          visible = false;
        },
        onState(state, patch) {
          if (!visible) return;
          if ('game' in patch || 'profile' in patch || 'signedIn' in patch) {
            const g = state.game;
            const k = g && g.universeId ? `${g.universeId}:${(state.profile && state.profile.id) || ''}` : '';
            if (k !== key) load(false);
          }
        },
      };
    },
  });
})();
