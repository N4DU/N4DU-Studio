// Batch conversion: turning one decoded picture into one output file.
//
// Deliberately separate from the editor. The editor works on a single
// image held in shared state; the converter is a pure function over a
// bitmap, so a hundred files can go through it one after another without
// any of them touching the editing session.
(function (N4DU) {

  const { drawRegion } = N4DU.render;
  const { FORMATS, encodeCanvas, binarySearchQuality } = N4DU.exporter;

  const MAX_SIDE = 20000;   // beyond this a canvas allocation fails outright
  const ICO_MAX = 256;

  // How the output size is decided.
  //   keep  — the original pixel dimensions (the default: a converter should
  //           not resize anything you did not ask it to)
  //   fit   — fit inside a square of `value` px, never enlarging
  //   scale — `value` per cent of the original
  //   width — exactly `value` px wide, height follows the aspect ratio
  const RESIZE_MODES = {
    keep:  { label: 'Keep original', unit: '' },
    fit:   { label: 'Fit within',    unit: 'px' },
    width: { label: 'Exact width',   unit: 'px' },
    scale: { label: 'Scale',         unit: '%' },
  };

  // Target dimensions for one source size. Never upscales on `fit`: blowing
  // a small image up to a large box only wastes bytes.
  function targetSize(w, h, resize, fmt) {
    let W = w, H = h;
    const value = Number(resize.value);
    if (resize.mode === 'fit' && value > 0) {
      const s = Math.min(1, value / Math.max(w, h));
      W = Math.round(w * s);
      H = Math.round(h * s);
    } else if (resize.mode === 'width' && value > 0) {
      W = Math.round(value);
      H = Math.round(h * (W / w));
    } else if (resize.mode === 'scale' && value > 0) {
      W = Math.round(w * value / 100);
      H = Math.round(h * value / 100);
    }
    // ICO carries its own hard ceiling, whatever was asked for.
    if (fmt === 'ico' && Math.max(W, H) > ICO_MAX) {
      const s = ICO_MAX / Math.max(W, H);
      W = Math.round(W * s);
      H = Math.round(H * s);
    }
    W = Math.max(1, Math.min(MAX_SIDE, W));
    H = Math.max(1, Math.min(MAX_SIDE, H));
    return { W, H };
  }

  function paint(bmp, W, H, background) {
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, W, H);
    }
    drawRegion(ctx, bmp, 0, 0, bmp.width, bmp.height, 0, 0, W, H);
    return canvas;
  }

  // Converts one bitmap.
  //
  // opts: { fmt, quality, maxKb, resize: { mode, value } }
  // Returns { blob, W, H, limit } where limit is null when no cap was asked
  // for, { ok: true } when it was met, and { ok: false } when it could not
  // be — never silently passed off as a success.
  async function convert(bmp, opts) {
    const f = FORMATS[opts.fmt];
    const bg = f.alpha ? null : '#ffffff';
    const { W, H } = targetSize(bmp.width, bmp.height, opts.resize, opts.fmt);

    let blob = await encodeCanvas(paint(bmp, W, H, bg), opts.fmt, opts.quality);
    let limit = null;

    if (opts.maxKb) {
      const cap = opts.maxKb * 1024;
      if (blob.size > cap) blob = await squeeze(bmp, opts, W, H, bg, cap);
      limit = blob.size <= cap ? { ok: true } : { ok: false, maxKb: opts.maxKb };
    }
    return { blob, W, H, limit };
  }

  // Gets under the cap: quality first (lossy formats), then resolution.
  // Always re-renders from the source bitmap so the picture is never
  // degraded twice over.
  async function squeeze(bmp, opts, W, H, bg, cap) {
    const f = FORMATS[opts.fmt];
    if (f.lossy) {
      const found = await binarySearchQuality(
        paint(bmp, W, H, bg), opts.fmt, opts.quality, cap);
      if (found) return found;
    }

    // Keep the smallest result seen rather than the last: for lossless
    // formats a smaller canvas does not always mean a smaller file.
    let best = null;
    let scale = 0.9;
    for (let i = 0; i < 16 && Math.min(W, H) * scale >= 8; i++, scale *= 0.82) {
      const w = Math.max(1, Math.round(W * scale));
      const h = Math.max(1, Math.round(H * scale));
      const canvas = paint(bmp, w, h, bg);
      const blob = f.lossy
        ? (await binarySearchQuality(canvas, opts.fmt, opts.quality, cap)) ??
          (await encodeCanvas(canvas, opts.fmt, 0.05))
        : await encodeCanvas(canvas, opts.fmt, opts.quality);
      if (!best || blob.size < best.size) best = blob;
      if (blob.size <= cap) return blob;
    }
    return best;
  }

  // The name a converted file gets: the original stem with the new
  // extension. Keeping the stem is what makes a batch usable — a folder of
  // manga pages must stay in order afterwards.
  function outputName(originalName, fmt) {
    const stem = String(originalName || 'image').replace(/\.[^.]+$/, '') || 'image';
    return `${stem}.${FORMATS[fmt].ext}`;
  }

  N4DU.convert = { convert, targetSize, outputName, RESIZE_MODES };

})(window.N4DU ??= {});
