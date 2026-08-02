// Raster editing engine.
//
// The loaded image is never modified. Instead, pixels live on a working
// canvas ("the surface") that every destructive operation rewrites. Export
// and previews read from this surface, so what you see is what you get.
//
// Every operation snapshots the surface first, which is what makes undo and
// redo possible.
(function (N4DU) {

  // The pixel work lives in js/core/paint.js: pure functions over a canvas,
  // with no idea that a document or an undo stack exists.
  const { hasFilter, blurInto, strokeBox, tracePath } = N4DU.paint;

  const MAX_HISTORY = 20;   // snapshots kept in each direction
  // ...but counting snapshots is not the same as counting memory. Each one
  // is the whole surface: on a 12 megapixel photo that is 48 MB, and twenty
  // in each direction came to nearly two gigabytes for a picture somebody
  // just wanted to crop. Whichever limit is reached first wins, so small
  // pictures keep the full twenty steps and large ones keep as many as fit.
  const MAX_HISTORY_BYTES = 256 * 1024 * 1024;

  const snapBytes = (c) => (c ? c.width * c.height * 4 : 0);

  function trimHistory(stack) {
    while (stack.length > MAX_HISTORY) stack.shift();
    let total = 0;
    for (const snap of stack) total += snapBytes(snap);
    // Never below one step: undo has to do something.
    while (stack.length > 1 && total > MAX_HISTORY_BYTES) {
      total -= snapBytes(stack.shift());
    }
  }

  let surface = null;         // OffscreenCanvas with the current pixels
  let strokeBase = null;      // the picture as the current stroke found it
  let undoStack = [];
  let redoStack = [];
  let onChanged = null;     // notified after every change (UI refresh)

  // ── Lifecycle ─────────────────────────────────────────────────────

  // Starts a fresh editing session from a decoded image.
  function load(bitmap) {
    surface = canvasFrom(bitmap);
    undoStack = [];
    redoStack = [];
  }

  function setOnChanged(fn) { onChanged = fn; }

  // The pixel source for rendering and export.
  function source() { return surface; }

  function width()  { return surface ? surface.width : 0; }
  function height() { return surface ? surface.height : 0; }
  function ready()  { return !!surface; }

  function canUndo() { return undoStack.length > 0; }
  function canRedo() { return redoStack.length > 0; }

  // ── History ───────────────────────────────────────────────────────

  function snapshot() {
    if (!surface) return null;
    return canvasFrom(surface);
  }

  // The current pixels as a standalone bitmap, for handing the result back
  // to the converter. Taken from a copy, so the live surface is untouched
  // and the caller owns what it gets.
  function toBitmap() {
    const copy = snapshot();
    return copy ? copy.transferToImageBitmap() : null;
  }

  // Call before mutating the surface.
  function pushHistory() {
    const snap = snapshot();
    if (!snap) return;
    undoStack.push(snap);
    trimHistory(undoStack);
    redoStack = [];   // a new edit invalidates the redo trail
  }

  // Undo and redo end whatever stroke is in progress, and they have to.
  //
  // Ctrl+Z with the brush still held popped the stroke's one and only
  // snapshot, so the canvas came back clean — and then the drag carried on
  // painting the restored surface with no history entry behind it. Let go
  // and you had a painted picture with Undo greyed out: the paint could
  // never be taken back, for the rest of the session.
  //
  // Dropping strokeBase is the whole fix. The next segment finds no base
  // and starts a fresh stroke of its own (see paintStroke and blurStroke),
  // which snapshots first, so the rest of the drag is one more undo step
  // rather than pixels from nowhere.
  function undo() {
    if (!undoStack.length) return false;
    strokeBase = null;
    redoStack.push(snapshot());
    trimHistory(redoStack);
    surface = undoStack.pop();
    changed();
    return true;
  }

  function redo() {
    if (!redoStack.length) return false;
    strokeBase = null;
    undoStack.push(snapshot());
    trimHistory(undoStack);
    surface = redoStack.pop();
    changed();
    return true;
  }

  // Discards every edit and goes back to the image as loaded.
  // Replaces the picture with something already rendered — the shape and
  // framing baked in, say. A real edit, so it goes on the undo stack like any
  // other and can be taken straight back off.
  function replaceWith(source_) {
    if (!source_ || !source_.width || !source_.height) return false;
    pushHistory();
    surface = canvasFrom(source_);
    changed();
    return true;
  }

  function revert(bitmap) {
    pushHistory();
    surface = canvasFrom(bitmap);
    changed();
  }

  function changed() {
    if (onChanged) onChanged();
  }

  // ── Geometry operations ───────────────────────────────────────────

  // The surface's drawing context, guaranteed to have no leftover transform.
  //
  // Canvas contexts keep their transform between calls, and the same context
  // object is handed back on every getContext. A rotate or flip left its
  // matrix in place, so every later brush stroke was transformed too and
  // landed somewhere else entirely. Everything that paints goes through here.
  function surfaceCtx(options) {
    const ctx = surface.getContext('2d', options);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.filter = 'none';
    return ctx;
  }

  // Rotates in multiples of 90 degrees, clockwise.
  function rotate(degrees) {
    if (!surface) return;
    const turns = ((Math.round(degrees / 90) % 4) + 4) % 4;
    if (turns === 0) return;
    pushHistory();

    const swap = turns % 2 === 1;
    const w = surface.width, h = surface.height;
    const out = new OffscreenCanvas(swap ? h : w, swap ? w : h);
    const ctx = out.getContext('2d');
    ctx.save();
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(turns * Math.PI / 2);
    ctx.drawImage(surface, -w / 2, -h / 2);
    ctx.restore();
    surface = out;
    changed();
  }

  // axis: 'h' mirrors left/right, 'v' mirrors top/bottom.
  function flip(axis) {
    if (!surface) return;
    pushHistory();
    const w = surface.width, h = surface.height;
    const out = new OffscreenCanvas(w, h);
    const ctx = out.getContext('2d');
    ctx.save();
    ctx.translate(axis === 'h' ? w : 0, axis === 'v' ? h : 0);
    ctx.scale(axis === 'h' ? -1 : 1, axis === 'v' ? -1 : 1);
    ctx.drawImage(surface, 0, 0);
    ctx.restore();
    surface = out;
    changed();
  }

  // Keeps only the given rectangle (in surface pixels).
  function crop(x, y, w, h) {
    if (!surface) return false;
    x = Math.round(x); y = Math.round(y);
    w = Math.round(w); h = Math.round(h);
    // Clip to the surface and demand a usable area.
    const x0 = Math.max(0, Math.min(surface.width - 1, x));
    const y0 = Math.max(0, Math.min(surface.height - 1, y));
    const x1 = Math.max(x0 + 1, Math.min(surface.width, x + w));
    const y1 = Math.max(y0 + 1, Math.min(surface.height, y + h));
    // One pixel is a real answer. The floor used to be two, so dragging a
    // one-pixel strip did nothing and said nothing, and a 1x1 or 1xN source
    // could not be cropped at all — the clamps above already guarantee at
    // least one pixel, so there was never anything left for this to protect.
    if (x1 - x0 < 1 || y1 - y0 < 1) return false;

    pushHistory();
    const out = new OffscreenCanvas(x1 - x0, y1 - y0);
    out.getContext('2d').drawImage(surface, x0, y0, out.width, out.height,
                                   0, 0, out.width, out.height);
    surface = out;
    changed();
    return true;
  }

  // ── Filters ───────────────────────────────────────────────────────

  // Blurs the whole surface. radius is in pixels.
  function blurAll(radius) {
    if (!surface || radius <= 0) return;
    pushHistory();
    const out = new OffscreenCanvas(surface.width, surface.height);
    blurInto(out.getContext('2d'), surface, 0, 0, surface.width, surface.height, radius);
    surface = out;
    changed();
  }

  // ── Colour removal ────────────────────────────────────────────────
  //
  // contiguous = true  → only the region connected to the clicked point,
  //                      so the same colour elsewhere (e.g. in the middle
  //                      of the subject) is preserved.
  // contiguous = false → every pixel of that colour in the image.
  //
  // tolerance is 0–100: how different a pixel may be and still count as
  // "the same colour". Edges are softened so the cut does not look jagged.
  function removeColor(px, py, tolerance, contiguous) {
    if (!surface) return false;
    const w = surface.width, h = surface.height;
    px = Math.round(px); py = Math.round(py);
    if (px < 0 || py < 0 || px >= w || py >= h) return false;

    const ctx = surfaceCtx({ willReadFrequently: true });
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;

    const at = (x, y) => (y * w + x) * 4;
    const start = at(px, py);
    // A transparent pixel has no colour to cut. PNG stores RGB (0,0,0)
    // behind full transparency, so clicking the empty space around a cut-out
    // subject — the most natural place to click — adopted BLACK as the
    // target and erased every dark part of the picture instead.
    if (d[start + 3] === 0) return false;
    const tr = d[start], tg = d[start + 1], tb = d[start + 2];

    // Squared distance threshold in RGB space. Tolerance is scaled so the
    // slider feels linear across its range.
    const maxDist = Math.pow((tolerance / 100) * 255, 2) * 3 || 1;

    const dist2 = (i) => {
      const dr = d[i] - tr, dg = d[i + 1] - tg, db = d[i + 2] - tb;
      return dr * dr + dg * dg + db * db;
    };

    // Alpha to apply per pixel: 0 = fully removed, 255 = untouched.
    const alpha = new Uint8Array(w * h).fill(255);
    let removed = 0;

    const softness = maxDist * 0.35;   // band where the edge fades out

    const evaluate = (i, p) => {
      // Already transparent: nothing there to take away, and counting it
      // made a click that changed nothing report success and spend one of
      // the twenty undo slots on an identical snapshot.
      if (d[i + 3] === 0) return false;
      const dd = dist2(i);
      if (dd <= maxDist) {
        // Inside the range: fade near the outer border for a soft edge.
        const over = dd - (maxDist - softness);
        const want = over > 0 ? Math.round(255 * (over / softness)) : 0;
        alpha[p] = want;
        if (want < d[i + 3]) removed++;    // only what actually changes
        return true;                       // but the fill still spreads
      }
      return false;
    };

    if (contiguous) {
      // Flood fill from the clicked pixel (iterative: a recursive version
      // blows the stack on large images).
      const seen = new Uint8Array(w * h);
      const queue = [py * w + px];
      seen[py * w + px] = 1;
      while (queue.length) {
        const p = queue.pop();
        const x = p % w, y = (p - x) / w;
        if (!evaluate(p * 4, p)) continue;
        if (x > 0     && !seen[p - 1]) { seen[p - 1] = 1; queue.push(p - 1); }
        if (x < w - 1 && !seen[p + 1]) { seen[p + 1] = 1; queue.push(p + 1); }
        if (y > 0     && !seen[p - w]) { seen[p - w] = 1; queue.push(p - w); }
        if (y < h - 1 && !seen[p + w]) { seen[p + w] = 1; queue.push(p + w); }
      }
    } else {
      for (let p = 0; p < w * h; p++) evaluate(p * 4, p);
    }

    if (!removed) return false;

    pushHistory();
    // Re-read: pushHistory copied the untouched surface, now apply.
    for (let p = 0; p < w * h; p++) {
      if (alpha[p] !== 255) {
        const i = p * 4;
        d[i + 3] = Math.min(d[i + 3], alpha[p]);
      }
    }
    ctx.putImageData(img, 0, 0);
    changed();
    return true;
  }

  // ── Brushes ───────────────────────────────────────────────────────
  //
  // A stroke is a list of points in surface coordinates. Strokes are drawn
  // as a single path so overlapping dabs do not build up seams.

  // Starts a stroke: snapshots once, so the whole stroke is one undo step.
  function beginStroke() {
    if (!surface) return;
    pushHistory();
    // The picture as it was when the stroke began. The blur brush reads from
    // this rather than from the live surface: reading the live surface meant
    // each segment blurred pixels the previous segment had already blurred,
    // so the same stroke came out three times stronger when drawn slowly
    // than when flicked. Measured on one stroke at radius 6: 18px of
    // softening in one segment, 59px in two-pixel steps.
    strokeBase = canvasFrom(surface);
  }

  function endStroke() {
    strokeBase = null;
  }

  // mode: 'paint' | 'erase'
  function paintStroke(points, { color, width, mode = 'paint' }) {
    if (!surface || !points.length) return;
    // Every UI path pairs this with beginStroke(), which is what puts the
    // undo step on the stack. Anything else calling in directly — a script,
    // a future tool — would paint pixels that could never be taken back.
    if (!strokeBase) beginStroke();
    const ctx = surfaceCtx();
    ctx.save();
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    if (mode === 'erase') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    } else {
      ctx.strokeStyle = color;
    }
    tracePath(ctx, points, width);
    ctx.restore();
    changed();
  }

  // Blur brush: blurs only what the stroke covers.
  //
  // Only the bounding box of the incoming segment is processed, so the cost
  // depends on the brush size — not on the image size. Blurring the whole
  // surface on every pointer move made large images unusable.
  function blurStroke(points, { width, radius = 8 }) {
    if (!surface || !points.length) return;
    // Every UI path pairs this with beginStroke(), which is what puts the
    // undo step on the stack. Anything else calling in directly — a script,
    // a future tool — would paint pixels that could never be taken back.
    if (!strokeBase) beginStroke();

    // Padding must exceed the blur reach, otherwise the mask would expose
    // pixels contaminated by the region's own edges.
    const pad = Math.ceil(width / 2 + radius * 3 + 2);
    const box = strokeBox(points, pad, surface);
    if (!box) return;
    const { x, y, w, h } = box;

    // Blurred copy of just that region, taken from the picture as it was
    // when the stroke started, so the result depends on the stroke and not
    // on how fast it was drawn.
    const from = strokeBase || surface;
    const blurred = new OffscreenCanvas(w, h);
    const bctx = blurred.getContext('2d');
    blurInto(bctx, from, x, y, w, h, radius);

    // Mask shaped like the stroke, in region-local coordinates.
    const mask = new OffscreenCanvas(w, h);
    const mctx = mask.getContext('2d');
    mctx.lineWidth = width;
    mctx.lineJoin = 'round';
    mctx.lineCap = 'round';
    mctx.strokeStyle = '#fff';
    mctx.translate(-x, -y);
    tracePath(mctx, points, width);
    mctx.setTransform(1, 0, 0, 1, 0, 0);

    // Keep the blurred pixels only where the mask is, then stamp them back.
    mctx.globalCompositeOperation = 'source-in';
    mctx.drawImage(blurred, 0, 0);
    // Cleared first. Drawing the mask straight on top composites with
    // source-over, which can only ever ADD opacity: a soft edge against
    // transparency never softened, and colour bled outwards into empty
    // space instead. Replacing the region is what "blur" actually means.
    const sctx = surfaceCtx();
    sctx.save();
    sctx.beginPath();
    sctx.rect(x, y, w, h);
    sctx.clip();
    sctx.globalCompositeOperation = 'destination-out';
    sctx.drawImage(mask, x, y);
    // Added, not drawn over. The stroke's edge is antialiased, so along its
    // rim the mask is half-covered — and punching a half-covered hole and
    // then drawing half-covered paint into it does not fill it: source-over
    // gives a + (1-a)(1-a), which is 0.75 where a is 0.5. Blurring made a
    // thin see-through outline along every stroke. "lighter" adds the two
    // premultiplied halves instead, and (1-a) + a is exactly 1.
    sctx.globalCompositeOperation = 'lighter';
    sctx.drawImage(mask, x, y);
    sctx.restore();
    changed();
  }

  // Colour of a single pixel, as #rrggbb (used by the eyedropper).
  function pickColor(x, y) {
    if (!surface) return null;
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) return null;
    const d = surfaceCtx({ willReadFrequently: true }).getImageData(x, y, 1, 1).data;
    const hex = (n) => n.toString(16).padStart(2, '0');
    return '#' + hex(d[0]) + hex(d[1]) + hex(d[2]);
  }

  // ── Helpers ───────────────────────────────────────────────────────

  function canvasFrom(src) {
    const c = new OffscreenCanvas(src.width, src.height);
    c.getContext('2d').drawImage(src, 0, 0);
    return c;
  }

  N4DU.edit = {
    load, setOnChanged, source, width, height, ready, toBitmap,
    canUndo, canRedo, undo, redo, revert, replaceWith,
    rotate, flip, crop, blurAll, removeColor,
    beginStroke, endStroke, paintStroke, blurStroke, pickColor,
  };

})(window.N4DU ??= {});
