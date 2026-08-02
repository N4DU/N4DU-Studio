// Carrying your work into the window that opens.
//
// Pressing Window opens a second window on the same page, and that window is
// a fresh page load: it has never heard of the twelve files you just dropped,
// the one you had selected, or the edit you were halfway through. The tab you
// came from then closes itself, and all of it is gone. The button read as
// "start again, but smaller".
//
// The two windows are the same origin and one opened the other, so they can
// simply be introduced. postMessage carries a File as a File — not a copy of
// its bytes, not a path — so the list arrives intact without anything being
// re-read from disk or written anywhere.
//
// What travels: the files, in order, with their names and whatever the
// desktop bridge gave them; the one that was selected; any picture the editor
// has already changed; and which of the two screens you were looking at. What
// does not: the undo history. Twenty full-size snapshots is hundreds of
// megabytes to move for a stack nobody presses after changing windows, and
// the pixels themselves arrive as they stand.
(function (N4DU) {

  const { batch } = N4DU;

  // How long to wait for the new window to say hello. It is a fresh page
  // load of files already in the browser's cache, so this is generous; and
  // if it does elapse the old window steps aside anyway rather than sitting
  // there waiting for a window that is never going to answer.
  const HELLO_TIMEOUT = 4000;

  // ── The window being left ─────────────────────────────────────────
  // Gathers everything worth taking and posts it across once the new window
  // says it is listening.
  async function handOver(win) {
    const payload = await collect();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        window.removeEventListener('message', onMessage);
        clearTimeout(timer);
        resolve();
      };
      function onMessage(e) {
        // Identity by window object, not by origin string: opened from a
        // file:// page both origins are "null", which would match anybody.
        if (e.source !== win || !e.data || e.data.n4du !== 'ready') return;
        try {
          win.postMessage({ n4du: 'state', payload }, '*');
        } catch { /* it closed; nothing to hand over to */ }
        // A beat for the message to land before this window goes away.
        setTimeout(finish, 60);
      }
      window.addEventListener('message', onMessage);
      const timer = setTimeout(finish, HELLO_TIMEOUT);
    });
  }

  async function collect() {
    const files = [];
    for (const item of batch.items) {
      files.push({
        file: item.file,
        name: item.name,
        token: item.token || null,
        path: item.path || null,
        // The editor's work, as bytes. An ImageBitmap could be transferred
        // instead, but transferring it would close the one this window is
        // still drawing until it goes away — and it might not go away, if
        // the browser refuses to close the tab.
        edited: item.edited ? await toBlob(item.edited) : null,
        selected: item.id === batch.selectedId,
      });
    }
    return {
      files,
      mode: document.body.classList.contains('mode-edit') ? 'edit' : 'convert',
    };
  }

  async function toBlob(bmp) {
    try {
      const canvas = new OffscreenCanvas(bmp.width, bmp.height);
      canvas.getContext('2d').drawImage(bmp, 0, 0);
      return await canvas.convertToBlob({ type: 'image/png' });
    } catch {
      return null;      // better to arrive without one edit than not at all
    }
  }

  // ── The window that opened ────────────────────────────────────────
  // own-window.js said hello from the <head>, before any of this existed,
  // and buffered whatever came back. This puts it into the list.
  async function claim(hooks = {}) {
    if (!N4DU.ownWindow || !N4DU.ownWindow.expectsHandover()) return false;
    const payload = await N4DU.ownWindow.awaitHandover(HELLO_TIMEOUT);
    if (!payload || !payload.files || !payload.files.length) return false;

    let selected = null;
    for (const entry of payload.files) {
      if (!entry.file) continue;
      const before = batch.items.length;
      await batch.add([entry.file], { token: entry.token, path: entry.path });
      const item = batch.items[before];
      if (!item) continue;               // it would not decode; already reported
      if (entry.name) item.name = entry.name;
      if (entry.edited) {
        try { batch.setEdited(item.id, await createImageBitmap(entry.edited)); }
        catch { /* the picture is still there, just unedited */ }
      }
      if (entry.selected) selected = item.id;
    }
    if (selected !== null) batch.select(selected);

    const n = batch.items.length;
    if (n) {
      N4DU.toast(`Carried ${n} file${n > 1 ? 's' : ''} over from the tab`, 'ok');
    }
    // Back to the screen you were on. Only when there is something to show:
    // the editor with an empty list is not where anybody was.
    if (payload.mode === 'edit' && selected !== null && hooks.onEdit) {
      await hooks.onEdit(selected);
    }
    return true;
  }

  N4DU.handover = { handOver, claim };

  // own-window.js opens the window and then gets this one out of the way.
  // Registering here means it waits for the handover first — closing the tab
  // mid-message is exactly how the work would be lost.
  if (N4DU.ownWindow) N4DU.ownWindow.setHandover(handOver);

})(window.N4DU ??= {});
