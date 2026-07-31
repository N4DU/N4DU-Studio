// The converter: the view N4DU Studio opens in.
//
// A list of files, three settings, two buttons. Everything a batch needs and
// nothing it does not — the editor lives behind the mode button.
(function (N4DU) {

  const { batch, bridge, toast } = N4DU;
  const { FORMATS, detectEncodeSupport, download } = N4DU.exporter;
  const { convert, targetSize, outputName, RESIZE_MODES } = N4DU.convert;

  const $ = (id) => document.getElementById(id);
  const STORE = 'n4du.convert';

  // What the whole view is driven by. Kept apart from the editor's state:
  // these settings apply to every file, not to one open picture.
  const opts = {
    fmt: 'png',
    quality: 0.92,
    maxKb: null,
    maxUnit: 'KB',
    resize: { mode: 'keep', value: 1920 },
    separate: false,
  };

  let support = null;        // which formats this browser can really write
  let working = false;
  let onEditRequest = () => {};

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
      opts.resize.mode = e.target.value;
      changed();
    });
    $('resizeValue').addEventListener('input', e => {
      const n = parseInt(e.target.value, 10);
      if (Number.isFinite(n)) opts.resize.value = Math.max(1, Math.min(20000, n));
      changed();
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
    $('batchSeparate').addEventListener('change', e => {
      opts.separate = e.target.checked;
      save();
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
        maxUnit: opts.maxUnit, resize: opts.resize, separate: opts.separate,
      }));
    } catch { /* private mode, or file:// — the app works without it */ }
  }

  function restore() {
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(STORE) || 'null'); } catch { /* ignore */ }
    if (saved && typeof saved === 'object') {
      if (FORMATS[saved.fmt]) opts.fmt = saved.fmt;
      if (saved.quality > 0 && saved.quality <= 1) opts.quality = saved.quality;
      if (saved.maxKb === null || saved.maxKb > 0) opts.maxKb = saved.maxKb ?? null;
      if (saved.maxUnit === 'MB' || saved.maxUnit === 'KB') opts.maxUnit = saved.maxUnit;
      if (saved.resize && RESIZE_MODES[saved.resize.mode]) {
        opts.resize = { mode: saved.resize.mode, value: Number(saved.resize.value) || 1920 };
      }
      opts.separate = !!saved.separate;
    }
    $('batchQuality').value = Math.round(opts.quality * 100);
    $('batchMaxUnit').value = opts.maxUnit;
    $('batchSeparate').checked = opts.separate;
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
    const f = FORMATS[opts.fmt];
    const usable = !support || support[opts.fmt];

    document.querySelectorAll('#batchFmt .pill').forEach(p =>
      p.classList.toggle('active', p.dataset.fmt === opts.fmt));

    $('fmtWarning').hidden = usable;
    if (!usable) {
      $('fmtWarning').textContent =
        `This browser cannot write ${f.label}. Nothing would be converted, ` +
        'so pick another format (Chrome and Edge write the most).';
    }

    $('qualityRowBatch').style.display = f.lossy ? '' : 'none';
    $('batchQualityVal').textContent = Math.round(opts.quality * 100);
    $('resizeMode').value = opts.resize.mode;
    const mode = RESIZE_MODES[opts.resize.mode];
    $('resizeValue').style.display = opts.resize.mode === 'keep' ? 'none' : '';
    $('resizeUnit').textContent = mode.unit;
    $('resizeUnit').style.display = mode.unit ? '' : 'none';

    $('filesTitle').textContent = totals.count ? `Files (${totals.count})` : 'Files';
    $('filesSummary').textContent = totals.count
      ? `${sizeLabel(totals.bytes)} total${totals.replaceable ? `, ${totals.replaceable} on disk` : ''}`
      : 'nothing loaded';
    $('btnClearFiles').disabled = !totals.count || working;

    // "Add the rest of this folder" appears as soon as one file arrives from
    // disk. How many files a right-click hands over is Windows's decision,
    // not ours — this makes the whole folder one click away either way.
    const folderBtn = $('btnAddFolder');
    folderBtn.hidden = !(bridge.active && folderCount > 0 && !working);
    folderBtn.textContent = `+ ${folderCount} more in this folder`;
    folderBtn.title = folderName
      ? `Add the other images in ${folderName}`
      : 'Add the other images from the same folder';
    $('convertDrop').hidden = totals.count > 0;
    $('convertDropHint').textContent = bridge.active
      ? 'Or right-click images in your file explorer and choose N4DU Studio.'
      : '';

    renderGrid();

    const ready = totals.count > 0 && usable && !working;
    $('btnConvertAll').disabled = !ready;
    $('btnConvertAll').innerHTML = buttonLabel(totals);

    const rep = $('btnReplaceAll');
    rep.disabled = !ready || (bridge.active && totals.replaceable === 0);
    rep.classList.toggle('locked', !bridge.active);
    rep.title = bridge.active
      ? (totals.replaceable
        ? `Overwrite ${totals.replaceable} file${totals.replaceable > 1 ? 's' : ''} where they already are`
        : 'None of these files came from your disk, so there is nothing to overwrite')
      : 'Overwriting files needs the desktop version';

    updateEstimate();
    // The window follows the batch: one file needs far less room than forty.
    if (N4DU.windowSize) N4DU.windowSize.fit();
  }

  function buttonLabel(totals) {
    const many = totals.count > 1 && !opts.separate;
    const what = many ? 'Convert &amp; download .zip' : 'Convert &amp; download';
    return `<svg class="bi"><use href="#i-down"/></svg> ${what}`;
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
      kill.title = 'Remove from the list';
      kill.addEventListener('click', e => {
        e.stopPropagation();
        if (!working) batch.remove(item.id);
      });
      tile.appendChild(kill);

      tile.addEventListener('click', () => batch.select(item.id));
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
    return `${item.w}×${item.h} · ${sizeLabel(item.size)}`;
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

    if (working) return;
    if (!item) { el.textContent = 'Add some files to begin.'; el.classList.remove('warn'); return; }
    if (support && !support[opts.fmt]) { el.textContent = '—'; return; }

    // Once a batch has run, show what actually happened instead of a guess.
    if (totals.done && totals.done + totals.failed >= totals.count) {
      el.classList.toggle('warn', totals.failed > 0);
      el.textContent = `${totals.done} converted · ${sizeLabel(totals.resultBytes)}` +
        (totals.failed ? ` · ${totals.failed} failed` : '') +
        ` (was ${sizeLabel(totals.bytes)})`;
      return;
    }

    const { W, H } = targetSize(item.w, item.h, opts.resize, opts.fmt);
    el.textContent = `Calculating… → ${W}×${H} ${FORMATS[opts.fmt].label}`;
    el.classList.remove('warn');
    clearTimeout(estimateTimer);
    const seq = ++estimateSeq;
    estimateTimer = setTimeout(async () => {
      try {
        const handle = await batch.decodeCached(item);
        const out = await convert(handle.bmp, opts);
        if (seq !== estimateSeq) return;    // a newer estimate is running
        const each = sizeLabel(out.blob.size);
        const all = totals.count > 1
          ? ` · about ${sizeLabel(out.blob.size * totals.count)} for ${totals.count} files`
          : '';
        if (out.limit && !out.limit.ok) {
          el.textContent = `${out.W}×${out.H} · ${each} — cannot get under ${limitLabel()}`;
          el.classList.add('warn');
        } else {
          el.textContent = `${out.W}×${out.H} ${FORMATS[opts.fmt].label} · ${each}${all}`;
        }
      } catch (err) {
        if (seq === estimateSeq) el.textContent = 'Could not read that file: ' + err.message;
      } finally {
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
  // One file at a time, on purpose: converting fifty 12-megapixel scans in
  // parallel exhausts memory and the tab dies. Sequential is slower to
  // start and the only version that finishes.
  async function run(replace) {
    if (working || !batch.items.length) return;
    if (replace && !bridge.active) {
      toast('Overwriting files needs the desktop version', 'err');
      return;
    }
    working = true;
    clearTimeout(estimateTimer);
    estimateSeq++;
    syncBatch();
    $('batchProgress').hidden = false;

    const produced = [];
    let done = 0, failed = 0, replaced = 0, overCap = 0;
    const targets = replace ? batch.items.filter(it => it.token) : batch.items;

    for (const [index, item] of targets.entries()) {
      progress(index, targets.length, item.name);
      item.status = 'working';
      item.error = null;
      renderGrid();
      // Let the browser paint the progress before the blocking work starts.
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      let handle = null;
      try {
        handle = await batch.decode(item);
        const out = await convert(handle.bmp, opts);
        item.result = out;
        item.status = 'done';
        if (out.limit && !out.limit.ok) overCap++;

        if (replace) {
          const stem = item.name.replace(/\.[^.]+$/, '') || 'image';
          await bridge.replaceByToken(item.token, out.blob, FORMATS[opts.fmt].ext, stem, true);
          replaced++;
        } else {
          produced.push({ name: outputName(item.name, opts.fmt), blob: out.blob });
        }
        done++;
      } catch (err) {
        item.status = 'error';
        item.error = shortError(err);
        failed++;
      } finally {
        if (handle) handle.release();
      }
    }

    progress(targets.length, targets.length, '');
    $('batchProgress').hidden = true;
    working = false;

    if (produced.length) await deliver(produced);

    syncBatch();
    report({ replace, done, failed, replaced, overCap, total: targets.length });
  }

  // Sends the results out: one archive by default, separate downloads when
  // asked. Fifty individual downloads is a fifty-prompt browser fight.
  async function deliver(produced) {
    if (produced.length === 1 || opts.separate) {
      for (const file of produced) {
        download(file.blob, file.name);
        // Browsers drop downloads fired in a tight loop.
        await new Promise(r => setTimeout(r, 120));
      }
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const archive = await N4DU.zip.zip(produced);
    download(archive, `n4du-${FORMATS[opts.fmt].ext}-${stamp}.zip`);
  }

  function report({ replace, done, failed, replaced, overCap, total }) {
    if (!total) { toast('Nothing to do', ''); return; }
    const bits = [];
    if (replace) bits.push(`Overwrote ${replaced} of ${total} file${total > 1 ? 's' : ''}`);
    else bits.push(`Converted ${done} of ${total} file${total > 1 ? 's' : ''}`);
    if (overCap) bits.push(`${overCap} could not get under ${limitLabel()}`);
    if (failed) bits.push(`${failed} failed`);
    toast(bits.join(' · '), failed || overCap ? 'err' : 'ok');
  }

  function progress(index, total, name) {
    const pct = total ? Math.round((index / total) * 100) : 0;
    $('batchProgressBar').style.width = pct + '%';
    $('batchProgressText').textContent = index >= total
      ? 'Finishing…'
      : `${index + 1} of ${total} — ${name}`;
  }

  function shortError(err) {
    const text = (err && err.message) || String(err);
    return text.length > 60 ? text.slice(0, 57) + '…' : text;
  }

  function sizeLabel(bytes) {
    if (!bytes) return '0 KB';
    const kb = bytes / 1024;
    return kb >= 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(kb < 10 ? 1 : 0) + ' KB';
  }

  N4DU.batchUI = { initBatchUI, syncBatch, setFolderOffer, opts };

})(window.N4DU ??= {});
