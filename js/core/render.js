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

    if (sw <= dw * 2 || sh <= dh * 2) {
      ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
      return;
    }

    let tmp = new OffscreenCanvas(Math.ceil(sw / 2), Math.ceil(sh / 2));
    let tctx = tmp.getContext('2d');
    tctx.imageSmoothingQuality = 'high';
    tctx.drawImage(img, sx, sy, sw, sh, 0, 0, tmp.width, tmp.height);
    let w = tmp.width, h = tmp.height;

    while (w > dw * 2 && h > dh * 2) {
      const nw = Math.ceil(w / 2), nh = Math.ceil(h / 2);
      const next = new OffscreenCanvas(nw, nh);
      const nctx = next.getContext('2d');
      nctx.imageSmoothingQuality = 'high';
      nctx.drawImage(tmp, 0, 0, w, h, 0, 0, nw, nh);
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
