// Pure geometry: shapes and the crop region. No DOM, no state mutation.
(function (N4DU) {

  // Traces a rectangle with rounded corners of radius r.
  // r = 0 → plain rectangle. r = half the shorter side → circle/capsule.
  function shapePath(ctx, x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    ctx.beginPath();
    if (r <= 0.01) {
      ctx.rect(x, y, w, h);
    } else {
      ctx.moveTo(x + r, y);
      ctx.lineTo(x + w - r, y);
      ctx.arcTo(x + w, y, x + w, y + r, r);
      ctx.lineTo(x + w, y + h - r);
      ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
      ctx.lineTo(x + r, y + h);
      ctx.arcTo(x, y + h, x, y + h - r, r);
      ctx.lineTo(x, y + r);
      ctx.arcTo(x, y, x + r, y, r);
      ctx.closePath();
    }
  }

  // Radius in pixels for a rounding level (0–100) over a w×h area.
  function radiusFor(roundness, w, h = w) {
    return (roundness / 100) * (Math.min(w, h) / 2);
  }

  // Square avatar crop region, in surface coordinates.
  function cropRect(state) {
    const side = Math.min(state.origW, state.origH) / state.zoom;
    return { sx: state.cx - side / 2, sy: state.cy - side / 2, side };
  }

  // Keeps the crop centre inside the image for the current zoom.
  function clampCenter(state) {
    const side = Math.min(state.origW, state.origH) / state.zoom;
    const r = side / 2;
    state.cx = Math.max(r, Math.min(state.origW - r, state.cx));
    state.cy = Math.max(r, Math.min(state.origH - r, state.cy));
  }

  // Human-readable label for the current shape.
  function shapeLabel(state) {
    if (state.roundness <= 0) return 'Original';
    if (state.roundness >= 98) {
      const square = state.mode === 'crop' || state.origW === state.origH;
      return square ? 'Circle' : 'Capsule';
    }
    return `Rounded ${state.roundness}%`;
  }

  N4DU.geometry = { shapePath, radiusFor, cropRect, clampCenter, shapeLabel };

})(window.N4DU ??= {});
