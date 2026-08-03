// N4DU Studio — entry point. Loads the image and coordinates the modules.
// All processing runs in the browser; when main.pyw is running, the bridge
// adds the native open dialog and replacing files on disk.
(function (N4DU) {

  const { state, resetForImage, toast, bridge, edit, batch } = N4DU;
  const { loadImage, decodeErrorMessage } = N4DU.loader;
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
  // The picture currently open in the editor, as it arrived from disk.
  let openFile = null;

  // The name and size of what is being edited. Written once when the picture
  // opened and never again, so cropping a 300x200 photo to 180x120 left the
  // Result box saying "300 x 200 px" on one line and "120x180 px" on the
  // next, with the ORIGINAL file's weight underneath — three numbers, two of
  // them wrong, in the same sixty pixels.
  function syncFileInfo() {
    if (!openFile) return;
    const w = edit.ready() ? edit.width() : state.origW;
    const h = edit.ready() ? edit.height() : state.origH;
    document.getElementById('fileInfo').innerHTML =
      `<strong>${escapeHtml(openFile.name)}</strong><br>` +
      `${w} × ${h} px<br>` +
      `${(openFile.size / 1024).toFixed(0)} KB on disk`;
    document.getElementById('titleFile').textContent =
      `${openFile.name} — ${w}×${h} px`;
  }

  function refresh() {
    if (!state.img) return;
    syncFileInfo();
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
  function currentMode() {
    return document.body.classList.contains('mode-edit') ? 'edit' : 'convert';
  }

  // Help, Settings and the mode button, and where they live.
  //
  // In a window of its own the operating system draws its own grey strip
  // directly above ours, so the app's title bar is a second identical band
  // holding almost nothing. The converter does without it: these three move
  // down into the Files row, next to Add files and Clear, and the bar goes.
  //
  // The editor keeps its bar — Undo, Open, Copy, Replace and Download live
  // there and have nowhere else to go — so the three come back on the way in
  // and go down again on the way out.
  const CHROME_IDS = ['btnHelp', 'btnSettings', 'btnMode'];
  const chromeHome = new Map();      // where each one sat in the title bar

  function placeChrome() {
    if (!document.body.classList.contains('app-window')) return;
    const inConvert = currentMode() === 'convert';
    const head = document.querySelector('.conv-head');
    const actions = document.querySelector('.title-actions');
    // They travel as one. Dropped into the row loose, they are three separate
    // flex items, and when the row runs out of width it breaks BETWEEN them —
    // Help left on the first line with Settings and Editor stranded at the
    // start of the second. Inside a box of their own the row can only break
    // before all three.
    let group = head.querySelector('.head-chrome');
    if (!group) {
      group = document.createElement('span');
      group.className = 'head-chrome';
      head.appendChild(group);
    }
    group.hidden = currentMode() !== 'convert';
    // Back to front on the way in. Each one's marker is the button that
    // followed it, which is itself still down in the Files row — putting
    // them back in reading order asks to insert before something that is
    // not there yet, and insertBefore throws rather than guessing.
    const order = inConvert ? CHROME_IDS : [...CHROME_IDS].reverse();
    for (const id of order) {
      const el = document.getElementById(id);
      if (!el) continue;
      if (inConvert) { group.appendChild(el); continue; }
      const marker = chromeHome.get(id);
      // A null reference appends, which is right for whatever was last.
      actions.insertBefore(el, marker && marker.parentNode === actions ? marker : null);
    }
  }

  function setMode(mode) {
    const edit_ = mode === 'edit';
    document.body.classList.toggle('mode-edit', edit_);
    document.body.classList.toggle('mode-convert', !edit_);
    document.getElementById('modeLabel').textContent = edit_ ? 'Converter' : 'Editor';
    document.getElementById('btnMode').title = edit_
      ? 'Back to the converter'
      : 'Open the editor for the selected picture';
    placeChrome();
    if (edit_) refresh();
    else {
      N4DU.batchUI.syncBatch();
      // A picture may have appeared in the folder while the editor was open.
      // The news was noted rather than acted on then; this is the moment it
      // is worth anything.
      if (folderMovedOn) { folderMovedOn = false; offerFolder(); }
    }
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
    // Coming back to the picture you were already editing is a change of
    // view, not a new document. It used to re-decode and re-load, which
    // threw away every undo step — and worse, made Revert a lie: the batch
    // item now holds the EDITED bitmap, so "back to the picture you opened"
    // handed back the rotated, brushed version and there was no route to the
    // original left at all. One tap of the mode button was enough.
    if (editing === item.id && edit.ready()) {
      setMode('edit');
      return;
    }
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
  // Rounded corners and the square framing are export settings: they live in
  // `state` and were only ever applied inside renderOutput, at the moment a
  // file was written. So they reached Download, and nothing else. Round a
  // picture, go back to the converter, and the tile still showed square
  // corners — because the bitmap handed back was the raw surface — and
  // "Replace originals" wrote square corners over your file.
  //
  // Leaving the editor is the moment to settle it: the shape gets applied to
  // the pixels, as a real edit that Undo can take back off, and the settings
  // go back to neutral so a second visit cannot apply the same rounding twice.
  function bakeShape() {
    if (!edit.ready()) return;
    if (!(state.roundness > 0 || state.mode === 'crop')) return;
    const { W, H } = N4DU.render.contentSize(state);
    if (!W || !H) return;
    // No resizing here on purpose: outW/outH are the export's business, and
    // the converter has resize settings of its own to apply afterwards.
    if (edit.replaceWith(N4DU.render.renderOutput(state, W, H))) {
      // Neutral again, or a second visit would round the rounded corners.
      state.roundness = 0;
      state.mode = 'original';
      N4DU.syncToSurface(edit.width(), edit.height());
    }
  }

  function returnToConverter() {
    if (editing !== null && edit.ready()) {
      try {
        bakeShape();
        // Only when something was actually changed. Handing a bitmap back
        // after a look-and-leave visit pinned a full-size RGBA surface to
        // every file that had ever been opened — six 12 MP photos came to
        // about 290 MB — and switched conversion away from the original
        // bytes for no reason.
        if (edit.canUndo()) {
          const bmp = edit.toBitmap();
          if (bmp) batch.setEdited(editing, bmp);
        }
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
    const { added } = await addFromDisk(picked);
    announceAdded(added);
  }

  // Files from the bridge arrive one at a time because each carries its own
  // token and path, and batch.add takes one set of those for the whole call.
  //
  // The count has to be tallied rather than assumed. Every one of these
  // places used to report picked.length — the number of files ASKED for —
  // so right-clicking five images where two were corrupt said "Added 5
  // files" over a list holding three, and said nothing about the two.
  async function addFromDisk(picked) {
    // One call for the whole lot, with one piece of metadata per file.
    // Twenty separate calls meant the list finished loading twenty times,
    // and everything watching for "the batch has settled" acted on each of
    // them: opening a folder of twenty pictures resized the window twenty
    // times on its way to the right shape, and one of those resizes landing
    // late was enough for the window to decide the size had been set by
    // hand — after which it stayed compact, holding a list far too long
    // for it, with a scrollbar.
    const { added, failed } = await batch.add(
      picked.map(one => one.file),
      picked.map(one => ({ token: one.token, path: one.path })));
    if (failed.length) {
      toast(`${failed.length} file${failed.length > 1 ? 's' : ''} could not be read`, 'err');
    }
    return { added, failed };
  }

  // Files with no location: dropped, pasted, or chosen through the browser.
  async function onFiles(files) {
    if (currentMode() === 'edit') {
      await onFile(files[0], false);
      return;
    }
    const { added, failed, skipped, duplicates } = await batch.add(files);
    if (failed.length) toast(`${failed.length} file${failed.length > 1 ? 's' : ''} could not be read`, 'err');
    else if (skipped) toast(`List is full at ${batch.MAX_ITEMS} files — ${skipped} left out`, 'err');
    // Say so, rather than appearing to do nothing: a file already in the list
    // is silently dropped, and without this the drop had no visible effect.
    else if (!added && duplicates) {
      toast(duplicates > 1 ? `Those ${duplicates} files are already in the list`
                           : 'That file is already in the list', '');
    } else announceAdded(added);
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
  let asking = false;      // an offerFolder() already in flight

  async function offerFolder() {
    if (!bridge.active || offering || asking) return;
    const anchor = batch.items.find(it => it.token);
    if (!anchor) { N4DU.batchUI.setFolderOffer(0, ''); return; }
    asking = true;
    try {
      const have = batch.items.map(it => it.path).filter(Boolean);
      const { folder, metas } = await bridge.siblings(anchor.token, have);
      N4DU.batchUI.setFolderOffer(metas.length, folder.split(/[\\/]/).pop());
    } catch {
      N4DU.batchUI.setFolderOffer(0, '');
    } finally {
      asking = false;
    }
  }

  // Being told, rather than looking.
  //
  // Pictures appear next to the one you opened while the program is running,
  // and nothing in a browser can see that. Asking every few seconds would
  // catch it, and would also spend work for ever on something that almost
  // never happens — and still be late by up to however long the gap is.
  //
  // So the operating system is asked to say something instead. watchdir.py
  // parks a thread in the kernel where it costs nothing until there is news;
  // the heartbeat that already runs every second carries the news home. No
  // new timer, no new connection, and the disk is never read to find out.
  let folderMovedOn = false;      // news that arrived while looking elsewhere

  bridge.setOnFolderChanged(() => {
    if (currentMode() === 'convert') offerFolder();
    else folderMovedOn = true;    // picked up on the way back, below
  });

  // Coming back to the window is worth a look whatever happens, and it is
  // not a timer: you have almost certainly just been in the folder putting
  // something there. It is also the whole answer on a system where none of
  // the three watchers exists — bridge.watching says so — which is why there
  // is no button to press and no clock running in that case either.
  const lookAgain = () => {
    if (!document.hidden && bridge.active && currentMode() === 'convert') offerFolder();
  };
  document.addEventListener('visibilitychange', lookAgain);
  window.addEventListener('focus', lookAgain);

  async function addFolder() {
    const anchor = batch.items.find(it => it.token);
    if (!anchor || offering) return;
    offering = true;
    try {
      const have = batch.items.map(it => it.path).filter(Boolean);
      const { metas } = await bridge.siblings(anchor.token, have);
      const picked = await bridge.collect(metas);
      const { added, failed } = await addFromDisk(picked);
      if (!failed.length) {
        toast(added
          ? `Added ${added} more from the same folder`
          : 'Nothing else in that folder', added ? 'ok' : '');
      }
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
    // Give it a place in the list before opening it. A picture opened
    // straight into the editor — dropped, pasted, Ctrl+O — used to belong to
    // nothing, so pressing Converter threw both the picture and every edit
    // made to it away without a word, and the batch went on converting the
    // file that was there before.
    const meta = fromBridge ? { token: bridge.token, path: bridge.path } : {};
    const known = new Set(batch.items.map(it => it.id));
    // The picture is already decoded, so hand it over rather than making the
    // list read the same file off disk all over again.
    await batch.add([file], { ...meta, decoded: bmp });
    const fresh = batch.items.find(it => !known.has(it.id));
    const home = fresh || (meta.path && batch.items.find(it => it.path === meta.path));
    if (home) {
      batch.select(home.id);
      editing = home.id;
    } else {
      editing = null;       // the list is full; the editor still opens
      toast(`List is full at ${batch.MAX_ITEMS} files — this one is not in it`, 'err');
    }
    showInEditor(bmp, file, fromBridge);
  }

  // Puts a decoded picture into the editor. Shared by "open a file" and
  // "edit this item of the batch", so both paths behave identically.
  function showInEditor(bmp, meta, fromBridge) {
    resetForImage(bmp, meta);
    edit.load(bmp);          // fresh editing session for this image
    // And a fresh crop box, which means none. The selection lives in
    // editor-canvas.js and survived a new picture being opened, still
    // holding the last one's coordinates: open something smaller and the
    // stale box fell entirely outside it, so the dimming covered the whole
    // photo and a yellow rectangle floated over nothing. There was no way
    // to clear it either — Reset stays disabled for a box bigger than the
    // picture, and the crop panel is hidden while the tool is Move.
    N4DU.editorCanvas.setSelection(null);
    // Dropped, pasted or browser-picked files have no path on disk, so the
    // replacement target is cleared (it is chosen inside the dialog).
    if (!fromBridge) bridge.clearFile();

    openFile = meta;
    syncFileInfo();

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
  // ── Taking the result away ────────────────────────────────────────
  // Download and Copy live in js/ui/deliver.js: two buttons, one job, and
  // nothing else in here depends on how either of them works.
  const { onDownload, onCopy } = N4DU.deliver;
  // deliver.js repaints the buttons when it has finished, through a function
  // it expects to be handed. Nobody ever handed it one, so the call in both
  // of its finally blocks did nothing at all.
  N4DU.deliver.setSyncButtons(() => syncButtons());

  // ── Buttons ───────────────────────────────────────────────────────
  // Replace is always visible: in browser-only mode it stays enabled but
  // opens the dialog locked, so the feature explains itself instead of
  // disappearing.
  function syncButtons() {
    const hasImage = !!state.img;
    document.getElementById('btnExport').disabled = !hasImage;
    document.getElementById('btnCopy').disabled = !hasImage;

    // Without the bridge, what is missing is the reason to download it.
    const sell = document.getElementById('statusSell');
    if (sell) sell.hidden = bridge.active;

    // And the offer to leave the tab behind. Only where it is both possible
    // and useful: not with the bridge running (that window is already its
    // own), and not inside the window this button opened.
    const pop = document.getElementById('btnPopWindow');
    if (pop) pop.hidden = bridge.active || inOwnWindow();

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
    // The list has to follow the file. Replacing a.png with a.jpg from the
    // editor renames it on disk, and the tile behind the editor went on
    // saying "a.png" and pointing at a path that no longer exists — so did
    // the folder offer, which uses the paths already in the list to work out
    // what else is in the folder. The token itself stays good: the server
    // retargets it to the new path as part of the replacement.
    const item = batch.items.find(it => it.id === editing);
    if (item && out.name) {
      item.name = out.name;
      if (out.path) item.path = out.path;
      N4DU.batchUI.syncBatch();
    }
    syncButtons();
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  // ── Keyboard shortcuts ────────────────────────────────────────────
  // Which key means what lives in js/ui/shortcuts.js; what each one does
  // lives here. Handed over rather than reached for.
  N4DU.shortcuts.initShortcuts({
    chooseFile, currentMode, onDownload, onCopy, openReplaceDialog,
  });

  // ── A window of its own, and the sheet that explains it ───────────
  const { inOwnWindow, openInOwnWindow, showWindowNotice } = N4DU.launchNotice;
  const { initHelp } = N4DU.help;

  initDropzone(onFiles, chooseFile);
  initEditorCanvas(refresh);
  initControls(refresh);
  initTools(refresh);
  initReplaceDialog(afterReplace);
  initHelp();
  document.getElementById('btnPopWindow').addEventListener('click', openInOwnWindow);
  N4DU.settings.initSettings();
  N4DU.batchUI.initBatchUI({
    onAdd: chooseFile, onAddFolder: addFolder, onEdit: editItem,
    // A run that replaced files renamed them; the folder offer counts
    // by path and has to be asked again.
    onRunDone: (info) => { if (info && info.replaced) offerFolder(); },
  });

  // The editor must not outlive the file it is showing.
  //
  // Removing that file from the list — or clearing the list — left the
  // editor holding a picture that belonged to nothing: the title bar still
  // named it, the stage still drew it, Download still saved it, and
  // pressing Converter handed the edits back to an item that no longer
  // existed, so they vanished without a word.
  const paintBatch = N4DU.batchUI.syncBatch;
  batch.setOnChange(() => {
    paintBatch();
    const gone = editing !== null && !batch.items.some(it => it.id === editing);
    if (gone && currentMode() === 'edit') {
      editing = null;                 // nothing to hand anything back to
      returnToConverter();
      toast('That picture is no longer in the list', '');
    } else if (gone) {
      editing = null;
    }
    // With an empty list nothing is open, whatever was open before.
    if (!batch.items.length) document.body.classList.remove('has-image');
  });

  N4DU.windowSize.init();
  showWindowNotice();
  edit.setOnChanged(() => { /* tools repaint explicitly to stay responsive */ });

  document.getElementById('btnExport').addEventListener('click', onDownload);
  document.getElementById('btnCopy').addEventListener('click', onCopy);
  document.getElementById('btnReplace').addEventListener('click', openReplaceDialog);
  document.getElementById('btnMode').addEventListener('click', () => {
    if (currentMode() === 'edit') returnToConverter();
    else editItem(batch.selectedId);
  });

  // ── Launched from the right-click menu ────────────────────────────
  // main.pyw puts ?open=TOKEN in the address when the app was started on a
  // specific file. The token stands for a path the server already holds, so
  // the picture arrives with its location attached and Replace works
  // immediately — no dialog, no Downloads folder.
  async function openStartupFile() {
    const token = new URLSearchParams(location.search).get('open');
    if (!token || !bridge.active) return;
    const picked = await bridge.adopt(token);
    if (picked) {
      const { added } = await addFromDisk([picked]);
      // Right-clicking a file whose bytes are damaged opened the program on
      // an empty list with nothing said. addFromDisk reports the failure;
      // the folder offer is only worth making when something did arrive.
      if (added) offerFolder();
    } else {
      toast('That file could not be opened — it may have been moved.', 'err');
    }
  }

  // More files arriving while the window is already open: every image
  // right-clicked in one go lands in this same list.
  // The helper stopping is a change the interface has to show: what only it
  // can do goes back to being locked, and the reason is said out loud
  // rather than waiting to surface as "Failed to fetch".
  bridge.setOnStateChange(() => {
    if (!bridge.active) toast('The desktop helper stopped — replacing files is off', 'err');
    else toast('The desktop helper is back', 'ok');
    syncButtons();
    N4DU.batchUI.syncBatch();
  });

  bridge.setOnPending(async (metas) => {
    const picked = await bridge.collect(metas);
    const { added, failed } = await addFromDisk(picked);
    if (added && !failed.length) {
      toast(`Added ${added} file${added > 1 ? 's' : ''} from your file explorer`, 'ok');
    }
    offerFolder();
  });

  // In a window of its own the operating system already puts "N4DU Studio"
  // in the title bar above us, so the interface says it once instead of
  // twice — and the height that frees up goes to the work area.
  if (new URLSearchParams(location.search).get('app') === '1') {
    // Noted before anything moves, so the editor can put them back exactly
    // where they were rather than in whatever order they came out.
    for (const id of CHROME_IDS) {
      const el = document.getElementById(id);
      if (el) chromeHome.set(id, el.nextElementSibling);
    }
    document.body.classList.add('app-window');
  }

  // Always the converter, every launch. Reopening in the editor because that
  // is where you happened to be last time is wrong when the app has just
  // been handed a fresh batch of files — which is how it is usually opened.
  setMode('convert');

  // The door every file from the disk comes through: the startup queue, a
  // right-click, the folder offer. Exposed because it is the only way to
  // exercise "a folder of twenty pictures just arrived" without a file
  // explorer, and that is a thing worth being able to test.
  N4DU.addFromDisk = addFromDisk;

  bridge.init()
    .then(openStartupFile)
    // The tab that pressed Window is waiting to hand its work across, and
    // closing itself as soon as it has. Taken here, after the bridge has
    // had its say, because a window opened by a tab never has one.
    .then(() => N4DU.handover.claim({ onEdit: editItem }))
    .catch(() => {})
    .finally(() => {
      syncButtons();
      N4DU.batchUI.syncBatch();
    });
  syncButtons();

})(window.N4DU ??= {});
