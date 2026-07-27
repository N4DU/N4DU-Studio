// Miniatura de la salida y datos en la barra de estado.
(function (N4DU) {

  const { state } = N4DU;
  const { shapeLabel } = N4DU.geometry;
  const { FORMATS, outputDims } = N4DU.exporter;
  const { renderOutput } = N4DU.render;

  // Miniatura fiel a la salida (misma proporción y forma), sobre fondo
  // a cuadros para ver la transparencia.
  function drawThumb() {
    if (!state.img) return;
    const { W, H } = outputDims(state);
    const MAX = 96;
    const s = Math.min(MAX / W, MAX / H, 1);
    const w = Math.max(1, Math.round(W * s));
    const h = Math.max(1, Math.round(H * s));

    const out = renderOutput(state, w, h);
    const c = document.getElementById('thumbCanvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(out, 0, 0);

    document.getElementById('previewLabel').textContent =
      `${W}×${H} px · ${FORMATS[state.fmt].label} · ${shapeLabel(state)}`;

    document.getElementById('statusDims').textContent =
      `${state.origW}×${state.origH} px → ${W}×${H} px · ${FORMATS[state.fmt].label}`;
  }

  N4DU.previews = { drawThumb };

})(window.N4DU ??= {});
