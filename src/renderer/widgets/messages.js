'use strict';
(() => {
  const { h, fmt } = FL;

  FL.defineWidget({
    id: 'messages',
    title: 'Messages',
    icon: 'message',
    order: 1,
    size: { w: 400, h: 480 },
    min: { w: 300, h: 300 },
    place: (vw) => ({ x: Math.round(vw / 2 - 200), y: 40 }),

    mount(body, ctx) {
      let view = 'list'; // 'list' | 'thread'
      let convos = null;
      let active = null;
      let messages = [];
      let error = '';
      let loading = false;
      let visible = false;
      let poll = null;
      let sending = false;
      let thread = null;
      let accountKey = `${FL.state.signedIn}:${FL.state.profile && FL.state.profile.id}`; // persistent elements for the open conversation

      body.classList.add('msg-body');
      const myId = () => (FL.state.profile && FL.state.profile.id) || '';

      async function loadConvos() {
        loading = !convos;
        render();
        try {
          convos = await FL.api('chatConversations', myId());
          error = '';
        } catch (err) {
          error = err.status === 401 ? 'Your Roblox session expired. Sign in again.' : `Roblox chat is unavailable right now (${err.message}).`;
        }
        loading = false;
        if (view === 'list') render();
      }

      async function loadThread(scroll) {
        if (!active) return;
        const id = active.id;
        try {
          const msgs = await FL.api('chatMessages', id);
          if (!active || active.id !== id) return;
          messages = msgs.slice().sort((a, b) => new Date(a.sentAt) - new Date(b.sentAt));
          error = '';
        } catch (err) {
          error = `Couldn't load messages (${err.message}).`;
        }
        if (view === 'thread') render(scroll);
      }

      function open(c) {
        view = 'thread';
        active = c;
        messages = [];
        error = '';
        render();
        loadThread(true);
      }

      function back() {
        view = 'list';
        active = null;
        thread = null;
        render();
        loadConvos();
      }

      async function sendMsg(input) {
        const text = input.value.trim();
        if (!text || sending || !active) return;
        sending = true;
        input.disabled = true;
        try {
          await FL.api('chatSend', active.id, text);
          input.value = '';
          await loadThread(true);
        } catch (err) {
          error = `Message not sent (${err.message}).`;
          render();
        }
        sending = false;
        input.disabled = false;
        input.focus();
      }

      function renderSignedOut() {
        FL.clear(
          body,
          FL.empty(
            FL.state.profile ? `Add ${FL.state.profile.displayName} to Visor to read and reply to their chats here.` : 'Add your Roblox account to read and reply to your chats here.',
            h('button', { class: 'btn primary', onclick: () => window.visor.call('accounts:add') }, FL.icon('login', 16), FL.state.profile && FL.state.profile.name ? `Sign in as @${FL.state.profile.name}` : 'Sign in with Roblox')
          )
        );
      }

      function renderList() {
        if (loading) return FL.clear(body, h('div', { class: 'list-msg' }, FL.spinner()));
        const rows = (convos || []).map((c) =>
          h(
            'button',
            { class: 'convo', onclick: () => open(c) },
            FL.img(c.avatar, 'convo-av'),
            h(
              'div',
              { class: 'row-main' },
              h('div', { class: 'convo-top' }, h('span', { class: 'row-title' }, c.name), h('span', { class: 'muted small' }, c.last ? fmt.ago(c.last.sentAt) : '')),
              h('div', { class: 'row-sub' }, c.last ? (c.last.senderId === myId() ? 'You: ' : '') + c.last.text : 'No messages yet')
            ),
            c.unread ? h('span', { class: 'unread' }, String(c.unread)) : null
          )
        );
        FL.clear(
          body,
          error ? h('div', { class: 'list-msg error' }, error, ' ', h('button', { class: 'link-btn', onclick: loadConvos }, 'Retry')) : null,
          rows.length ? h('div', { class: 'list' }, rows) : error ? null : FL.empty('No conversations yet.')
        );
      }

      function buildThread() {
        const input = h('input', { class: 'input grow', placeholder: `Message ${active.name}`, maxlength: '200' });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') sendMsg(input);
        });
        thread = {
          id: active.id,
          input,
          err: h('div', { class: 'list-msg error' }),
          log: h('div', { class: 'thread' }),
        };
        FL.clear(
          body,
          h('div', { class: 'thread-head' }, h('button', { class: 'icon-btn sm', 'aria-label': 'Back', icon: 'chevronLeft', onclick: back }), FL.img(active.avatar, 'convo-av sm'), h('span', { class: 'row-title' }, active.name)),
          thread.err,
          thread.log,
          h('div', { class: 'composer' }, input, h('button', { class: 'icon-btn primary', 'aria-label': 'Send', icon: 'send', onclick: () => sendMsg(input) }))
        );
        if (visible) setTimeout(() => input.focus(), 30);
      }

      function renderThread(scroll) {
        if (!thread || thread.id !== active.id || !body.contains(thread.log)) buildThread();
        thread.err.hidden = !error;
        FL.clear(thread.err, error);
        const log = thread.log;
        const wasAtBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 30;
        FL.clear(
          log,
          messages.length
            ? messages.map((m) => {
                const mine = m.senderId === myId();
                return h(
                  'div',
                  { class: 'bubble-row' + (mine ? ' mine' : '') },
                  h('div', { class: 'bubble' }, !mine && m.senderName && active.type === 'group' ? h('div', { class: 'sender' }, m.senderName) : null, m.text)
                );
              })
            : h('div', { class: 'list-msg' }, error ? '' : FL.spinner())
        );
        if (scroll || wasAtBottom) log.scrollTop = log.scrollHeight;
      }

      function render(scroll) {
        if (!FL.state.signedIn) return renderSignedOut();
        if (view === 'thread' && active) renderThread(scroll);
        else renderList();
      }

      function startPolling() {
        clearInterval(poll);
        poll = setInterval(() => {
          if (!visible || !FL.state.signedIn || sending) return;
          if (view === 'thread') loadThread(false);
          else loadConvos();
        }, 8000);
      }

      render();
      return {
        onShow() {
          visible = true;
          if (FL.state.signedIn) {
            if (view === 'thread') loadThread(true);
            else loadConvos();
          } else render();
          startPolling();
        },
        onHide() {
          visible = false;
          clearInterval(poll);
        },
        onState(state, patch) {
          // Switching Roblox windows can switch accounts: start over with the new account's chats.
          const key = `${state.signedIn}:${state.profile && state.profile.id}`;
          if (('signedIn' in patch || 'profile' in patch) && key !== accountKey) {
            accountKey = key;
            convos = null;
            view = 'list';
            active = null;
            if (visible && state.signedIn) loadConvos();
            else render();
          }
        },
      };
    },
  });
})();
