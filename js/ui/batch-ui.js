// The converter: the view N4DU Studio opens in.
//
// A list of files, three settings, two buttons. Everything a batch needs and
// nothing it does not — the editor lives behind the mode button.
(function (N4DU) {

  const { batch, bridge, toast } = N4DU;
  const { FORMATS, detectEncodeSupport } = N4DU.exporter;
  const { convert, targetSize, RESIZE_MODES } = N4DU.convert;

  const $ = (id) => document.getElementById(id);
  const STORE = 'n4du.convert';

  // What the whole view is driven by. Kept apart from the editor's state:
  // these settings apply to every file, not to one open picture.
  // "Keep" is not a format, it is the absence of one: every file comes out
  // in the format it went in as. It is the default because the usual reason
  // to open a folder of pictures is to make them smaller or resize them —
  // turning a PNG into a JPG on the way is the last thing wanted, and having
  // to notice and undo it is the kind of thing you only spot afterwards.
  const KEEP = 'keep';

  // What each source extension is written back as.
  const EXT_TO_FMT = {
    png: 'png', jpg: 'jpeg', jpeg: 'jpeg', jfif: 'jpeg', webp: 'webp',
    avif: 'avif', bmp: 'bmp', ico: 'ico', tif: 'tiff', tiff: 'tiff',
  };

  const opts = {
    fmt: KEEP,
    quality: 0.92,
    maxKb: null,
    maxUnit: 'KB',
    resize: { mode: 'keep', value: 1920 },
    // Where the converted files go: 'zip', 'separate', or 'folder' — one
    // archive, one download each, or written straight into a folder you
    // choose. The last one only exists with the desktop helper running,
    // because only it can open a folder dialog and write to disk.
    deliver: 'zip',
    destToken: null,      // a receipt for the folder, never a path
    destName: '',         // just its name, for the line under the buttons
    destMove: false,      // delete the original once the new one is down
    destOverwrite: false, // replace a file already called that
  };

  // The real output format for one file. Anything we cannot write back —
  // a GIF, an SVG, an unknown extension — becomes PNG, which can hold
  // whatever the browser managed to decode.
  function fmtFor(item) {
    if (opts.fmt !== KEEP) return opts.fmt;
    const ext = String(item?.name || '').split('.').pop().toLowerCase();
    const guess = EXT_TO_FMT[ext];
    return guess && (!support || support[guess]) ? guess : 'png';
  }

  // The options passed to convert() for one file.
  const optsFor = item => ({ ...opts, fmt: fmtFor(item) });

  let support = null;        // which formats this browser can really write
  let onEditRequest = () => {};
  let onRunDone = () => {};

  // How many more images sit in the folder of the file that is open, and
  // what that folder is called. Filled in by main.js after asking the bridge.
  let folderCount = 0;
  let folderName = '';

  function setFolderOffer(count, name) {
    folderCount = count;
    folderName = name;
    syncBatch();
  }

  // ── Setup ─────────────────────────────────────────────────────────
  function initBatchUI(hooks = {}) {
    onEditRequest = hooks.onEdit || (() => {});
    onRunDone = hooks.onRunDone || (() => {});
    restore();
    buildFormats();
    buildResizeModes();

    $('btnAddFiles').addEventListener('click', () => hooks.onAdd());
    $('btnAddFolder').addEventListener('click', () => hooks.onAddFolder());
    $('btnClearFiles').addEventListener('click', () => {
      batch.clear();
      toast('List cleared', '');
    });

    $('resizeMode').addEventListener('change', e => {
      const was = RESIZE_MODES[opts.resize.mode];
      opts.resize.mode = e.target.value;
      const now = RESIZE_MODES[opts.resize.mode];
      // The number means something different in each mode. Switching from
      // "longest side 1920 px" to Scale kept the 1920 and read it as 1920 %:
      // one click on a dropdown turned a 1200x900 photo into a 9622x8313,
      // 16 MB one. When the unit changes, so does the number.
      if (now.unit && was.unit !== now.unit) {
        opts.resize.value = now.unit === '%' ? 100 : 1920;
        $('resizeValue').value = opts.resize.value;
      }
      changed();
    });
    $('resizeValue').addEventListener('input', e => {
      const n = parseInt(e.target.value, 10);
      if (Number.isFinite(n)) opts.resize.value = Math.max(1, Math.min(20000, n));
      changed();
    });
    // Typing -5 left -5 in the box while the app quietly used 1, and 999999
    // stayed on screen while the app used 20000. Clamping without ever
    // saying so means the number you can read is not the number in force.
    $('resizeValue').addEventListener('blur', () => {
      $('resizeValue').value = opts.resize.value;
    });
    $('batchQuality').addEventListener('input', e => {
      opts.quality = Math.max(1, Math.min(100, parseInt(e.target.value, 10) || 92)) / 100;
      changed();
    });
    $('batchMaxSize').addEventListener('input', () => { opts.maxKb = readLimit(); changed(); });
    $('batchMaxUnit').addEventListener('change', () => {
      // Only the unit changes, never the stored limit: converting the
      // rounded display back would drift the real value.
      opts.maxUnit = $('batchMaxUnit').value;
      if (opts.maxKb) {
        $('batchMaxSize').value = opts.maxUnit === 'MB'
          ? parseFloat((opts.maxKb / 1024).toFixed(3))
          : Math.round(opts.maxKb);
      }
      changed();
    });
    $('batchDest').addEventListener('click', e => {
      const pill = e.target.closest('.pill');
      if (!pill) return;
      opts.deliver = pill.dataset.dest;
      save();
      // The Convert button names what it is about to hand you. Changing
      // where things go and leaving the button describing the old answer is
      // how you end up with a zip you did not ask for.
      syncBatch();
    });
    $('btnPickDest').addEventListener('click', chooseDestination);
    $('destMove').addEventListener('change', e => {
      opts.destMove = e.target.checked; save(); syncBatch();
    });
    $('destOverwrite').addEventListener('change', e => {
      opts.destOverwrite = e.target.checked; save(); syncBatch();
    });

    $('btnConvertAll').addEventListener('click', () => run(false));
    $('btnReplaceAll').addEventListener('click', () => run(true));

    detectEncodeSupport().then(found => {
      support = found;
      buildFormats();
      syncBatch();
    });

    batch.setOnChange(syncBatch);
    syncBatch();
  }

  async function chooseDestination() {
    if (!bridge.active) { toast('Choosing a folder needs the desktop version', 'err'); return; }
    try {
      const picked = await bridge.pickDestination();
      if (!picked) return;                       // cancelled, and that is fine
      opts.destToken = picked.token;
      opts.destName = picked.name || picked.folder;
      save();
      syncBatch();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  function readLimit() {
    const raw = parseFloat($('batchMaxSize').value);
    if (!Number.isFinite(raw) || raw <= 0) return null;
    return Math.max(1, Math.round(raw * ($('batchMaxUnit').value === 'MB' ? 1024 : 1)));
  }

  // A settings change invalidates every result already computed.
  function changed() {
    batch.resetResults();
    save();
    syncBatch();
  }

  // ── Remembering the settings ──────────────────────────────────────
  // A converter that forgets its format every launch is a converter you
  // stop using. localStorage is unavailable in some file:// contexts, so
  // every access is guarded.
  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify({
        fmt: opts.fmt, quality: opts.quality, maxKb: opts.maxKb,
        maxUnit: opts.maxUnit, resize: opts.resize,
        // The folder token is deliberately not kept: it is a receipt from
        // this run of the helper and means nothing to the next one.
        deliver: opts.deliver, destMove: opts.destMove,
        destOverwrite: opts.destOverwrite,
      }));
    } catch { /* private mode, or file:// — the app works without it */ }
  }

  function restore() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { /* ignore */ }
    if (saved && typeof saved === 'object') {
      if (saved.fmt === KEEP || FORMATS[saved.fmt]) opts.fmt = saved.fmt;
      if (saved.quality > 0 && saved.quality <= 1) opts.quality = saved.quality;
      if (saved.maxKb === null || saved.maxKb > 0) opts.maxKb = saved.maxKb ?? null;
      if (saved.maxUnit === 'MB' || saved.maxUnit === 'KB') opts.maxUnit = saved.maxUnit;
      if (saved.resize && RESIZE_MODES[saved.resize.mode]) {
        opts.resize = { mode: saved.resize.mode, value: Number(saved.resize.value) || 1920 };
      }
      // 'separate' was a checkbox before there were three places to send
      // things. A setting saved by the old version still means what it said.
      if (['zip', 'separate', 'folder'].includes(saved.deliver)) opts.deliver = saved.deliver;
      else if (saved.separate) opts.deliver = 'separate';
      opts.destMove = !!saved.destMove;
      opts.destOverwrite = !!saved.destOverwrite;
    }
    $('batchQuality').value = Math.round(opts.quality * 100);
    $('batchMaxUnit').value = opts.maxUnit;
    $('destMove').checked = opts.destMove;
    $('destOverwrite').checked = opts.destOverwrite;
    if (opts.maxKb) {
      $('batchMaxSize').value = opts.maxUnit === 'MB'
        ? parseFloat((opts.maxKb / 1024).toFixed(3))
        : opts.maxKb;
    }
    $('resizeValue').value = opts.resize.value;
  }

  // ── Controls ──────────────────────────────────────────────────────
  // Unsupported formats stay on screen rather than disappearing. Silently
  // hiding AVIF tells you nothing; saying "this browser cannot write it"
  // tells you to open the desktop launcher or another browser.
  function buildFormats() {
    const box = $('batchFmt');
    box.innerHTML = '';

    const keep = document.createElement('button');
    keep.className = 'pill';
    keep.dataset.fmt = KEEP;
    keep.textContent = 'Keep';
    keep.title = 'Each file stays in the format it already is';
    keep.classList.toggle('active', opts.fmt === KEEP);
    keep.addEventListener('click', () => { opts.fmt = KEEP; changed(); });
    box.appendChild(keep);

    for (const [key, f] of Object.entries(FORMATS)) {
      const btn = document.createElement('button');
      btn.className = 'pill';
      btn.dataset.fmt = key;
      btn.textContent = f.label;
      const usable = !support || support[key];
      btn.classList.toggle('unsupported', !usable);
      btn.classList.toggle('active', key === opts.fmt);
      btn.title = usable
        ? `${f.label} — ${f.lossy ? 'lossy' : 'lossless'}${f.alpha ? ', keeps transparency' : ', no transparency'}`
        : `${f.label} cannot be written by this browser`;
      btn.addEventListener('click', () => {
        opts.fmt = key;
        changed();
      });
      box.appendChild(btn);
    }
  }

  function buildResizeModes() {
    const sel = $('resizeMode');
    sel.innerHTML = '';
    for (const [key, mode] of Object.entries(RESIZE_MODES)) {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = mode.label;
      sel.appendChild(opt);
    }
    sel.value = opts.resize.mode;
  }

  // ── Painting the view ─────────────────────────────────────────────
  function syncBatch() {
    const totals = batch.totals();
    const keeping = opts.fmt === KEEP;
    // With "Keep" there is no single format to describe or to check: each
    // file answers for itself, and anything unwritable falls back to PNG.
    const f = keeping ? null : FORMATS[opts.fmt];
    const usable = keeping || !support || support[opts.fmt];

    document.querySelectorAll('#batchFmt .pill').forEach(p =>
      p.classList.toggle('active', p.dataset.fmt === opts.fmt));

    // "Keep" cannot always keep. A GIF loses its animation, an SVG stops
    // being a drawing that scales, and an unknown extension has no writer at
    // all — every one of them quietly came out as a PNG. Saying so is the
    // difference between a sensible fallback and a file you did not ask for.
    const recoded = keeping
      ? [...new Set(batch.items
          .filter(it => fmtFor(it) === 'png' && !/\.png$/i.test(it.name || ''))
          .map(it => (String(it.name || '').split('.').pop() || '?').toUpperCase()))]
      : [];
    $('fmtWarning').hidden = usable && !recoded.length;
    if (!usable) {
      $('fmtWarning').textContent =
        `This browser cannot write ${f.label}. Nothing would be converted, ` +
        'so pick another format (Chrome and Edge write the most).';
    } else if (recoded.length) {
      const list = recoded.slice(0, 3).join(', ');
      $('fmtWarning').textContent =
        `${list} cannot be written back, so ${recoded.length > 1 ? 'those files' : 'that file'}`
        + ' will come out as PNG. Animation and vector drawings are not kept.';
    }

    // Keeping formats can mean a mix, so ask the files rather than the
    // setting: the slider appears when at least one of them will come out in
    // a lossy format, and stays out of the way the rest of the time.
    const lossy = keeping
      ? batch.items.some(it => FORMATS[fmtFor(it)].lossy)
      : f.lossy;
    $('qualityRowBatch').style.display = lossy ? '' : 'none';
    $('batchQualityVal').textContent = Math.round(opts.quality * 100);
    $('resizeMode').value = opts.resize.mode;
    const mode = RESIZE_MODES[opts.resize.mode];
    $('resizeValue').style.display = opts.resize.mode === 'keep' ? 'none' : '';
    $('resizeUnit').textContent = mode.unit;
    $('resizeUnit').style.display = mode.unit ? '' : 'none';
    // One number, never two: hovering says which side it is and why the
    // other one is not asked for.
    $('resizeMode').title = mode.hint;
    $('resizeValue').title = mode.hint;

    $('filesTitle').textContent = totals.count ? `Files (${totals.count})` : 'Files';
    $('filesSummary').textContent = totals.count
      ? `${sizeLabel(totals.bytes)} total${totals.replaceable ? `, ${totals.replaceable} on disk` : ''}`
      : 'nothing loaded';
    $('btnClearFiles').disabled = !totals.count || working();

    // "Add the rest of this folder" appears as soon as one file arrives from
    // disk. How many files a right-click hands over is Windows's decision,
    // not ours — this makes the whole folder one click away either way.
    const folderBtn = $('btnAddFolder');
    folderBtn.hidden = !(bridge.active && folderCount > 0 && !working());
    // The long wording is the widest thing in this row by some way, and in
    // the launcher's small window it is what pushed everything else off the
    // edge. There it says just "+ 5 more"; the folder's name was always in
    // the tooltip anyway.
    const roomy = !document.body.classList.contains('app-window');
    folderBtn.textContent = roomy
      ? `+ ${folderCount} more in this folder`
      : `+ ${folderCount} more`;
    folderBtn.title = folderName
      ? `Add the other images in ${folderName}`
      : 'Add the other images from the same folder';
    $('convertDrop').hidden = totals.count > 0;
    // With no files the panel has nothing to grow for, and letting it stretch
    // dragged the drop zone into a huge empty rectangle on a full-size tab.
    document.body.classList.toggle('no-files', totals.count === 0);
    $('convertDropHint').textContent = bridge.active
      ? 'Or right-click images in your file explorer and choose N4DU Studio.'
      : '';

    renderGrid();

    // Nothing may start while files are still arriving. Pressing Convert
    // with 147 of 200 cards built produced a zip of 147 and then said
    // "Converted 158 of 158 files" — a true-sounding sentence about a job
    // it had silently made smaller.
    const ready = totals.count > 0 && usable && !working() && !batch.loading();
    // Converting straight into a folder needs the folder first. Starting
    // anyway and asking at the end would mean converting fifty files to
    // find out the answer is "cancel".
    const addressed = opts.deliver !== 'folder' || !!opts.destToken;
    $('btnConvertAll').disabled = !ready || !addressed;
    $('btnConvertAll').title = addressed ? '' : 'Choose the folder to write into first';
    $('btnConvertAll').innerHTML = buttonLabel(totals);

    const rep = $('btnReplaceAll');
    rep.disabled = !ready || (bridge.active && totals.replaceable === 0);
    rep.classList.toggle('locked', !bridge.active);
    rep.title = bridge.active
      ? (totals.replaceable
        ? `Overwrite ${totals.replaceable} file${totals.replaceable > 1 ? 's' : ''} where they already are`
        : 'None of these files came from your disk, so there is nothing to overwrite')
      : 'Overwriting files needs the desktop version';

    syncDestination(totals);

    updateEstimate();
    // The window follows the batch: one file needs far less room than forty.
    if (N4DU.windowSize) N4DU.windowSize.fit();
  }

  function buttonLabel(totals) {
    if (opts.deliver === 'folder') {
      const where = opts.destName ? ` into ${opts.destName}` : ' into a folder';
      return `<svg class="bi"><use href="#i-down"/></svg> Convert &amp; save${where}`;
    }
    const many = totals.count > 1 && opts.deliver !== 'separate';
    const what = many ? 'Convert &amp; download .zip' : 'Convert &amp; download';
    return `<svg class="bi"><use href="#i-down"/></svg> ${what}`;
  }

  // Where the files go, and which questions about that are worth asking.
  //
  // Both extra options are about a file landing on your disk under a name we
  // chose, which only happens on the "into a folder" route: a browser
  // download cannot overwrite anything (it invents «foto (2).png» and does
  // not tell us) and cannot confirm it arrived, so offering to delete the
  // original alongside it would be offering to lose the picture. So the
  // panel belongs to that one mode — and inside it, Move is only offered
  // when there is an original to move, which is not true of a pasted or
  // dragged-from-the-web image that never had a path.
  function syncDestination(totals) {
    const pills = $('batchDest');
    // Writing into a folder is the helper's job. In a plain tab the option
    // is not disabled-looking, it is absent: there is nothing to explain.
    for (const pill of pills.querySelectorAll('.pill')) {
      if (pill.dataset.dest === 'folder') pill.hidden = !bridge.active;
    }
    // A setting remembered from a desktop session, reopened in a tab.
    if (opts.deliver === 'folder' && !bridge.active) { opts.deliver = 'zip'; save(); }
    for (const pill of pills.querySelectorAll('.pill')) {
      const on = pill.dataset.dest === opts.deliver;
      pill.classList.toggle('active', on);
      pill.setAttribute('aria-checked', on ? 'true' : 'false');
    }

    const folder = opts.deliver === 'folder';
    $('destOptions').hidden = !folder;
    if (!folder) return;

    $('destPath').textContent = opts.destName || 'no folder chosen yet';
    $('destPath').classList.toggle('warn', !opts.destToken);
    $('btnPickDest').textContent = opts.destToken ? 'Change folder…' : 'Choose folder…';
    $('btnPickDest').disabled = working();

    // Nothing to move when nothing came from disk.
    const movable = totals.replaceable > 0;
    $('destMove').closest('.check').hidden = !movable;
    $('destMove').disabled = !movable || working();
    $('destOverwrite').disabled = working();
  }

  // The file list. Each tile is the picture, its name, and what happened to
  // it — so a failure in file 34 of 50 is visible rather than buried.
  function renderGrid() {
    const grid = $('fileGrid');
    grid.innerHTML = '';
    for (const item of batch.items) {
      const tile = document.createElement('button');
      tile.className = 'file-tile';
      tile.classList.toggle('selected', item.id === batch.selectedId);
      tile.classList.add('st-' + item.status);
      tile.title = `${item.name}\n${item.w}×${item.h} px · ${sizeLabel(item.size)}` +
                   (item.path ? `\n${item.path}` : '\nnot on disk — cannot be overwritten');

      const canvas = document.createElement('canvas');
      canvas.className = 'file-thumb';
      canvas.width = 96;
      canvas.height = 96;
      drawThumbInto(canvas, item.thumb);
      tile.appendChild(canvas);

      const name = document.createElement('span');
      name.className = 'file-tile-name';
      name.textContent = item.name;
      tile.appendChild(name);

      const meta = document.createElement('span');
      meta.className = 'file-tile-meta';
      meta.textContent = itemMeta(item);
      tile.appendChild(meta);

      if (item.token) {
        const dot = document.createElement('span');
        dot.className = 'file-tile-disk';
        dot.textContent = '●';
        dot.title = 'On your disk — can be overwritten in place';
        tile.appendChild(dot);
      }

      const kill = document.createElement('span');
      kill.className = 'file-tile-x';
      kill.textContent = '×';
      kill.title = 'Remove from the list (or press Delete)';
      kill.addEventListener('click', e => {
        e.stopPropagation();
        if (!working()) batch.remove(item.id);
      });
      tile.appendChild(kill);

      tile.addEventListener('click', () => batch.select(item.id));
      // The x cannot be a button: it lives inside one, and a button inside a
      // button is not valid HTML. So the tile itself answers Delete, which
      // is the only route a keyboard user had to remove ONE file — the
      // alternative on screen was Clear, which removes all of them.
      tile.addEventListener('keydown', e => {
        if (e.key !== 'Delete' && e.key !== 'Backspace') return;
        e.preventDefault();
        if (!working()) batch.remove(item.id);
      });
      tile.addEventListener('dblclick', () => onEditRequest(item.id));
      grid.appendChild(tile);
    }
  }

  function itemMeta(item) {
    if (item.status === 'error') return item.error || 'failed';
    if (item.status === 'working') return 'working…';
    if (item.status === 'done' && item.result) {
      const over = item.result.limit && !item.result.limit.ok;
      return `${item.result.W}×${item.result.H} · ${sizeLabel(item.result.blob.size)}` +
             (over ? ' · over cap' : '');
    }
    // Before anything is converted the card can only report what came in.
    // That is fine until a size is set, at which point every card still said
    // 4000×3000 and nothing on screen said what would actually come out —
    // the one number the estimate below the list cannot give per file.
    const source = `${item.w}×${item.h} · ${sizeLabel(item.size)}`;
    if (opts.resize.mode === 'keep' || !item.w || !item.h) return source;
    const t = targetSize(item.w, item.h, opts.resize, fmtFor(item));
    if (t.W === item.w && t.H === item.h) return source;
    return `${item.w}×${item.h} → ${t.W}×${t.H} · ${sizeLabel(item.size)}`;
  }

  function drawThumbInto(canvas, thumb) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!thumb) return;
    const s = Math.min(canvas.width / thumb.width, canvas.height / thumb.height);
    const w = thumb.width * s, h = thumb.height * s;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(thumb, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  }

  // ── The estimate ──────────────────────────────────────────────────
  // Computed by really converting the selected file, then scaled by the
  // number of files. Labelled as an estimate, because that is what it is:
  // the other files compress differently.
  let estimateTimer = null;
  let estimateSeq = 0;

  function updateEstimate() {
    const el = $('batchEstimate');
    const item = batch.selected();
    const totals = batch.totals();

    if (working()) return;
    if (!item) { el.textContent = 'Add some files to begin.'; el.classList.remove('warn'); return; }
    if (opts.fmt !== KEEP && support && !support[opts.fmt]) { el.textContent = '—'; return; }

    // Once a batch has run, show what actually happened instead of a guess.
    if (totals.done && totals.done + totals.failed >= totals.count) {
      el.classList.toggle('warn', totals.failed > 0);
      el.textContent = `${totals.done} converted · ${sizeLabel(totals.resultBytes)}` +
        (totals.failed ? ` · ${totals.failed} failed` : '') +
        ` (was ${sizeLabel(totals.bytes)})`;
      return;
    }

    const itemOpts = optsFor(item);
    const { W, H } = targetSize(item.w, item.h, itemOpts.resize, itemOpts.fmt);
    el.textContent = `Calculating… → ${W}×${H} ${FORMATS[itemOpts.fmt].label}`;
    el.classList.remove('warn');
    clearTimeout(estimateTimer);
    const seq = ++estimateSeq;
    estimateTimer = setTimeout(async () => {
      let handle = null;
      try {
        handle = await batch.decodeCached(item);
        const out = await convert(handle.bmp, itemOpts);
        if (seq !== estimateSeq) return;    // a newer estimate is running
        const each = sizeLabel(out.blob.size);
        // Scaled by BYTES, not by count. Multiplying the selected file's
        // output by the number of files made the total swing forty-fold
        // depending on which tile happened to be selected — the same five
        // files read "about 17 KB" or "about 0.4 KB" with nothing on screen
        // admitting the figure was anchored to one of them. The ratio this
        // file achieved, applied to what the whole list weighs, is at least
        // an honest guess.
        const ratio = item.size > 0 ? out.blob.size / item.size : 1;
        const all = totals.count > 1
          ? ` · about ${sizeLabel(Math.round(totals.bytes * ratio))} for ${totals.count} files`
          : '';
        if (out.limit && !out.limit.ok) {
          el.textContent = `${out.W}×${out.H} · ${each} — cannot get under ${limitLabel()}`;
          el.classList.add('warn');
        } else {
          el.textContent = `${out.W}×${out.H} ${FORMATS[itemOpts.fmt].label} · ${each}${all}`;
        }
      } catch (err) {
        if (seq === estimateSeq) el.textContent = 'Could not read that file: ' + err.message;
      } finally {
        // Not optional: the cache hands out a counted reference, and without
        // this the bitmap it is holding can never be freed.
        if (handle) handle.release();
        // This line can wrap, which changes how tall the view is.
        if (seq === estimateSeq && N4DU.windowSize) N4DU.windowSize.fit();
      }
    }, 350);
  }

  function limitLabel() {
    if (!opts.maxKb) return '';
    return opts.maxUnit === 'MB'
      ? `${parseFloat((opts.maxKb / 1024).toFixed(3))} MB`
      : `${opts.maxKb} KB`;
  }
  // ── Running the batch ─────────────────────────────────────────────
  // The work itself lives in js/ui/batch-run.js. This file paints controls
  // and answers clicks; that one converts files and reports on what it did.
  // They meet here: it borrows the settings, and lends back whether a run is
  // in progress — half of this interface is disabled while one is.
  const { run, busy: working } = N4DU.batchRun;
  N4DU.batchRun.connect({
    optsFor, fmtFor, opts, KEEP, syncBatch, limitLabel, renderGrid,
    // Stopping the estimate is the view's business: it owns the timer and
    // the sequence number that decides which answer is still wanted.
    cancelEstimate() { clearTimeout(estimateTimer); estimateSeq++; },
    afterRun(info) { onRunDone(info); },
  });

  function sizeLabel(bytes) {
    if (!bytes) return '0 KB';
    const kb = bytes / 1024;
    return kb >= 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(kb < 10 ? 1 : 0) + ' KB';
  }

  N4DU.batchUI = { initBatchUI, syncBatch, setFolderOffer, opts };

})(window.N4DU ??= {});
