// Rendering: composes the final image (or a preview) onto a canvas.
// Pixels always come from the edit surface, so brush strokes, rotation,
// colour removal and every other edit are included in the output.
(function (N4DU) {

  const { shapePath, radiusFor, cropRect } = N4DU.geometry;

  // Draws a region of the source scaled to dw×dh. Large reductions are done
  // in halving steps: a single drawImage with a strong downscale aliases.
  function drawRegion(ctx, img, sx, sy, sw, sh, dx, dy, dw, dh) {
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Each axis is judged on its own. The check used to be "either axis is
    // not a big reduction", so a 2000×2000 picture going to 100×2000 — an
    // editor thing, with the aspect lock off — took the single-drawImage
    // path and aliased the 20× horizontal squeeze, because the vertical
    // one was not a reduction at all. And halving both axes together would
    // have been worse: the height would have undershot 2000 on the first
    // step and had to be scaled back up.
    const stepW = () => w > dw * 2;
    const stepH = () => h > dh * 2;
    let w = sw, h = sh;
    if (!stepW() && !stepH()) {
      ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
      return;
    }

    let tmp = null;
    while (stepW() || stepH()) {
      const nw = stepW() ? Math.ceil(w / 2) : w;
      const nh = stepH() ? Math.ceil(h / 2) : h;
      const next = new OffscreenCanvas(nw, nh);
      const nctx = next.getContext('2d');
      nctx.imageSmoothingEnabled = true;
      nctx.imageSmoothingQuality = 'high';
      if (tmp) nctx.drawImage(tmp, 0, 0, w, h, 0, 0, nw, nh);
      else nctx.drawImage(img, sx, sy, sw, sh, 0, 0, nw, nh);
      tmp = next; w = nw; h = nh;
    }

    ctx.drawImage(tmp, 0, 0, w, h, dx, dy, dw, dh);
  }

  // The current pixel source: the edit surface, or the raw image before any
  // editing session exists.
  function source(state) {
    return (N4DU.edit && N4DU.edit.ready()) ? N4DU.edit.source() : state.img;
  }

  // Composes the output at W×H according to state.
  // background: fill colour for formats without transparency (JPG, BMP).
  function renderOutput(state, W, H, background = null) {
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');
    const src = source(state);
    if (!src) return canvas;

    if (background) {
      ctx.fillStyle = background;
      ctx.fillRect(0, 0, W, H);
    }

    const r = radiusFor(state.roundness, W, H);
    ctx.save();
    if (r > 0) {
      shapePath(ctx, 0, 0, W, H, r);
      ctx.clip();
    }
    if (state.mode === 'crop') {
      const { sx, sy, side } = cropRect(state, src.width, src.height);
      drawRegion(ctx, src, sx, sy, side, side, 0, 0, W, H);
    } else {
      drawRegion(ctx, src, 0, 0, src.width, src.height, 0, 0, W, H);
    }
    ctx.restore();

    return canvas;
  }

  N4DU.render = { drawRegion, renderOutput, source };

})(window.N4DU ??= {});
