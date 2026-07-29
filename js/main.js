// N4DU Studio — entry point. Loads the image and coordinates the modules.
// All processing runs in the browser; when main.py is running, the bridge
// adds the native open dialog and replacing files on disk.
(function (N4DU) {

  const { state, resetForImage, toast, bridge, edit } = N4DU;
  const { loadImage, decodeErrorMessage } = N4DU.loader;
  const { exportBlob, download, FORMATS } = N4DU.exporter;
  const { initDropzone, openPicker } = N4DU.dropzone;
  const { initEditorCanvas, drawEditor, syncCanvasUI } = N4DU.editorCanvas;
  const { initControls, syncControls, updateEstimate } = N4DU.controls;
  const { initTools, syncTools } = N4DU.tools;
  const { drawThumb } = N4DU.previews;
  const {
    initReplaceDialog,
    open: openReplaceDialog,
    redraw: redrawReplaceThumb,
    refresh: refreshReplaceModal,
  } = N4DU.replaceDialog;

  // Repaints everything that depends on state. The single callback the UI
  // modules need to know about.
  function refresh() {
    if (!state.img) return;
    syncControls();
    syncTools();
    syncCanvasUI();
    drawEditor();
    drawThumb();
    updateEstimate();
    syncButtons();
    // Keep the replace dialog current while it is open.
    if (!document.getElementById('replaceModal').hidden) {
      redrawReplaceThumb();
      refreshReplaceModal();
    }
  }

  // Browse for a file: the native dialog when the bridge is up, otherwise
  // the browser picker.
  async function chooseFile() {
    if (bridge.active) {
      try {
        const picked = await bridge.pickFile();
        if (picked) await onFile(picked.file, true);
        return;
      } catch (err) {
        toast(err.message, 'err'); // fall back to the browser picker
      }
    }
    openPicker();
  }

  async function onFile(file, fromBridge = false) {
    let bmp;
    try {
      bmp = await loadImage(file);
    } catch {
      toast(decodeErrorMessage(file), 'err');
      return;
    }
    resetForImage(bmp, file);
    edit.load(bmp);          // fresh editing session for this image
    // Dropped, pasted or browser-picked files have no path on disk, so the
    // replacement target is cleared (it is chosen inside the dialog).
    if (!fromBridge) bridge.clearFile();

    document.getElementById('fileInfo').innerHTML =
      `<strong>${escapeHtml(file.name)}</strong><br>` +
      `${state.origW} × ${state.origH} px<br>` +
      `${(file.size / 1024).toFixed(0)} KB`;
    document.getElementById('titleFile').textContent =
      `${file.name} — ${state.origW}×${state.origH} px`;

    document.body.classList.add('has-image');
    document.getElementById('zoomSlider').value = 1;
    document.getElementById('zoomVal').textContent = '100%';

    refresh();
  }

  // ── Download ──────────────────────────────────────────────────────
  async function onDownload() {
    if (!state.img) return;
    const btn = document.getElementById('btnExport');
    btn.disabled = true;
    btn.textContent = 'Working…';
    try {
      const { blob, filename, limit } = await exportBlob(state);
      download(blob, filename);
      if (limit && !limit.ok) {
        // Never present an oversized file as a success.
        toast(`Downloaded ${filename} · ${sizeLabel(blob.size)} — could not get under ${limit.maxKb} KB`, 'err');
      } else {
        toast(`Downloaded ${filename} · ${sizeLabel(blob.size)}`, 'ok');
      }
    } catch (err) {
      toast('Export failed: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Download';
      syncButtons();
    }
  }

  // ── Copy to clipboard ─────────────────────────────────────────────
  // Writing images to the clipboard needs a secure context (https or
  // localhost). Opening the file directly from disk does not qualify, so the
  // failure is explained instead of silently doing nothing.
  async function onCopy() {
    if (!state.img) return;
    const btn = document.getElementById('btnCopy');
    btn.disabled = true;
    btn.textContent = 'Copying…';
    try {
      if (!navigator.clipboard || !window.ClipboardItem) {
        throw new Error('this browser cannot copy images');
      }
      // PNG is the only format clipboards accept reliably, so the copy is
      // always PNG regardless of the chosen export format.
      const canvas = N4DU.render.renderOutput(state, ...outputSize());
      const blob = await canvas.convertToBlob({ type: 'image/png' });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast(`Copied to clipboard · PNG · ${sizeLabel(blob.size)}`, 'ok');
    } catch (err) {
      const secure = window.isSecureContext;
      toast(secure
        ? 'Could not copy: ' + err.message
        : 'Copying needs the desktop version (or an https page)', 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Copy';
      syncButtons();
    }
  }

  function outputSize() {
    const { W, H } = N4DU.exporter.outputDims(state);
    return [W, H];
  }

  function sizeLabel(bytes) {
    const kb = bytes / 1024;
    return kb >= 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(0) + ' KB';
  }

  // ── Buttons ───────────────────────────────────────────────────────
  // Replace is always visible: in browser-only mode it stays enabled but
  // opens the dialog locked, so the feature explains itself instead of
  // disappearing.
  function syncButtons() {
    const hasImage = !!state.img;
    document.getElementById('btnExport').disabled = !hasImage;
    document.getElementById('btnCopy').disabled = !hasImage;

    const rep = document.getElementById('btnReplace');
    rep.hidden = false;
    rep.disabled = !hasImage;
    rep.classList.toggle('locked', !bridge.active);
    rep.title = bridge.active
      ? 'Replace a file on disk (Ctrl+R)'
      : 'Replace a file on disk — desktop version only';
  }

  // After a replacement the title reflects the new file on disk.
  function afterReplace(out) {
    document.getElementById('titleFile').textContent =
      `${out.name} — ${state.origW}×${state.origH} px`;
    syncButtons();
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // ── Keyboard shortcuts ────────────────────────────────────────────
  // Ignored while typing in a field or with the replace dialog open: Ctrl+S
  // would download and Ctrl+R would wipe a half-typed name.
  window.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
    if (!document.getElementById('replaceModal').hidden) return;
    const k = e.key.toLowerCase();
    if (k === 'o') { e.preventDefault(); chooseFile(); return; }
    if (!state.img) return;
    if (k === 's' || k === 'e') { e.preventDefault(); onDownload(); }
    if (k === 'c') { e.preventDefault(); onCopy(); }
    if (k === 'r') { e.preventDefault(); openReplaceDialog(); }
    if (k === 'z') {
      e.preventDefault();
      const moved = e.shiftKey ? edit.redo() : edit.undo();
      if (moved) {
        N4DU.syncToSurface(edit.width(), edit.height(), true);
        refresh();
      }
    }
  });

  initDropzone(onFile, chooseFile);
  initEditorCanvas(refresh);
  initControls(refresh);
  initTools(refresh);
  initReplaceDialog(afterReplace);
  edit.setOnChanged(() => { /* tools repaint explicitly to stay responsive */ });

  document.getElementById('btnExport').addEventListener('click', onDownload);
  document.getElementById('btnCopy').addEventListener('click', onCopy);
  document.getElementById('btnReplace').addEventListener('click', openReplaceDialog);
  bridge.init().then(syncButtons);
  syncButtons();

})(window.N4DU ??= {});
