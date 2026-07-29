// Raster editing engine.
//
// The loaded image is never modified. Instead, pixels live on a working
// canvas ("the surface") that every destructive operation rewrites. Export
// and previews read from this surface, so what you see is what you get.
//
// Every operation snapshots the surface first, which is what makes undo and
// redo possible.
(function (N4DU) {

  const MAX_HISTORY = 20;   // snapshots kept in each direction

  let surface = null;       // OffscreenCanvas with the current pixels
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

  // Call before mutating the surface.
  function pushHistory() {
    const snap = snapshot();
    if (!snap) return;
    undoStack.push(snap);
    if (undoStack.length > MAX_HISTORY) undoStack.shift();
    redoStack = [];   // a new edit invalidates the redo trail
  }

  function undo() {
    if (!undoStack.length) return false;
    redoStack.push(snapshot());
    if (redoStack.length > MAX_HISTORY) redoStack.shift();
    surface = undoStack.pop();
    changed();
    return true;
  }

  function redo() {
    if (!redoStack.length) return false;
    undoStack.push(snapshot());
    surface = redoStack.pop();
    changed();
    return true;
  }

  // Discards every edit and goes back to the image as loaded.
  function revert(bitmap) {
    pushHistory();
    surface = canvasFrom(bitmap);
    changed();
  }

  function changed() {
    if (onChanged) onChanged();
  }

  // ── Geometry operations ───────────────────────────────────────────

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
    ctx.translate(out.width / 2, out.height / 2);
    ctx.rotate(turns * Math.PI / 2);
    ctx.drawImage(surface, -w / 2, -h / 2);
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
    ctx.translate(axis === 'h' ? w : 0, axis === 'v' ? h : 0);
    ctx.scale(axis === 'h' ? -1 : 1, axis === 'v' ? -1 : 1);
    ctx.drawImage(surface, 0, 0);
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
    if (x1 - x0 < 2 || y1 - y0 < 2) return false;

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
    const ctx = out.getContext('2d');
    ctx.filter = `blur(${radius}px)`;
    ctx.drawImage(surface, 0, 0);
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

    const ctx = surface.getContext('2d', { willReadFrequently: true });
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;

    const at = (x, y) => (y * w + x) * 4;
    const start = at(px, py);
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
      const dd = dist2(i);
      if (dd <= maxDist) {
        // Inside the range: fade near the outer border for a soft edge.
        const over = dd - (maxDist - softness);
        alpha[p] = over > 0 ? Math.round(255 * (over / softness)) : 0;
        removed++;
        return true;
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
  }

  // mode: 'paint' | 'erase'
  function paintStroke(points, { color, width, mode = 'paint' }) {
    if (!surface || !points.length) return;
    const ctx = surface.getContext('2d');
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

  // Blur brush: blurs only what the stroke covers, by compositing a blurred
  // copy of the surface through the stroke as a mask.
  function blurStroke(points, { width, radius = 8 }) {
    if (!surface || !points.length) return;
    const w = surface.width, h = surface.height;

    // Blurred version of the whole surface.
    const blurred = new OffscreenCanvas(w, h);
    const bctx = blurred.getContext('2d');
    bctx.filter = `blur(${radius}px)`;
    bctx.drawImage(surface, 0, 0);

    // Mask shaped like the stroke.
    const mask = new OffscreenCanvas(w, h);
    const mctx = mask.getContext('2d');
    mctx.lineWidth = width;
    mctx.lineJoin = 'round';
    mctx.lineCap = 'round';
    mctx.strokeStyle = '#fff';
    tracePath(mctx, points, width);

    // Keep the blurred pixels only where the mask is, then stamp them on.
    mctx.globalCompositeOperation = 'source-in';
    mctx.drawImage(blurred, 0, 0);

    surface.getContext('2d').drawImage(mask, 0, 0);
    changed();
  }

  function tracePath(ctx, points, width) {
    if (points.length === 1) {
      // A single tap still paints a dot.
      const p = points[0];
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.5, width / 2), 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
  }

  // Colour of a single pixel, as #rrggbb (used by the eyedropper).
  function pickColor(x, y) {
    if (!surface) return null;
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= surface.width || y >= surface.height) return null;
    const d = surface.getContext('2d', { willReadFrequently: true })
                     .getImageData(x, y, 1, 1).data;
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
    load, setOnChanged, source, width, height, ready,
    canUndo, canRedo, undo, redo, revert,
    rotate, flip, crop, blurAll, removeColor,
    beginStroke, paintStroke, blurStroke, pickColor,
  };

})(window.N4DU ??= {});
