'use strict';
(() => {
  const { h, fmt } = FL;

  FL.defineWidget({
    id: 'notes',
    title: 'Notes',
    icon: 'note',
    order: 6,
    size: { w: 460, h: 236 },
    min: { w: 260, h: 150 },
    place: (vw) => ({ x: vw - 470, y: 10 }),

    mount(body) {
      let savedAt = FL.state.store.notesSavedAt;
      let timer = null;
      let undoText = null;

      const text = h('textarea', {
        class: 'notes-text',
        placeholder: 'Jot down codes, builds, anything you want to keep for later. Saved automatically.',
        spellcheck: 'false',
      });
      text.value = FL.state.store.notes || '';

      const clearBtn = h('button', { class: 'icon-btn sm notes-clear', 'aria-label': 'Clear notes', icon: 'x', onclick: clearNotes });
      const status = h('div', { class: 'notes-status' });

      function showSaved() {
        FL.clear(status, savedAt ? `Saved at ${fmt.time12(savedAt)}` : '');
      }
      function syncClear() {
        clearBtn.hidden = !text.value;
      }
      async function save() {
        clearTimeout(timer);
        timer = null;
        savedAt = await window.visor.call('notes:save', text.value);
        FL.state.store.notes = text.value;
        FL.state.store.notesSavedAt = savedAt;
        if (undoText === null) showSaved();
      }
      function schedule() {
        FL.clear(status, 'Unsaved changes');
        clearTimeout(timer);
        timer = setTimeout(save, 700);
      }
      function clearNotes() {
        undoText = text.value;
        text.value = '';
        syncClear();
        save();
        FL.clear(
          status,
          'Notes cleared · ',
          h('button', {
            class: 'link-btn',
            onclick: () => {
              text.value = undoText;
              undoText = null;
              syncClear();
              save();
              text.focus();
            },
          }, 'Undo')
        );
        setTimeout(() => {
          if (undoText !== null) {
            undoText = null;
            showSaved();
          }
        }, 8000);
      }

      text.addEventListener('input', () => {
        undoText = null;
        syncClear();
        schedule();
      });

      body.classList.add('notes-body');
      body.append(h('div', { class: 'notes-wrap' }, text, clearBtn), status);
      syncClear();
      showSaved();

      return {
        onOverlay(open) {
          if (!open && timer) save();
        },
      };
    },
  });
})();
