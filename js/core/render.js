// Renderizado: compone la imagen final (o una vista previa) en un canvas.
(function (N4DU) {

  const { shapePath, radiusFor, cropRect } = N4DU.geometry;

  // Dibuja una región de la imagen escalada a dw×dh. Si la reducción es
  // grande, escala en pasos (mitades sucesivas) para conservar nitidez:
  // un solo drawImage con reducción fuerte produce aliasing.
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

  // Compone la salida final según el estado en un OffscreenCanvas W×H.
  // background: color de fondo para formatos sin transparencia (JPG, BMP).
  function renderOutput(state, W, H, background = null) {
    const canvas = new OffscreenCanvas(W, H);
    const ctx = canvas.getContext('2d');

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
      const { sx, sy, side } = cropRect(state);
      drawRegion(ctx, state.img, sx, sy, side, side, 0, 0, W, H);
    } else {
      drawRegion(ctx, state.img, 0, 0, state.origW, state.origH, 0, 0, W, H);
    }
    ctx.restore();

    return canvas;
  }

  N4DU.render = { drawRegion, renderOutput };

})(window.N4DU ??= {});
