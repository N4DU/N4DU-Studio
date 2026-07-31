// N4DU Studio — entry point. Loads the image and coordinates the modules.
// All processing runs in the browser; when main.py is running, the bridge
// adds the native open dialog and replacing files on disk.
(function (N4DU) {

  const { state, resetForImage, toast, bridge, edit, batch } = N4DU;
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

  // ── Modes ─────────────────────────────────────────────────────────
  // The converter is what the app opens in. The editor is the same code,
  // the same window, a different arrangement — reached in one click and
  // never in the way.
  const MODE_KEY = 'n4du.mode';

  function currentMode() {
    return document.body.classList.contains('mode-edit') ? 'edit' : 'convert';
  }

  function setMode(mode, { remember = true } = {}) {
    const edit_ = mode === 'edit';
    document.body.classList.toggle('mode-edit', edit_);
    document.body.classList.toggle('mode-convert', !edit_);
    document.getElementById('modeLabel').textContent = edit_ ? 'Converter' : 'Editor';
    document.getElementById('btnMode').title = edit_
      ? 'Back to the converter'
      : 'Open the editor for the selected picture';
    if (remember) {
      try { localStorage.setItem(MODE_KEY, mode); } catch { /* not always available */ }
    }
    if (edit_) refresh();
    else N4DU.batchUI.syncBatch();
    N4DU.windowSize.fit();
  }

  // Opening the editor on one item of the batch. The picture the editor
  // works on is that item's, and what comes back replaces it in the list.
  async function editItem(id) {
    const item = batch.items.find(it => it.id === id) || batch.selected();
    if (!item) {
      toast('Add a picture first', '');
      return;
    }
    batch.select(item.id);
    editing = item.id;
    let handle = null;
    try {
      handle = await batch.decode(item);
      // A copy, so closing the editor's bitmap never frees the item's own.
      const copy = await createImageBitmap(handle.bmp);
      await adoptIntoEditor(copy, item);
      setMode('edit');
    } catch (err) {
      toast('Could not open that picture: ' + err.message, 'err');
    } finally {
      if (handle) handle.release();
    }
  }

  // Hands the editor's current pixels back to the batch item, so converting
  // uses the edited version.
  function returnToConverter() {
    if (editing !== null && edit.ready()) {
      try {
        const bmp = edit.toBitmap();
        if (bmp) batch.setEdited(editing, bmp);
      } catch { /* nothing worth losing the mode switch over */ }
    }
    setMode('convert');
  }

  let editing = null;   // which batch item the editor is showing

  // Browse for files: the native dialog when the bridge is up, otherwise
  // the browser picker. In the converter every chosen file joins the list;
  // in the editor only the first is opened.
  async function chooseFile() {
    if (bridge.active) {
      try {
        const picked = await bridge.pickFiles(currentMode() === 'convert');
        if (picked.length) await acceptPicked(picked);
        return;
      } catch (err) {
        toast(err.message, 'err'); // fall back to the browser picker
      }
    }
    openPicker();
  }

  // Files that arrived with a real location on disk (native dialog, or the
  // right-click menu), so they can be overwritten in place.
  async function acceptPicked(picked) {
    if (currentMode() === 'edit') {
      bridge.token = picked[0].token;
      bridge.path = picked[0].path;
      await onFile(picked[0].file, true);
      return;
    }
    for (const one of picked) {
      await batch.add([one.file], { token: one.token, path: one.path });
    }
    announceAdded(picked.length);
  }

  // Files with no location: dropped, pasted, or chosen through the browser.
  async function onFiles(files) {
    if (currentMode() === 'edit') {
      await onFile(files[0], false);
      return;
    }
    const { added, failed, skipped } = await batch.add(files);
    if (failed.length) toast(`${failed.length} file${failed.length > 1 ? 's' : ''} could not be read`, 'err');
    else if (skipped) toast(`List is full at ${batch.MAX_ITEMS} files — ${skipped} left out`, 'err');
    else announceAdded(added);
  }

  function announceAdded(n) {
    if (n > 0) toast(`Added ${n} file${n > 1 ? 's' : ''}`, 'ok');
    offerFolder();
  }

  // ── The rest of the folder ────────────────────────────────────────
  // Windows decides how many files a right-click hands over, and that
  // decision changes with its version and how many are selected. Rather than
  // depend on it, the app asks what else is in the folder and offers it.
  let offering = false;

  async function offerFolder() {
    if (!bridge.active || offering) return;
    const anchor = batch.items.find(it => it.token);
    if (!anchor) { N4DU.batchUI.setFolderOffer(0, ''); return; }
    try {
      const have = batch.items.map(it => it.path).filter(Boolean);
      const { folder, metas } = await bridge.siblings(anchor.token, have);
      N4DU.batchUI.setFolderOffer(metas.length, folder.split(/[\\/]/).pop());
    } catch {
      N4DU.batchUI.setFolderOffer(0, '');
    }
  }

  async function addFolder() {
    const anchor = batch.items.find(it => it.token);
    if (!anchor || offering) return;
    offering = true;
    try {
      const have = batch.items.map(it => it.path).filter(Boolean);
      const { metas } = await bridge.siblings(anchor.token, have);
      const picked = await bridge.collect(metas);
      for (const one of picked) {
        await batch.add([one.file], { token: one.token, path: one.path });
      }
      toast(picked.length
        ? `Added ${picked.length} more from the same folder`
        : 'Nothing else in that folder', picked.length ? 'ok' : '');
    } catch (err) {
      toast(err.message, 'err');
    } finally {
      offering = false;
      offerFolder();
    }
  }

  async function onFile(file, fromBridge = false) {
    let bmp;
    try {
      bmp = await loadImage(file);
    } catch {
      toast(decodeErrorMessage(file), 'err');
      return;
    }
    editing = null;          // opened directly, not through the batch list
    showInEditor(bmp, file, fromBridge);
  }

  // Puts a decoded picture into the editor. Shared by "open a file" and
  // "edit this item of the batch", so both paths behave identically.
  function showInEditor(bmp, meta, fromBridge) {
    resetForImage(bmp, meta);
    edit.load(bmp);          // fresh editing session for this image
    // Dropped, pasted or browser-picked files have no path on disk, so the
    // replacement target is cleared (it is chosen inside the dialog).
    if (!fromBridge) bridge.clearFile();

    document.getElementById('fileInfo').innerHTML =
      `<strong>${escapeHtml(meta.name)}</strong><br>` +
      `${state.origW} × ${state.origH} px<br>` +
      `${(meta.size / 1024).toFixed(0)} KB`;
    document.getElementById('titleFile').textContent =
      `${meta.name} — ${state.origW}×${state.origH} px`;

    document.body.classList.add('has-image');
    document.getElementById('zoomSlider').value = 1;
    document.getElementById('zoomVal').textContent = '100%';

    refresh();
  }

  // The editor opened on a batch item: its path (if any) becomes the
  // replacement target, so Replace still overwrites the right file.
  async function adoptIntoEditor(bmp, item) {
    bridge.token = item.token || null;
    bridge.path = item.path || null;
    showInEditor(bmp, { name: item.name, size: item.size }, !!item.token);
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
        toast(`Downloaded ${filename} · ${sizeLabel(blob.size)} — could not get under ${N4DU.controls.limitLabel()}`, 'err');
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
    if (!document.getElementById('settingsModal').hidden) return;
    const k = e.key.toLowerCase();
    if (k === 'o') { e.preventDefault(); chooseFile(); return; }
    if (currentMode() === 'convert') return;   // the rest belong to the editor
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

  // ── Help ──────────────────────────────────────────────────────────
  function initHelp() {
    const modal = document.getElementById('helpModal');
    const show = () => { modal.hidden = false; };
    const hide = () => { modal.hidden = true; };
    document.getElementById('btnHelp').addEventListener('click', show);
    document.getElementById('btnHelpClose').addEventListener('click', hide);
    modal.addEventListener('click', e => { if (e.target === modal) hide(); });
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !modal.hidden) hide();
      // "?" opens help from anywhere outside a text field
      if (e.key === '?' && !/^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName)) show();
    });
  }

  initDropzone(onFiles, chooseFile);
  initEditorCanvas(refresh);
  initControls(refresh);
  initTools(refresh);
  initReplaceDialog(afterReplace);
  initHelp();
  N4DU.settings.initSettings();
  N4DU.batchUI.initBatchUI({ onAdd: chooseFile, onAddFolder: addFolder, onEdit: editItem });
  N4DU.windowSize.init();
  N4DU.webChrome.initWebChrome();
  edit.setOnChanged(() => { /* tools repaint explicitly to stay responsive */ });

  document.getElementById('btnExport').addEventListener('click', onDownload);
  document.getElementById('btnCopy').addEventListener('click', onCopy);
  document.getElementById('btnReplace').addEventListener('click', openReplaceDialog);
  document.getElementById('btnMode').addEventListener('click', () => {
    if (currentMode() === 'edit') returnToConverter();
    else editItem(batch.selectedId);
  });

  // ── Launched from the right-click menu ────────────────────────────
  // main.py puts ?open=TOKEN in the address when the app was started on a
  // specific file. The token stands for a path the server already holds, so
  // the picture arrives with its location attached and Replace works
  // immediately — no dialog, no Downloads folder.
  async function openStartupFile() {
    const token = new URLSearchParams(location.search).get('open');
    if (!token || !bridge.active) return;
    const picked = await bridge.adopt(token);
    if (picked) {
      await batch.add([picked.file], { token: picked.token, path: picked.path });
      offerFolder();
    } else {
      toast('That file could not be opened — it may have been moved.', 'err');
    }
  }

  // More files arriving while the window is already open: every image
  // right-clicked in one go lands in this same list.
  bridge.setOnPending(async (metas) => {
    const picked = await bridge.collect(metas);
    for (const one of picked) {
      await batch.add([one.file], { token: one.token, path: one.path });
    }
    if (picked.length) toast(`Added ${picked.length} file${picked.length > 1 ? 's' : ''} from your file explorer`, 'ok');
    offerFolder();
  });

  // The converter is the default. A returning user gets whichever mode they
  // left in, unless a file was handed over — that always means "convert".
  let startMode = 'convert';
  try { startMode = localStorage.getItem(MODE_KEY) || 'convert'; } catch { /* ignore */ }
  if (new URLSearchParams(location.search).get('open')) startMode = 'convert';
  setMode(startMode === 'edit' ? 'edit' : 'convert', { remember: false });

  bridge.init()
    .then(openStartupFile)
    .catch(() => {})
    .finally(() => { syncButtons(); N4DU.batchUI.syncBatch(); });
  syncButtons();

})(window.N4DU ??= {});
