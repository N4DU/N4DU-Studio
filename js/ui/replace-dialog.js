// Replace dialog: shows which file on disk is swapped for which, with
// Windows-style thumbnails and an editable output name.
//
// It also opens in browser-only mode, where writing to disk is impossible.
// There the two thumbnails still explain what the feature does, and the
// action is locked with a short note pointing at the desktop launcher.
(function (N4DU) {

  const { state, toast, bridge } = N4DU;
  const { loadImage } = N4DU.loader;
  const { exportBlob, FORMATS, outputDims } = N4DU.exporter;
  const { renderOutput } = N4DU.render;

  const $ = (id) => document.getElementById(id);

  // Thumbnail of the file to be replaced (real bytes from disk).
  let srcBitmap = null;
  let onDone = null;  // callback after a successful replacement

  function initReplaceDialog(afterReplace) {
    onDone = afterReplace;
    $('btnReplaceCancel').addEventListener('click', close);
    $('btnPickTarget').addEventListener('click', chooseTarget);
    $('btnReplaceConfirm').addEventListener('click', confirm);
    $('dstStem').addEventListener('input', syncModal);

    // Close on Escape or a click on the backdrop
    $('replaceModal').addEventListener('click', e => {
      if (e.target === $('replaceModal')) close();
    });
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !$('replaceModal').hidden) close();
    });
  }

  // The bridge is unavailable: the dialog is a read-only explanation.
  function locked() { return !bridge.active; }

  async function open() {
    if (!state.img) return;
    releaseSource();

    // Default output name: the file being replaced if one is chosen,
    // otherwise the name of the image being edited.
    const stem = bridge.canReplace()
      ? baseName(bridge.path).replace(/\.[^.]+$/, '')
      : state.fileName;
    $('dstStem').value = stem;

    $('replaceModal').hidden = false;
    // Focus goes in, and stays in, until it closes — see js/ui/modal.js.
    // The name field, because that is what somebody came here to change.
    N4DU.modal.opened($('replaceModal'), $('dstStem'));
    paintSource();            // name and empty/filled state immediately…
    drawDestThumb();
    syncModal();
    await loadSourceThumb();  // …and the source thumbnail once it arrives
  }

  function close() {
    $('replaceModal').hidden = true;
    N4DU.modal.closed($('replaceModal'));
    releaseSource();
  }

  // Choose (or change) which file on disk gets replaced.
  async function chooseTarget() {
    if (locked()) {
      toast('Choosing a file requires the desktop version', 'err');
      return;
    }
    try {
      const picked = await bridge.pickTarget();
      if (!picked) return; // cancelled
      // Adopt the chosen file's name (still editable afterwards).
      $('dstStem').value = baseName(picked.path).replace(/\.[^.]+$/, '');
      paintSource();
      syncModal();
      await loadSourceThumb();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  // Loads the bytes of the file to replace and builds its thumbnail.
  async function loadSourceThumb() {
    releaseSource();
    if (!bridge.canReplace()) return;
    try {
      const blob = await bridge.readCurrent();
      srcBitmap = await loadImage(new File([blob], baseName(bridge.path)));
    } catch {
      srcBitmap = null; // no preview available; replacing still works
    }
    paintSource();
  }

  // Releases the previous thumbnail (holds decoded image memory).
  function releaseSource() {
    if (srcBitmap && typeof srcBitmap.close === 'function') srcBitmap.close();
    srcBitmap = null;
  }

  function paintSource() {
    const doc = $('srcDoc');
    const name = $('srcName');
    if (bridge.canReplace()) {
      doc.classList.remove('empty');
      name.textContent = baseName(bridge.path);
      if (srcBitmap) fitInto($('srcThumb'), srcBitmap);
      else clearCanvas($('srcThumb'));
    } else {
      doc.classList.add('empty');
      // In browser-only mode the left card stands for "any file on your disk".
      name.textContent = locked() ? 'A file on your disk' : 'No file selected';
      clearCanvas($('srcThumb'));
    }
  }

  // Thumbnail of the result: reflects crop, shape, real size (including the
  // ICO 256 cap) and the background of the chosen format.
  function drawDestThumb() {
    const MAX = 88;
    const { W, H } = outputDims(state);
    const s = Math.min(MAX / W, MAX / H, 1);
    const w = Math.max(1, Math.round(W * s));
    const h = Math.max(1, Math.round(H * s));
    const bg = FORMATS[state.fmt].alpha ? null : '#ffffff';
    const out = renderOutput(state, w, h, bg);
    const c = $('dstThumb');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(out, 0, 0);
  }

  function syncModal() {
    paintSource();
    const ext = FORMATS[state.fmt].ext;
    $('dstExt').textContent = '.' + ext;

    const stem = cleanStem($('dstStem').value);
    const isLocked = locked();

    // Browser-only mode: the explanation shows, the action does not run.
    $('replaceLocked').hidden = !isLocked;
    $('btnPickTarget').disabled = isLocked;
    $('dstStem').disabled = isLocked;
    $('btnReplaceConfirm').disabled = isLocked || !bridge.canReplace() || !stem;
    $('btnReplaceConfirm').title = isLocked
      ? 'Available in the desktop version' : '';

    const hint = $('replaceModalHint');
    if (isLocked) {
      hint.textContent = 'The file on the left is overwritten by the one on the right.';
    } else if (!bridge.canReplace()) {
      hint.textContent = 'Choose the file on disk that will be replaced.';
    } else {
      const from = baseName(bridge.path);
      const to = stem + '.' + ext;
      hint.textContent = from === to
        ? `${from} will be overwritten.`
        : `${from}  →  ${to}   (the previous file is deleted)`;
    }
  }

  async function confirm() {
    if (locked()) return;
    const stem = cleanStem($('dstStem').value);
    if (!bridge.canReplace() || !stem) return;
    const btn = $('btnReplaceConfirm');
    btn.disabled = true;
    btn.textContent = 'Replacing…';
    try {
      const { blob, limit } = await exportBlob(state);
      const ext = FORMATS[state.fmt].ext;
      let out;
      try {
        out = await bridge.replaceOriginal(blob, ext, stem);
      } catch (err) {
        // The target exists and is a different file: the server refuses to
        // overwrite it without permission, so ask before destroying it.
        if (!err.conflict) throw err;
        const ok = window.confirm(
          `"${err.conflict}" already exists in that folder.\n\n` +
          `Continuing replaces that file with the new one and deletes ` +
          `"${baseName(bridge.path)}".\n\nContinue?`);
        if (!ok) { toast('Replacement cancelled', ''); return; }
        out = await bridge.replaceOriginal(blob, ext, stem, true);
      }
      const kb = blob.size / 1024;
      const size = kb >= 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(0) + ' KB';
      close();
      if (limit && !limit.ok) {
        toast(`Replaced ${out.name} · ${size} — could not get under ${N4DU.controls.limitLabel()}`, 'err');
      } else if (out.warning) {
        toast(`Replaced ${out.name} · ${size} — ${out.warning}`, 'err');
      } else {
        toast(`Replaced on disk: ${out.name} · ${size}`, 'ok');
      }
      if (onDone) onDone(out);
    } catch (err) {
      toast('Could not replace: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Replace';
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────
  function baseName(p) { return (p || '').split(/[\\/]/).pop(); }

  // Strips characters that are invalid in file names on Windows/Unix.
  function cleanStem(s) {
    return (s || '').replace(/[\\/:*?"<>|]/g, '').replace(/^\.+/, '').trim();
  }

  function fitInto(canvas, bitmap) {
    const MAX_W = 72, MAX_H = 88;
    const s = Math.min(MAX_W / bitmap.width, MAX_H / bitmap.height, 1);
    const w = Math.max(1, Math.round(bitmap.width * s));
    const h = Math.max(1, Math.round(bitmap.height * s));
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  }

  function clearCanvas(canvas) {
    canvas.width = canvas.height = 1;
    canvas.getContext('2d').clearRect(0, 0, 1, 1);
  }

  N4DU.replaceDialog = { initReplaceDialog, open, refresh: syncModal, redraw: drawDestThumb };

})(window.N4DU ??= {});
