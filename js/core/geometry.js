// Geometría pura: formas y región de recorte. Sin DOM, sin estado.
(function (N4DU) {

  // Traza un rectángulo con esquinas redondeadas de radio r sobre el contexto.
  // r = 0 → rectángulo. r = mitad del lado menor → cápsula/círculo.
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

  // Radio en píxeles para un nivel de redondez (0–100) sobre un área w×h.
  function radiusFor(roundness, w, h = w) {
    return (roundness / 100) * (Math.min(w, h) / 2);
  }

  // Región cuadrada de recorte en coordenadas de la imagen original.
  function cropRect(state) {
    const side = Math.min(state.origW, state.origH) / state.zoom;
    return { sx: state.cx - side / 2, sy: state.cy - side / 2, side };
  }

  // Mantiene el centro del recorte dentro de la imagen para el zoom actual.
  function clampCenter(state) {
    const side = Math.min(state.origW, state.origH) / state.zoom;
    const r = side / 2;
    state.cx = Math.max(r, Math.min(state.origW - r, state.cx));
    state.cy = Math.max(r, Math.min(state.origH - r, state.cy));
  }

  // Etiqueta legible de la forma actual.
  function shapeLabel(state) {
    if (state.roundness <= 0) return 'Original';
    if (state.roundness >= 98) {
      const square = state.mode === 'crop' || state.origW === state.origH;
      return square ? 'Círculo' : 'Cápsula';
    }
    return `Redondeo ${state.roundness}%`;
  }

  N4DU.geometry = { shapePath, radiusFor, cropRect, clampCenter, shapeLabel };

})(window.N4DU ??= {});
