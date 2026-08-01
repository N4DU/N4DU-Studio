// Tool palette: selection, per-tool options, pointer handling and the
// transform / history actions. Pixel work is delegated to N4DU.edit.
(function (N4DU) {

  const { state, toast } = N4DU;
  const { edit } = N4DU;
  const { setToolHandler, setSelection, getSelection, drawEditor } = N4DU.editorCanvas;

  const $ = (id) => document.getElementById(id);

  let refresh = null;         // repaints the whole UI
  let stroke = null;          // points of the stroke in progress
  // Crop drag in progress: which handle was grabbed, plus the box and pointer
  // position when the drag started.
  let cropDrag = null;

  // What each tool does, shown above the picture at all times. This line is
  // the main reason the app can be used without reading anything else.
  const INSTRUCTIONS = {
    // Repositioning and zooming only mean anything when the picture is being
    // framed into a shape. In Keep mode the whole picture is the output, so
    // there is nothing to drag and nothing to zoom — promising both was the
    // single most confusing line in the editor.
    move:   'Drag the picture to reposition it · Ctrl+scroll to zoom',
    moveKeep: 'The whole picture is kept as it is. Pick a shape under '
            + '<b>Result</b> to frame part of it instead',
    crop:   'Pull the <b>corners or edges</b> inwards, then press <b>Apply</b>',
    brush:  'Drag to paint · change the colour and size on the left',
    blur:   'Drag over anything you want to blur out',
    erase:  'Drag to rub pixels away, leaving them see-through',
    remove: 'Click the colour you want gone (a background, for example)',
    pick:   'Click any colour to load it into the brush',
  };

  // Plain-word meaning for the blur slider, so the number is not the only clue.
  function blurWord(v) {
    if (v <= 4) return 'subtle';
    if (v <= 12) return 'medium';
    if (v <= 25) return 'strong';
    return 'heavy';
  }

  const OPTION_TITLES = {
    move: 'Move options', crop: 'Crop', brush: 'Brush',
    blur: 'Blur', erase: 'Eraser', remove: 'Cut colour', pick: 'Brush',
  };

  // ── Setup ─────────────────────────────────────────────────────────

  function initTools(onChange) {
    refresh = onChange;

    document.querySelectorAll('#toolGrid .tool').forEach(btn => {
      btn.addEventListener('click', () => selectTool(btn.dataset.tool));
    });

    bindRange('brushSize', 'brushSizeVal', v => `${v} px`, v => state.brushSize = v);
    bindRange('blurRadius', 'blurRadiusVal', v => `${v} px · ${blurWord(v)}`, v => state.blurRadius = v);
    bindRange('tolerance', 'toleranceVal', v => `${v}%`, v => state.tolerance = v);

    // The eyedropper is part of the brush now: press it, click the picture,
    // and the colour lands in the swatch.
    $('btnPick').addEventListener('click', () => {
      state.tool = 'pick';
      refresh();
      toast('Click a colour in the picture', '');
    });

    $('brushColor').addEventListener('input', e => {
      state.brushColor = e.target.value;
      $('brushColorHex').textContent = e.target.value;
    });
    $('contiguous').addEventListener('change', e => {
      state.contiguous = e.target.checked;
      syncTools();
    });

    $('cropApply').addEventListener('click', applyCrop);
    $('cropCancel').addEventListener('click', () => {
      setSelection(N4DU.cropBox.fullBox());
      syncTools();
      drawEditor();
    });

    $('rotL').addEventListener('click', () => geometryOp(() => edit.rotate(-90)));
    $('rotR').addEventListener('click', () => geometryOp(() => edit.rotate(90)));
    $('flipH').addEventListener('click', () => geometryOp(() => edit.flip('h')));
    $('flipV').addEventListener('click', () => geometryOp(() => edit.flip('v')));

    // Blurring a whole picture can take a moment on a large file, so the
    // canvas shows that work is happening instead of appearing frozen.
    $('blurAll').addEventListener('click', () => withBusy(() => {
      edit.blurAll(state.blurRadius);
      toast(`Blurred the whole picture (${blurWord(state.blurRadius)})`, 'ok');
      refresh();
    }));

    // Undo and redo live in the title bar, next to the file name.
    $('btnUndo').addEventListener('click', () => stepHistory(edit.undo));
    $('btnRedo').addEventListener('click', () => stepHistory(edit.redo));

    $('btnRevert').addEventListener('click', () => {
      if (!state.img) return;
      edit.revert(state.img);
      N4DU.syncToSurface(edit.width(), edit.height());
      setSelection(null);
      refresh();
      toast('Back to the picture you opened', 'ok');
    });

    // Any number beside a slider can be typed directly.
    const { makeEditable } = N4DU.editableNumber;
    makeEditable($('brushSizeVal'), $('brushSize'));
    makeEditable($('blurRadiusVal'), $('blurRadius'));
    makeEditable($('toleranceVal'), $('tolerance'));

    setToolHandler({ down: onDown, move: onMove, up: onUp });
  }

  function bindRange(id, valId, fmt, apply) {
    $(id).addEventListener('input', e => {
      const v = parseInt(e.target.value, 10);
      apply(v);
      $(valId).textContent = fmt(v);
      N4DU.editorCanvas.updateBrushCursor();
    });
  }

  function selectTool(tool) {
    state.tool = tool;
    if (tool === 'crop') {
      // Start from a box around the whole picture: pulling it in is more
      // obvious than having to draw a rectangle from nothing.
      setSelection(N4DU.cropBox.fullBox());
    } else {
      setSelection(null);
      document.getElementById('editorCanvas').style.cursor = '';
    }
    refresh();
  }

  // Runs a slow operation with the busy overlay visible. Two frames are
  // yielded first so the overlay actually paints before the work blocks.
  function withBusy(fn) {
    const busy = $('busy');
    busy.hidden = false;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      try { fn(); } finally { busy.hidden = true; }
    }));
  }

  // ── Pointer handling ──────────────────────────────────────────────
  // Each handler returns true when it consumed the event, so the canvas
  // knows not to pan the view as well.

  function onDown(e, pt) {
    switch (state.tool) {
      case 'brush':
      case 'erase':
      case 'blur':
        edit.beginStroke();
        stroke = [pt];
        applyStroke();
        return true;

      case 'crop': {
        const box = N4DU.editorCanvas.selectionRect();
        if (!box) return true;
        const local = N4DU.editorCanvas.toScreen(e);
        const handle = N4DU.cropBox.hitTest(local.x, local.y, box);
        // Clicking well outside the box starts a brand new one.
        if (handle === 'outside') {
          // The picture rarely fills the stage, so a click that begins in the
          // grey letterbox band lands OUTSIDE the picture — a negative x, or
          // one past the last column. resize() clamps every later edge but
          // never that first corner, so the box kept a corner off the picture:
          // the readout said 668×603 and the file that came out was 668×512.
          const M = N4DU.cropBox.MIN_SIZE;
          const inside = {
            x: Math.max(0, Math.min(pt.x, edit.width() - M)),
            y: Math.max(0, Math.min(pt.y, edit.height() - M)),
          };
          setSelection({ x: inside.x, y: inside.y, w: M, h: M });
          cropDrag = { handle: 'se', start: inside, rect: getSelection() };
        } else {
          cropDrag = { handle, start: pt, rect: { ...getSelection() } };
        }
        drawEditor();
        return true;
      }

      case 'remove': {
        // A flood fill over a big picture is not instant.
        withBusy(() => {
          const ok = edit.removeColor(pt.x, pt.y, state.tolerance, state.contiguous);
          toast(ok
            ? (state.contiguous ? 'Cut out the area you clicked' : 'Cut that colour out of the whole picture')
            : 'Nothing matched there — try raising the tolerance', ok ? 'ok' : 'err');
          refresh();
        });
        return true;
      }

      case 'pick': {
        const hex = edit.pickColor(pt.x, pt.y);
        if (hex) {
          state.brushColor = hex;
          $('brushColor').value = hex;
          $('brushColorHex').textContent = hex;
          toast(`Brush colour set to ${hex}`, 'ok');
          selectTool('brush');
        }
        return true;
      }
    }
    return false;
  }

  function onMove(e, pt) {
    if (stroke) {
      // Only the newest segment is drawn (see applyStroke), so keep just the
      // previous point: re-tracing the whole path on every move made long
      // strokes progressively slower.
      const prev = stroke[stroke.length - 1];
      stroke = [prev, pt];
      applyStroke();
      return true;
    }
    if (cropDrag) {
      const dx = pt.x - cropDrag.start.x;
      const dy = pt.y - cropDrag.start.y;
      setSelection(N4DU.cropBox.resize(
        cropDrag.rect, cropDrag.handle, dx, dy,
        { w: state.origW, h: state.origH }));
      syncCropButtons();
      drawEditor();
      return true;
    }
    // Not dragging: show which handle is under the pointer.
    if (state.tool === 'crop') {
      updateCropCursor(e);
      return false;
    }
    return false;
  }

  function onUp() {
    if (stroke) {
      stroke = null;
      // Lets go of the copy the blur brush reads from.
      edit.endStroke();
      refresh();          // update the preview and estimated size once
      return true;
    }
    if (cropDrag) {
      cropDrag = null;
      syncCropButtons();
      return true;
    }
    return false;
  }

  // The pointer becomes a resize arrow near an edge or corner, and a move
  // cross inside the box — the same language a window resize uses.
  function updateCropCursor(e) {
    const canvas = document.getElementById('editorCanvas');
    const box = N4DU.editorCanvas.selectionRect();
    if (!box) { canvas.style.cursor = 'crosshair'; return; }
    const local = N4DU.editorCanvas.toScreen(e);
    const handle = N4DU.cropBox.hitTest(local.x, local.y, box);
    canvas.style.cursor = N4DU.cropBox.CURSORS[handle] || 'crosshair';
  }

  // Draws the newest segment of the stroke. Only the canvas is repainted
  // while drawing: re-encoding the preview on every pointer move would
  // stutter. The brush is opaque, so drawing segment by segment looks
  // identical to tracing the whole path.
  function applyStroke() {
    if (state.tool === 'blur') {
      edit.blurStroke(stroke, { width: state.brushSize, radius: state.blurRadius });
    } else {
      edit.paintStroke(stroke, {
        color: state.brushColor,
        width: state.brushSize,
        mode: state.tool === 'erase' ? 'erase' : 'paint',
      });
    }
    drawEditor();
    syncHistoryButtons();
  }

  // ── Actions ───────────────────────────────────────────────────────

  function applyCrop() {
    const raw = getSelection();
    if (!raw || raw.w < 2 || raw.h < 2) return;
    // Belt and braces: whatever the box says, only pixels that exist can be
    // cropped, and the toast must report what was actually taken.
    const x = Math.max(0, Math.min(raw.x, edit.width() - 1));
    const y = Math.max(0, Math.min(raw.y, edit.height() - 1));
    const sel = { x, y,
                  w: Math.min(raw.w, edit.width() - x),
                  h: Math.min(raw.h, edit.height() - y) };
    if (sel.w < 2 || sel.h < 2) return;
    if (!edit.crop(sel.x, sel.y, sel.w, sel.h)) {
      toast('That box is too small', 'err');
      return;
    }
    setSelection(null);
    N4DU.syncToSurface(edit.width(), edit.height());
    selectTool('move');
    toast(`Cropped to ${edit.width()}×${edit.height()} px`, 'ok');
  }

  // Moves one step through history. Dimensions may change (an undone crop
  // or rotation), so the output size is re-synced without being reset.
  function stepHistory(step) {
    if (!step()) return;
    N4DU.syncToSurface(edit.width(), edit.height());
    setSelection(null);
    refresh();
  }

  // Runs an operation that may change the pixel dimensions.
  function geometryOp(fn) {
    fn();
    N4DU.syncToSurface(edit.width(), edit.height());
    setSelection(null);
    refresh();
  }

  // ── UI sync ───────────────────────────────────────────────────────

  function syncTools() {
    // Picking is a mode of the brush, so the Brush button stays lit.
    const shown = state.tool === 'pick' ? 'brush' : state.tool;
    document.querySelectorAll('#toolGrid .tool').forEach(b =>
      b.classList.toggle('active', b.dataset.tool === shown));
    $('btnPick').classList.toggle('armed', state.tool === 'pick');

    // Show only the option blocks that list the active tool.
    document.querySelectorAll('#toolOptions .opt').forEach(el => {
      const tools = (el.dataset.for || '').split(/\s+/);
      el.classList.toggle('visible', tools.includes(shown));
    });

    $('optionsTitle').textContent = OPTION_TITLES[state.tool] || 'Options';
    const keeping = state.tool === 'move' && state.mode !== 'crop';
    const guide = keeping ? INSTRUCTIONS.moveKeep : INSTRUCTIONS[state.tool];
    $('instruction').innerHTML = guide || '';
    // The options panel said the opposite of the banner above the picture:
    // "drag to reposition it, Ctrl+scroll to zoom" next to "the whole picture
    // is kept as it is". Neither drag nor zoom does anything in Keep mode.
    $('moveHint').textContent = keeping
      ? 'Nothing to set. The whole picture is kept — pick a shape under '
        + 'Result to frame part of it instead.'
      : 'Nothing to set. Drag the picture to reposition it, Ctrl+scroll to zoom.';

    $('brushColor').value = state.brushColor;
    $('brushColorHex').textContent = state.brushColor;
    $('brushSize').value = state.brushSize;
    $('brushSizeVal').textContent = `${state.brushSize} px`;
    $('blurRadius').value = state.blurRadius;
    $('blurRadiusVal').textContent = `${state.blurRadius} px · ${blurWord(state.blurRadius)}`;
    $('tolerance').value = state.tolerance;
    $('toleranceVal').textContent = `${state.tolerance}%`;
    $('contiguous').checked = state.contiguous;
    $('contiguousHint').textContent = state.contiguous
      ? 'The same colour elsewhere in the picture is left alone.'
      : 'That colour will be cut everywhere it appears.';

    syncCropButtons();
    syncHistoryButtons();
    N4DU.editorCanvas.updateBrushCursor();
  }

  function syncCropButtons() {
    const sel = getSelection();
    const usable = !!sel && sel.w >= 2 && sel.h >= 2;
    // Nothing to do when the box still covers the whole picture.
    const trimmed = !!sel && (Math.round(sel.w) < state.origW || Math.round(sel.h) < state.origH);
    $('cropApply').disabled = !(usable && trimmed);
    $('cropCancel').disabled = !trimmed;
    const size = $('cropSize');
    if (size) size.textContent = sel ? `${Math.round(sel.w)} × ${Math.round(sel.h)} px` : '—';
  }

  function syncHistoryButtons() {
    $('btnUndo').disabled = !edit.canUndo();
    $('btnRedo').disabled = !edit.canRedo();
  }

  N4DU.tools = { initTools, syncTools, selectTool, withBusy, stepHistory };

})(window.N4DU ??= {});
