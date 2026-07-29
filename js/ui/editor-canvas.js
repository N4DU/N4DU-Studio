// Canvas principal de edición: dibujo, arrastre, zoom y teclado.
(function (N4DU) {

  const { state } = N4DU;
  const { shapePath, radiusFor, cropRect, clampCenter } = N4DU.geometry;

  const canvas = () => document.getElementById('editorCanvas');
  const wrap   = () => document.getElementById('canvasWrap');

  function canvasSize() {
    const w = wrap();
    return Math.min(w.clientWidth, w.clientHeight) || 460;
  }

  // ¿Hay un diálogo modal abierto? (los atajos del canvas no deben actuar)
  function modalOpen() {
    const m = document.getElementById('replaceModal');
    return !!m && !m.hidden;
  }

  // Dibuja el estado actual: imagen atenuada de fondo y la zona que se
  // exporta nítida, con el contorno de la forma elegida.
  function drawEditor() {
    if (!state.img) return;
    const c = canvas();
    const S = canvasSize();
    // Se dibuja a la resolución real de la pantalla (en un monitor 2× el
    // canvas tendría la mitad de definición) y se trabaja en píxeles CSS.
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    c.width = c.height = Math.round(S * dpr);
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingQuality = 'high';

    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, S, S);

    let dx, dy, dw, dh;   // dónde queda la imagen completa en el canvas
    let fx, fy, fw, fh;   // rectángulo de la zona exportada

    if (state.mode === 'crop') {
      const { sx, sy, side } = cropRect(state);
      const scale = (S - 4) / side;
      dx = 2 - sx * scale; dy = 2 - sy * scale;
      dw = state.origW * scale; dh = state.origH * scale;
      fx = 2; fy = 2; fw = S - 4; fh = S - 4;
    } else {
      // La vista respeta la proporción de SALIDA: si se desbloquea el
      // candado y se deforma el tamaño, acá se ve deformado igual que en
      // el archivo final.
      const outW = Math.max(1, state.outW), outH = Math.max(1, state.outH);
      const scale = Math.min((S - 4) / outW, (S - 4) / outH);
      dw = outW * scale; dh = outH * scale;
      dx = (S - dw) / 2; dy = (S - dh) / 2;
      fx = dx; fy = dy; fw = dw; fh = dh;
    }

    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.drawImage(state.img, dx, dy, dw, dh);
    ctx.restore();

    const r = radiusFor(state.roundness, fw, fh);
    ctx.save();
    shapePath(ctx, fx, fy, fw, fh, r);
    ctx.clip();
    ctx.drawImage(state.img, dx, dy, dw, dh);
    ctx.restore();

    ctx.strokeStyle = '#e8ff47';
    ctx.lineWidth = 1.5;
    shapePath(ctx, fx, fy, fw, fh, r);
    ctx.stroke();
  }

  function initEditorCanvas(onChange) {
    const c = canvas();
    let dragging = false;
    let last = { x: 0, y: 0 };

    c.addEventListener('pointerdown', e => {
      if (state.mode !== 'crop' || !state.img) return;
      dragging = true;
      last = { x: e.clientX, y: e.clientY };
      c.setPointerCapture(e.pointerId);
      c.classList.add('dragging');
    });
    c.addEventListener('pointerup', e => {
      dragging = false;
      c.classList.remove('dragging');
      if (c.hasPointerCapture(e.pointerId)) c.releasePointerCapture(e.pointerId);
    });
    c.addEventListener('pointermove', e => {
      if (!dragging || !state.img) return;
      const { side } = cropRect(state);
      // El puntero se mueve en píxeles CSS, no en los del canvas.
      const pxPerCanvas = side / canvasSize();
      state.cx -= (e.clientX - last.x) * pxPerCanvas;
      state.cy -= (e.clientY - last.y) * pxPerCanvas;
      last = { x: e.clientX, y: e.clientY };
      clampCenter(state);
      onChange();
    });

    // Rueda del mouse = zoom (solo en modo recorte)
    c.addEventListener('wheel', e => {
      if (state.mode !== 'crop' || !state.img) return;
      e.preventDefault();
      setZoom(state.zoom + (e.deltaY > 0 ? -0.08 : 0.08), onChange);
    }, { passive: false });

    // Flechas del teclado = mover el encuadre (Shift = pasos grandes)
    window.addEventListener('keydown', e => {
      if (state.mode !== 'crop' || !state.img) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
      if (modalOpen()) return;   // no mover el recorte por debajo del diálogo
      const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const m = moves[e.key];
      if (!m) return;
      e.preventDefault();
      const step = (e.shiftKey ? 40 : 8) * (cropRect(state).side / canvasSize());
      state.cx += m[0] * step;
      state.cy += m[1] * step;
      clampCenter(state);
      onChange();
    });

    document.getElementById('zoomSlider').addEventListener('input', e => {
      setZoom(parseFloat(e.target.value), onChange);
    });
    document.getElementById('resetZoom').addEventListener('click', () => setZoom(1, onChange));

    // Redibujar si cambia el tamaño del contenedor
    new ResizeObserver(() => { if (state.img) drawEditor(); }).observe(wrap());
  }

  function setZoom(z, onChange) {
    state.zoom = Math.max(1, Math.min(5, z));
    document.getElementById('zoomSlider').value = state.zoom;
    document.getElementById('zoomVal').textContent = Math.round(state.zoom * 100) + '%';
    clampCenter(state);
    onChange();
  }

  // Muestra u oculta los controles que solo aplican al modo recorte,
  // y ajusta el cursor del canvas.
  function syncCanvasUI() {
    document.getElementById('zoomBar').style.display = state.mode === 'crop' ? 'flex' : 'none';
    canvas().classList.toggle('draggable', state.mode === 'crop');
  }

  N4DU.editorCanvas = { initEditorCanvas, drawEditor, syncCanvasUI, setZoom };

})(window.N4DU ??= {});
