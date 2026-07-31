// The queue of files the converter is working on.
//
// Memory is the whole design here. A folder of scans can be fifty files of
// 3000×4000, and holding all of them decoded would be gigabytes. So each
// item keeps only its FILE plus a small thumbnail; the full picture is
// decoded when that item is converted, and released immediately after.
(function (N4DU) {

  const { loadImage } = N4DU.loader;

  const THUMB = 128;          // longest side of the stored preview
  const MAX_ITEMS = 400;      // a sane ceiling; beyond it the UI is unusable

  const items = [];
  let nextId = 1;
  let selectedId = null;
  let onChange = () => {};

  function setOnChange(fn) { onChange = fn || (() => {}); }

  // ── Adding ────────────────────────────────────────────────────────
  // meta: { token, path } when the file came from the disk bridge, which is
  // what makes replacing it in place possible later.
  async function add(files, meta = {}) {
    const incoming = [...files].slice(0, Math.max(0, MAX_ITEMS - items.length));
    const skipped = files.length - incoming.length;
    const failed = [];
    let duplicates = 0;
    let lastPaint = 0;

    for (const file of incoming) {
      // The same file can arrive twice — the explorer handing it over while
      // the folder offer also lists it, or the same selection opened twice.
      // A path is the identity here; pasted images have none and are always
      // treated as new.
      if (meta.path && items.some(it => it.path === meta.path)) { duplicates++; continue; }
      const item = {
        id: nextId++,
        file,
        name: file.name || 'pasted image',
        size: file.size,
        w: 0, h: 0,
        thumb: null,
        token: meta.token || null,
        path: meta.path || null,
        edited: null,       // a bitmap handed back by the editor
        status: 'ready',    // ready | working | done | error
        result: null,
        error: null,
      };
      try {
        // Only meaningful for a single file: one bitmap cannot stand in for
        // several different pictures.
        await measure(item, incoming.length === 1 ? meta.decoded : null);
        items.push(item);
        if (selectedId === null) selectedId = item.id;
      } catch {
        failed.push(item.name);
      }
      // Repainting the whole list once per file is quadratic: the grid is
      // torn down and rebuilt from scratch each time, so 200 files spent
      // about 19 seconds building tiles that were immediately thrown away.
      // Show progress a few times a second instead; the final state is
      // always painted by the onChange() after the loop.
      const now = (globalThis.performance || Date).now();
      if (now - lastPaint > 120) { lastPaint = now; onChange(); }
    }
    onChange();
    // A file dropped for being already in the list was still being counted as
    // added, so re-opening the same picture said "Added 1 file" and added
    // nothing. Report it separately instead.
    return { added: incoming.length - failed.length - duplicates,
             failed, skipped, duplicates };
  }

  // Reads the dimensions and builds the preview, then lets the full-size
  // bitmap go.
  //
  // `decoded` is a bitmap the caller already has. It belongs to the caller,
  // so it is measured and never closed here — passing it just avoids decoding
  // the same file a second time when it is being opened in the editor.
  async function measure(item, decoded) {
    const bmp = decoded || await loadImage(item.file);
    item.w = bmp.width;
    item.h = bmp.height;
    item.thumb = await shrink(bmp, THUMB);
    if (!decoded && bmp !== item.thumb && typeof bmp.close === 'function') bmp.close();
  }

  async function shrink(bmp, side) {
    const scale = Math.min(1, side / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    return canvas.transferToImageBitmap();
  }

  // The full picture for one item, decoded on demand. Edits made in the
  // editor win over the file on disk.
  // Returns { bmp, release } — release() frees it unless it is owned
  // elsewhere (an edited bitmap belongs to the item, not to the caller).
  async function decode(item) {
    if (item.edited) return { bmp: item.edited, release() {} };
    const bmp = await loadImage(item.file);
    return {
      bmp,
      release() { if (typeof bmp.close === 'function') bmp.close(); },
    };
  }

  // Same, but keeping the last one decoded. The estimate re-runs on every
  // change to the format, size or weight cap, and decoding a 4000×3000 scan
  // each time makes the controls feel stuck. Exactly ONE picture is held —
  // the one being estimated — so the memory cost stays bounded.
  //
  // The handle is REFCOUNTED and release() is not optional. Clicking another
  // thumbnail used to close the cached bitmap out from under an estimate
  // that was still running on it, and the conversion died with "The image
  // source is detached" — or worse, read width 0 and produced nothing.
  let hot = { id: null, bmp: null, refs: 0, doomed: false };
  let decodeSeq = 0;

  async function decodeCached(item) {
    if (hot.id === item.id && hot.bmp) {
      const entry = hot;
      entry.refs++;
      return { bmp: entry.bmp, release: () => releaseHot(entry) };
    }
    dropHot();
    if (item.edited) {
      // Owned by the item, so never cached or released here.
      return { bmp: item.edited, release() {} };
    }
    const seq = ++decodeSeq;
    const bmp = await loadImage(item.file);
    if (seq !== decodeSeq) {
      // Another decode started while this one was in flight and owns the slot
      // now. Two overlapping calls both used to install themselves, orphaning
      // the first bitmap with nothing left holding a reference to close it —
      // one leaked full-size decode per race. Hand this one out uncached.
      return { bmp, release() { if (typeof bmp.close === 'function') bmp.close(); } };
    }
    hot = { id: item.id, bmp, refs: 1, doomed: false };
    const entry = hot;
    return { bmp, release: () => releaseHot(entry) };
  }

  function releaseHot(entry) {
    entry.refs--;
    if (entry.doomed && entry.refs <= 0 && entry.bmp) {
      if (typeof entry.bmp.close === 'function') entry.bmp.close();
      entry.bmp = null;
    }
  }

  function dropHot(id) {
    if (id !== undefined && hot.id !== id) return;
    if (hot.bmp) {
      // Still being read: mark it and let the last release() do the closing.
      if (hot.refs > 0) hot.doomed = true;
      else if (typeof hot.bmp.close === 'function') hot.bmp.close();
    }
    hot = { id: null, bmp: null, refs: 0, doomed: false };
  }

  // ── Removing ──────────────────────────────────────────────────────
  function remove(id) {
    dropHot(id);
    const i = items.findIndex(it => it.id === id);
    if (i < 0) return;
    dispose(items[i]);
    items.splice(i, 1);
    if (selectedId === id) selectedId = items.length ? items[Math.min(i, items.length - 1)].id : null;
    onChange();
  }

  function clear() {
    dropHot();
    items.forEach(dispose);
    items.length = 0;
    selectedId = null;
    onChange();
  }

  function dispose(item) {
    for (const bmp of [item.thumb, item.edited]) {
      if (bmp && typeof bmp.close === 'function') bmp.close();
    }
    item.thumb = item.edited = null;
  }

  // ── Selection ─────────────────────────────────────────────────────
  function select(id) {
    if (items.some(it => it.id === id)) {
      // The cache follows the selection: only the picture being estimated
      // is worth holding on to.
      if (id !== selectedId) dropHot();
      selectedId = id;
      onChange();
    }
  }

  function selected() {
    return items.find(it => it.id === selectedId) || null;
  }

  // Replaces an item's picture with one the editor produced.
  function setEdited(id, bmp) {
    const item = items.find(it => it.id === id);
    if (!item) return;
    dropHot(id);
    if (item.edited && item.edited !== bmp && typeof item.edited.close === 'function') {
      item.edited.close();
    }
    item.edited = bmp;
    item.w = bmp.width;
    item.h = bmp.height;
    item.status = 'ready';
    item.result = null;
    shrink(bmp, THUMB).then(thumb => {
      // Removing the file while the thumbnail was still being built wrote the
      // new bitmap onto the dead item, after dispose() had already run — it
      // came back from the grave holding a bitmap nothing would ever close.
      if (!items.includes(item)) {
        if (typeof thumb.close === 'function') thumb.close();
        return;
      }
      if (item.thumb && typeof item.thumb.close === 'function') item.thumb.close();
      item.thumb = thumb;
      onChange();
    });
    onChange();
  }

  // Clears results, e.g. after the output settings changed.
  function resetResults() {
    let touched = false;
    for (const item of items) {
      if (item.status !== 'ready' || item.result || item.error) touched = true;
      item.status = 'ready';
      item.result = null;
      item.error = null;
    }
    if (touched) onChange();
  }

  const totals = () => ({
    count: items.length,
    bytes: items.reduce((n, it) => n + (it.size || 0), 0),
    replaceable: items.filter(it => it.token).length,
    done: items.filter(it => it.status === 'done').length,
    failed: items.filter(it => it.status === 'error').length,
    resultBytes: items.reduce((n, it) => n + (it.result ? it.result.blob.size : 0), 0),
  });

  N4DU.batch = {
    items, add, remove, clear, select, selected, decode, decodeCached, setEdited,
    resetResults, totals, setOnChange, MAX_ITEMS,
    get selectedId() { return selectedId; },
  };

})(window.N4DU ??= {});
