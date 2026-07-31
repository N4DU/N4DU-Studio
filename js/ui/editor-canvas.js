// Main editing canvas: drawing, panning, zooming and tool input routing.
(function (N4DU) {

  const { state } = N4DU;
  const { shapePath, radiusFor, cropRect, clampCenter } = N4DU.geometry;

  const canvas = () => document.getElementById('editorCanvas');
  const wrap   = () => document.getElementById('canvasWrap');

  // Where the image ended up inside the canvas, in CSS pixels. Kept from
  // the last paint so pointer positions can be mapped back to image pixels.
  let view = { dx: 0, dy: 0, scale: 1 };

  // Selection drawn by the crop tool, in image pixels (null = none).
  let selection = null;

  // Delegate for tool interaction, installed by the tools module.
  let toolHandler = null;

  // Size of the stage in CSS pixels. It is no longer forced to be square:
  // the frame takes the shape of the exported picture.
  function canvasBox() {
    const w = wrap();
    return { w: w.clientWidth || 460, h: w.clientHeight || 460 };
  }

  function canvasSize() {
    const b = canvasBox();
    return Math.min(b.w, b.h);
  }

  // Is a modal dialog open? (canvas shortcuts must not act)
  function modalOpen() {
    const m = document.getElementById('replaceModal');
    return !!m && !m.hidden;
  }

  // Converts a pointer event to image (surface) coordinates. The vertical
  // scale can differ from the horizontal one when the output aspect ratio is
  // unlocked and the preview is stretched.
  function toImage(e) {
    const rect = canvas().getBoundingClientRect();
    const x = (e.clientX - rect.left - view.dx) / view.scale;
    const y = (e.clientY - rect.top - view.dy) / (view.scaleY ?? view.scale);
    return { x, y };
  }

  function setSelection(sel) { selection = sel; }
  function getSelection() { return selection; }

  // Pointer position relative to the canvas, in CSS pixels.
  function toScreen(e) {
    const rect = canvas().getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // Which framing the stage is showing.
  //
  // The crop tool always works on the WHOLE picture, whatever shape the
  // export is set to. With the square framing on, the stage showed only the
  // square window, so the crop box — which covers the picture — started
  // with its corners off the canvas and could not be grabbed at all. The
  // square preview comes back the moment the tool is put down.
  function activeFraming() {
    return state.tool === 'crop' ? 'original' : state.mode;
  }

  // Draws the current state: the image dimmed, the exported area sharp, and
  // the outline of the chosen shape.
  function drawEditor() {
    const src = N4DU.render.source(state);
    if (!src) return;
    const c = canvas();
    const { w: CW, h: CH } = canvasBox();
    // Draw at the screen's real resolution (on a 2× display the canvas would
    // otherwise be half as sharp) while working in CSS pixels.
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    c.width = Math.round(CW * dpr);
    c.height = Math.round(CH * dpr);
    const ctx = c.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingQuality = 'high';

    ctx.fillStyle = '#0d0d0d';
    ctx.fillRect(0, 0, CW, CH);

    let dx, dy, dw, dh;   // where the whole image lands on the canvas
    let fx, fy, fw, fh;   // rectangle of the exported area

    if (activeFraming() === 'crop') {
      // A square window centred in the stage.
      const side = Math.min(CW, CH) - 4;
      const { sx, sy, side: cropSide } = cropRect(state);
      const scale = side / cropSide;
      fx = (CW - side) / 2; fy = (CH - side) / 2; fw = fh = side;
      dx = fx - sx * scale; dy = fy - sy * scale;
      dw = state.origW * scale; dh = state.origH * scale;
      view = { dx, dy, scale };
    } else {
      // The view follows the OUTPUT aspect ratio: unlock the ratio and
      // distort the size, and it looks distorted here too, exactly like the
      // exported file.
      const outW = Math.max(1, state.outW), outH = Math.max(1, state.outH);
      const scale = Math.min((CW - 4) / outW, (CH - 4) / outH);
      dw = outW * scale; dh = outH * scale;
      dx = (CW - dw) / 2; dy = (CH - dh) / 2;
      fx = dx; fy = dy; fw = dw; fh = dh;
      // Image pixels map onto the drawn rectangle, which may be stretched.
      view = { dx, dy, scale: dw / state.origW, scaleY: dh / state.origH };
    }

    // Checkerboard behind the image so transparency is visible.
    drawCheckerboard(ctx, fx, fy, fw, fh);

    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.drawImage(src, dx, dy, dw, dh);
    ctx.restore();

    const r = radiusFor(state.roundness, fw, fh);
    ctx.save();
    shapePath(ctx, fx, fy, fw, fh, r);
    ctx.clip();
    ctx.drawImage(src, dx, dy, dw, dh);
    ctx.restore();

    ctx.strokeStyle = '#e8ff47';
    ctx.lineWidth = 1.5;
    shapePath(ctx, fx, fy, fw, fh, r);
    ctx.stroke();

    if (selection) drawSelection(ctx);
  }

  function drawCheckerboard(ctx, x, y, w, h) {
    const size = 10;
    ctx.save();
    ctx.beginPath();
    ctx.rect(x, y, w, h);
    ctx.clip();
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#222';
    for (let iy = 0; iy * size < h; iy++) {
      for (let ix = 0; ix * size < w; ix++) {
        if ((ix + iy) % 2) ctx.fillRect(x + ix * size, y + iy * size, size, size);
      }
    }
    ctx.restore();
  }

  // Converts the selection (image pixels) to screen space (CSS pixels).
  function selectionOnScreen() {
    if (!selection) return null;
    const sy = view.scaleY ?? view.scale;
    return {
      x: view.dx + selection.x * view.scale,
      y: view.dy + selection.y * sy,
      w: selection.w * view.scale,
      h: selection.h * sy,
    };
  }

  // The crop box: dimmed surroundings, a dashed outline, thirds guides and
  // grab handles on the corners and edges.
  function drawSelection(ctx) {
    const b = selectionOnScreen();
    if (!b) return;
    const { w: CW, h: CH } = canvasBox();

    ctx.save();
    // Dim everything except the selection.
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.beginPath();
    ctx.rect(0, 0, CW, CH);
    ctx.rect(b.x, b.y, b.w, b.h);
    ctx.fill('evenodd');

    // Rule-of-thirds guides inside the box
    ctx.strokeStyle = 'rgba(255,255,255,.22)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 3; i++) {
      const gx = b.x + (b.w * i) / 3, gy = b.y + (b.h * i) / 3;
      ctx.moveTo(gx, b.y); ctx.lineTo(gx, b.y + b.h);
      ctx.moveTo(b.x, gy); ctx.lineTo(b.x + b.w, gy);
    }
    ctx.stroke();

    // Outline
    ctx.strokeStyle = '#e8ff47';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(b.x, b.y, b.w, b.h);

    // Handles: chunky corners plus a tick in the middle of each side
    ctx.fillStyle = '#e8ff47';
    const L = 16, T = 3;                     // corner arm length, thickness
    const corners = [
      [b.x, b.y, 1, 1], [b.x + b.w, b.y, -1, 1],
      [b.x, b.y + b.h, 1, -1], [b.x + b.w, b.y + b.h, -1, -1],
    ];
    for (const [cx, cy, sx, sy2] of corners) {
      ctx.fillRect(cx - (sx < 0 ? T : 0), cy - (sy2 < 0 ? T : 0),
                   sx * L, sy2 * T || T);
      ctx.fillRect(cx - (sx < 0 ? T : 0), cy - (sy2 < 0 ? T : 0),
                   sx * T || T, sy2 * L);
    }
    const M = 14;
    ctx.fillRect(b.x + b.w / 2 - M / 2, b.y - T / 2, M, T);              // top
    ctx.fillRect(b.x + b.w / 2 - M / 2, b.y + b.h - T / 2, M, T);        // bottom
    ctx.fillRect(b.x - T / 2, b.y + b.h / 2 - M / 2, T, M);              // left
    ctx.fillRect(b.x + b.w - T / 2, b.y + b.h / 2 - M / 2, T, M);        // right

    // Live pixel size, so the crop is not guesswork
    const label = `${Math.round(selection.w)} × ${Math.round(selection.h)}`;
    ctx.font = '600 12px system-ui, sans-serif';
    const tw = ctx.measureText(label).width;
    const bx = b.x + b.w / 2 - tw / 2 - 7;
    const by = b.y + b.h + 8;
    const fits = by + 20 < CH;
    const ty = fits ? by : b.y - 28;
    ctx.fillStyle = 'rgba(10,10,10,.85)';
    ctx.fillRect(bx, ty, tw + 14, 20);
    ctx.fillStyle = '#e8ff47';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, bx + 7, ty + 10);
    ctx.restore();
  }

  // ── Brush cursor ──────────────────────────────────────────────────
  // A ring the exact size of the brush follows the pointer, so the size
  // slider needs no interpretation: you see what you are about to paint.
  let cursorAt = null;   // last pointer position, in CSS pixels

  function isPaintTool() {
    return state.tool === 'brush' || state.tool === 'erase' || state.tool === 'blur';
  }

  function updateBrushCursor() {
    const ring = document.getElementById('brushCursor');
    if (!ring) return;
    if (!isPaintTool() || !cursorAt || !N4DU.render.source(state)) {
      ring.hidden = true;
      return;
    }
    // Brush size is in image pixels; scale it to screen.
    const size = Math.max(4, state.brushSize * view.scale);
    ring.hidden = false;
    ring.style.width = ring.style.height = size + 'px';
    ring.style.left = cursorAt.x + 'px';
    ring.style.top = cursorAt.y + 'px';
  }

  function initEditorCanvas(onChange) {
    const c = canvas();
    let dragging = false;
    let last = { x: 0, y: 0 };

    // Track the pointer for the brush ring
    c.addEventListener('pointermove', e => {
      const rect = c.getBoundingClientRect();
      cursorAt = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      updateBrushCursor();
    });
    c.addEventListener('pointerleave', () => {
      cursorAt = null;
      updateBrushCursor();
    });

    c.addEventListener('pointerdown', e => {
      if (!N4DU.render.source(state)) return;
      // Tools take precedence over panning.
      if (toolHandler && toolHandler.down(e, toImage(e))) {
        c.setPointerCapture(e.pointerId);
        return;
      }
      if (state.mode !== 'crop' || state.tool !== 'move') return;
      dragging = true;
      last = { x: e.clientX, y: e.clientY };
      c.setPointerCapture(e.pointerId);
      c.classList.add('dragging');
    });

    c.addEventListener('pointermove', e => {
      if (toolHandler && toolHandler.move(e, toImage(e))) return;
      if (!dragging) return;
      // view.scale is CSS pixels per image pixel, so the inverse converts a
      // pointer movement straight into image pixels.
      const perPixel = 1 / (view.scale || 1);
      state.cx -= (e.clientX - last.x) * perPixel;
      state.cy -= (e.clientY - last.y) * perPixel;
      last = { x: e.clientX, y: e.clientY };
      clampCenter(state);
      onChange();
    });

    const endPointer = e => {
      if (toolHandler) toolHandler.up(e, toImage(e));
      dragging = false;
      c.classList.remove('dragging');
      if (c.hasPointerCapture?.(e.pointerId)) c.releasePointerCapture(e.pointerId);
    };
    c.addEventListener('pointerup', endPointer);
    c.addEventListener('pointercancel', endPointer);

    // Mouse wheel = zoom (avatar crop mode only)
    c.addEventListener('wheel', e => {
      if (state.mode !== 'crop' || !N4DU.render.source(state)) return;
      e.preventDefault();
      setZoom(state.zoom + (e.deltaY > 0 ? -0.08 : 0.08), onChange);
    }, { passive: false });

    // Arrow keys nudge the crop framing (Shift = larger steps)
    window.addEventListener('keydown', e => {
      if (state.mode !== 'crop' || !N4DU.render.source(state)) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
      if (modalOpen()) return;   // do not move the crop under the dialog
      const moves = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const m = moves[e.key];
      if (!m) return;
      e.preventDefault();
      const step = (e.shiftKey ? 40 : 8) / (view.scale || 1);
      state.cx += m[0] * step;
      state.cy += m[1] * step;
      clampCenter(state);
      onChange();
    });

    document.getElementById('zoomSlider').addEventListener('input', e => {
      setZoom(parseFloat(e.target.value), onChange);
    });
    document.getElementById('resetZoom').addEventListener('click', () => setZoom(1, onChange));

    // Zoom can also be typed: click the percentage and enter a number.
    N4DU.editableNumber.makeEditable(
      document.getElementById('zoomVal'),
      document.getElementById('zoomSlider'), null, 100);

    // Repaint when the container is resized
    new ResizeObserver(() => { if (N4DU.render.source(state)) drawEditor(); }).observe(wrap());
  }

  function setZoom(z, onChange) {
    state.zoom = Math.max(1, Math.min(5, z));
    document.getElementById('zoomSlider').value = state.zoom;
    document.getElementById('zoomVal').textContent = Math.round(state.zoom * 100) + '%';
    clampCenter(state);
    onChange();
  }

  // Shows or hides controls that only apply to the avatar crop mode, and
  // sets the cursor for the active tool.
  function syncCanvasUI() {
    document.getElementById('zoomBar').style.display = state.mode === 'crop' ? 'flex' : 'none';

    // The frame takes the shape of what will be exported. Extreme ratios are
    // clamped so a panorama does not squash the stage into a strip.
    // The stage takes the shape of whatever is being shown — which, while
    // cropping, is the picture rather than the square export.
    const ratio = activeFraming() === 'crop'
      ? 1
      : Math.max(0.45, Math.min(2.4, state.tool === 'crop'
        ? (state.origW || 1) / (state.origH || 1)
        : (state.outW || 1) / (state.outH || 1)));
    wrap().style.aspectRatio = String(ratio);
    const c = canvas();
    c.className = '';
    const t = state.tool;
    if (t === 'move') {
      if (state.mode === 'crop') c.classList.add('draggable');
    } else if (isPaintTool()) {
      c.classList.add('tool-paint');
    } else if (t === 'pick') {
      c.classList.add('tool-pick');
    } else if (t === 'crop') {
      c.classList.add('tool-crop');
    } else if (t === 'remove') {
      c.classList.add('tool-remove');
    }
    updateBrushCursor();
  }

  N4DU.editorCanvas = {
    initEditorCanvas, drawEditor, syncCanvasUI, setZoom, updateBrushCursor,
    setToolHandler: (h) => { toolHandler = h; },
    setSelection, getSelection, canvasSize, canvasBox, toImage, toScreen,
    selectionRect: selectionOnScreen,
  };

})(window.N4DU ??= {});
