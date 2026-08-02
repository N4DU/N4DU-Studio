// Converting the batch, and handing it back.
//
// One file at a time, on purpose: converting fifty 12-megapixel scans in
// parallel exhausts memory and the tab dies. Sequential is slower to start
// and the only version that finishes.
//
// Split out of batch-ui.js because it is a different kind of thing: that
// file paints controls and answers clicks, this one does the work and
// reports on it honestly — including on the files it did not do.
(function (N4DU) {

  const { batch, bridge, toast } = N4DU;
  const { FORMATS, download } = N4DU.exporter;
  const { convert, outputName } = N4DU.convert;

  const $ = (id) => document.getElementById(id);

  // Filled in by batch-ui.js, which owns the settings and the repaint.
  let deps = {
    optsFor: () => ({}), fmtFor: () => 'png', opts: {}, KEEP: 'keep',
    syncBatch: () => {}, limitLabel: () => '',
    renderGrid: () => {}, cancelEstimate: () => {},
  };

  // A run is in progress. It lives here rather than in batch-ui.js because
  // this is the only place that can change it — and half the interface is
  // disabled while it is true, so exactly one copy of the answer must exist.
  let working = false;
  const busy = () => working;

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
    // The estimate is about to be wrong about everything: it runs on the
    // selected file and holds a decoded copy of it, and this is going to
    // decode every file in turn. Cancelling it here is not tidiness — an
    // estimate landing mid-run repaints the line the progress bar is using.
    deps.cancelEstimate();
    deps.syncBatch();
    $('batchProgress').hidden = false;

    const produced = [];
    let done = 0, failed = 0, replaced = 0, overCap = 0;
    // A snapshot, not the live array. Files dropped while a run was going
    // were swept into it halfway through, and the progress denominator grew
    // underneath the text that was already counting up to it.
    const targets = (replace ? batch.items.filter(it => it.token) : batch.items).slice();

    for (const [index, item] of targets.entries()) {
      progress(index, targets.length, item.name);
      item.status = 'working';
      item.error = null;
      deps.renderGrid();
      // Let the browser paint the progress before the blocking work starts.
      await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

      let handle = null;
      try {
        handle = await batch.decode(item);
        const out = await convert(handle.bmp, deps.optsFor(item));
        item.result = out;
        item.status = 'done';
        if (out.limit && !out.limit.ok) overCap++;

        if (replace) {
          const stem = item.name.replace(/\.[^.]+$/, '') || 'image';
          await bridge.replaceByToken(item.token, out.blob, FORMATS[deps.fmtFor(item)].ext, stem, true);
          replaced++;
        } else {
          produced.push({ name: outputName(item.name, deps.fmtFor(item)), blob: out.blob });
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

    deps.syncBatch();
    // A run works from the list as it stood when it started. Files can still
    // arrive while it is going — that is deliberate, you should not have to
    // wait to queue the next lot — but they were then counted nowhere:
    // "Added 1 file", then "Converted 40 of 40 files", with 41 in the list
    // and 40 in the zip, and nothing saying which one had been left out.
    const late = batch.items.filter(it => !targets.includes(it)).length;
    report({ replace, done, failed, replaced, overCap, total: targets.length, late });
  }

  // Sends the results out: one archive by default, separate downloads when
  // asked. Fifty individual downloads is a fifty-prompt browser fight.
  async function deliver(produced) {
    if (produced.length === 1 || deps.opts.separate) {
      for (const file of produced) {
        download(file.blob, file.name);
        // Browsers drop downloads fired in a tight loop.
        await new Promise(r => setTimeout(r, 120));
      }
      return;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const archive = await N4DU.zip.zip(produced);
    // With mixed formats there is no one extension to name the archive after.
    const tag = deps.opts.fmt === deps.KEEP ? 'images' : FORMATS[deps.opts.fmt].ext;
    download(archive, `n4du-${tag}-${stamp}.zip`);
  }

  function report({ replace, done, failed, replaced, overCap, total, late = 0 }) {
    if (!total) { toast('Nothing to do', ''); return; }
    const bits = [];
    if (replace) bits.push(`Overwrote ${replaced} of ${total} file${total > 1 ? 's' : ''}`);
    else bits.push(`Converted ${done} of ${total} file${total > 1 ? 's' : ''}`);
    if (overCap) bits.push(`${overCap} could not get under ${deps.limitLabel()}`);
    if (failed) bits.push(`${failed} failed`);
    if (late) bits.push(`${late} arrived after this run started — press again for ${late > 1 ? 'them' : 'it'}`);
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

  N4DU.batchRun = {
    run, busy,
    connect(d) { deps = { ...deps, ...d }; },
  };

})(window.N4DU ??= {});
