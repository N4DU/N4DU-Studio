// Pixel operations, and nothing else.
//
// Everything here takes what it needs as an argument and gives back what it
// produced. No surface, no history, no undo — those belong to edit.js, which
// owns the picture being edited and decides when to snapshot it.
//
// The line is drawn there on purpose: this file can be read one function at
// a time, and getting it wrong shows up as wrong pixels rather than as a
// document that quietly lost its past.
(function (N4DU) {

  // Does this browser support canvas filters? Safari only gained them
  // recently, so a manual blur is kept as a fallback.
  let filterSupport = null;
  function hasFilter() {
    if (filterSupport === null) {
      const ctx = new OffscreenCanvas(1, 1).getContext('2d');
      ctx.filter = 'blur(1px)';
      filterSupport = ctx.filter !== 'none';
    }
    return filterSupport;
  }

  // Blurs a region of src into ctx (which must be w×h). Uses the native
  // filter when available, otherwise a separable box blur — three passes
  // approximate a Gaussian closely enough to look the same.
  //
  // The work is done on a padded copy, and this is the whole point of the
  // function. A blur kernel reaches outside whatever you hand it, and a
  // canvas is empty outside its own edges: blurring a w×h copy on its own
  // mixed the picture with transparency all the way round, so "blur the
  // whole picture" came back with every edge faded out — invisible on PNG
  // until you looked, and a bright glowing frame once composited over white
  // for JPEG. Measured on a solid opaque square: alpha 70 at the corner,
  // 134 at the edge, 255 only in the middle.
  //
  // So the region is read back with a margin. Where the margin falls inside
  // the picture it is real neighbouring pixels, which is also what stops the
  // blur brush from seeing the edges of its own little box. Where it falls
  // outside — at the true border of the picture — the border pixels are
  // stretched into it, which is the standard way to blur an edge without
  // inventing anything: the edge stays as opaque as it started.
  function blurInto(ctx, src, sx, sy, w, h, radius) {
    const m = Math.max(1, Math.ceil(radius * 3));
    // What the padded read wants, and what the picture can actually give.
    const rx = Math.max(0, sx - m);
    const ry = Math.max(0, sy - m);
    const rw = Math.min(src.width, sx + w + m) - rx;
    const rh = Math.min(src.height, sy + h + m) - ry;
    if (rw <= 0 || rh <= 0) return;

    const padded = new OffscreenCanvas(w + m * 2, h + m * 2);
    const pctx = padded.getContext('2d');
    // Where the real pixels land inside the padded canvas.
    const dx = m - (sx - rx);
    const dy = m - (sy - ry);
    pctx.drawImage(src, rx, ry, rw, rh, dx, dy, rw, rh);
    stretchEdges(pctx, dx, dy, rw, rh);

    if (hasFilter()) {
      // Straight into the destination, margins and all: the canvas edge
      // does the cropping. Blurring into a third full-size offscreen first
      // and then copying the middle out of it is the same picture and one
      // more 12-megapixel allocation and copy — on "blur the whole photo"
      // that was most of a second of the wait.
      ctx.save();
      ctx.clearRect(0, 0, w, h);
      ctx.filter = `blur(${radius}px)`;
      ctx.drawImage(padded, -m, -m);
      ctx.restore();
      return;
    }

    // No filter: box passes by hand, which need the pixels somewhere real.
    const blurred = new OffscreenCanvas(padded.width, padded.height);
    const bctx = blurred.getContext('2d');
    bctx.drawImage(padded, 0, 0);
    const img = bctx.getImageData(0, 0, blurred.width, blurred.height);
    const r = Math.max(1, Math.round(radius * 0.6));
    premultiply(img.data);
    for (let pass = 0; pass < 3; pass++) {
      boxBlurPass(img.data, blurred.width, blurred.height, r, true);
      boxBlurPass(img.data, blurred.width, blurred.height, r, false);
    }
    unpremultiply(img.data);
    bctx.putImageData(img, 0, 0);

    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(blurred, m, m, w, h, 0, 0, w, h);
  }

  // Fills the empty margin around a drawn region by stretching its border
  // pixels outwards. Sides first across the region's own height, then top
  // and bottom across the full width, so the corners come out of the sides
  // that were just filled rather than being left empty.
  function stretchEdges(ctx, x, y, w, h) {
    const canvas = ctx.canvas;
    const W = canvas.width, H = canvas.height;
    const right = x + w, bottom = y + h;
    // Smoothing off, and it matters. Stretching a one-pixel slice with
    // bilinear filtering samples past the slice into the empty canvas, so
    // the replicated margin came out slightly transparent — and that fed
    // straight back into the blur, leaving alpha 251 where 255 was the whole
    // point of doing this. Nearest-neighbour on a one-pixel source is not an
    // approximation: there is only one pixel to choose.
    const smoothing = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = false;
    if (x > 0) ctx.drawImage(canvas, x, y, 1, h, 0, y, x, h);
    if (right < W) ctx.drawImage(canvas, right - 1, y, 1, h, right, y, W - right, h);
    if (y > 0) ctx.drawImage(canvas, 0, y, W, 1, 0, 0, W, y);
    if (bottom < H) ctx.drawImage(canvas, 0, bottom - 1, W, 1, 0, bottom, W, H - bottom);
    ctx.imageSmoothingEnabled = smoothing;
  }

  // One box-blur pass over rows (horizontal) or columns (vertical).
  //
  // Works on PREMULTIPLIED colour, and has to. Averaging raw RGBA weights
  // the colour hiding behind a transparent pixel exactly as much as the
  // colour you can see, and that hidden colour is almost always black: a
  // white shape blurred against a cut-out came out mid-grey along the cut,
  // where the native filter holds the colour and fades only the alpha.
  // Measured across a white-to-transparent boundary: 207, 199, 184, 169,
  // 153 … 56. Multiplying by alpha before and dividing after is the whole
  // fix — see premultiply()/unpremultiply() around the passes.
  function boxBlurPass(d, w, h, r, horizontal) {
    const outer = horizontal ? h : w;
    const inner = horizontal ? w : h;
    const stride = horizontal ? 4 : w * 4;
    const jump = horizontal ? w * 4 : 4;
    const line = new Float32Array(inner * 4);

    for (let o = 0; o < outer; o++) {
      const base = o * jump;
      for (let i = 0; i < inner; i++) {
        const p = base + i * stride;
        line[i * 4] = d[p]; line[i * 4 + 1] = d[p + 1];
        line[i * 4 + 2] = d[p + 2]; line[i * 4 + 3] = d[p + 3];
      }
      let sr = 0, sg = 0, sb = 0, sa = 0, count = 0;
      // Prime the window.
      for (let i = 0; i <= r && i < inner; i++) {
        sr += line[i * 4]; sg += line[i * 4 + 1];
        sb += line[i * 4 + 2]; sa += line[i * 4 + 3]; count++;
      }
      for (let i = 0; i < inner; i++) {
        const p = base + i * stride;
        d[p] = sr / count; d[p + 1] = sg / count;
        d[p + 2] = sb / count; d[p + 3] = sa / count;
        const add = i + r + 1, drop = i - r;
        if (add < inner) {
          sr += line[add * 4]; sg += line[add * 4 + 1];
          sb += line[add * 4 + 2]; sa += line[add * 4 + 3]; count++;
        }
        if (drop >= 0) {
          sr -= line[drop * 4]; sg -= line[drop * 4 + 1];
          sb -= line[drop * 4 + 2]; sa -= line[drop * 4 + 3]; count--;
        }
      }
    }
  }

  function premultiply(d) {
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;
      d[i] *= a; d[i + 1] *= a; d[i + 2] *= a;
    }
  }

  function unpremultiply(d) {
    for (let i = 0; i < d.length; i += 4) {
      const a = d[i + 3] / 255;
      if (a === 0) continue;          // nothing to recover, and no divide by zero
      d[i] = Math.min(255, d[i] / a);
      d[i + 1] = Math.min(255, d[i + 1] / a);
      d[i + 2] = Math.min(255, d[i + 2] / a);
    }
  }

  // Bounding box of a set of points, padded and clipped to the picture.
  //
  // The bounds come in as arguments rather than being read off a surface:
  // that is the whole difference between a function you can reason about
  // alone and one you have to run the program to understand.
  function strokeBox(points, pad, bounds) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (minX === Infinity) return null;
    const x = Math.max(0, Math.floor(minX - pad));
    const y = Math.max(0, Math.floor(minY - pad));
    const x2 = Math.min(bounds.width, Math.ceil(maxX + pad));
    const y2 = Math.min(bounds.height, Math.ceil(maxY + pad));
    if (x2 <= x || y2 <= y) return null;
    return { x, y, w: x2 - x, h: y2 - y };
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

  N4DU.paint = { hasFilter, blurInto, strokeBox, tracePath };

})(window.N4DU ??= {});
