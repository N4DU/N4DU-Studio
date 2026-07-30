// Tool palette: selection, per-tool options, pointer handling and the
// transform / history actions. Pixel work is delegated to N4DU.edit.
(function (N4DU) {

  const { state, toast } = N4DU;
  const { edit } = N4DU;
  const { setToolHandler, setSelection, getSelection, drawEditor } = N4DU.editorCanvas;

  const $ = (id) => document.getElementById(id);

  let refresh = null;         // repaints the whole UI
  let stroke = null;          // points of the stroke in progress
  let cropStart = null;       // origin of the crop rectangle being dragged

  // What each tool does, shown above the picture at all times. This line is
  // the main reason the app can be used without reading anything else.
  const INSTRUCTIONS = {
    move:   'Drag the picture to reposition it · scroll to zoom',
    crop:   'Drag a box over the part you want to keep, then press <b>Apply</b>',
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
    blur: 'Blur', erase: 'Eraser', remove: 'Cut colour', pick: 'Colour picker',
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
      setSelection(null);
      syncTools();
      drawEditor();
    });

    $('rotL').addEventListener('click', () => geometryOp(() => edit.rotate(-90)));
    $('rotR').addEventListener('click', () => geometryOp(() => edit.rotate(90)));
    $('flipH').addEventListener('click', () => geometryOp(() => edit.flip('h'), true));
    $('flipV').addEventListener('click', () => geometryOp(() => edit.flip('v'), true));

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
    if (tool !== 'crop') setSelection(null);
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

      case 'crop':
        cropStart = pt;
        setSelection({ x: pt.x, y: pt.y, w: 0, h: 0 });
        return true;

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
    if (cropStart) {
      setSelection(normalizeRect(cropStart, pt));
      syncCropButtons();
      drawEditor();
      return true;
    }
    return false;
  }

  function onUp() {
    if (stroke) {
      stroke = null;
      refresh();          // update the preview and estimated size once
      return true;
    }
    if (cropStart) {
      cropStart = null;
      syncCropButtons();
      return true;
    }
    return false;
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

  function normalizeRect(a, b) {
    return {
      x: Math.min(a.x, b.x),
      y: Math.min(a.y, b.y),
      w: Math.abs(b.x - a.x),
      h: Math.abs(b.y - a.y),
    };
  }

  // ── Actions ───────────────────────────────────────────────────────

  function applyCrop() {
    const sel = getSelection();
    if (!sel || sel.w < 2 || sel.h < 2) return;
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
    N4DU.syncToSurface(edit.width(), edit.height(), true);
    setSelection(null);
    refresh();
  }

  // Runs an operation that may change the pixel dimensions.
  function geometryOp(fn, keepOutput = false) {
    fn();
    N4DU.syncToSurface(edit.width(), edit.height(), keepOutput);
    setSelection(null);
    refresh();
  }

  // ── UI sync ───────────────────────────────────────────────────────

  function syncTools() {
    document.querySelectorAll('#toolGrid .tool').forEach(b =>
      b.classList.toggle('active', b.dataset.tool === state.tool));

    // Show only the option blocks that list the active tool.
    document.querySelectorAll('#toolOptions .opt').forEach(el => {
      const tools = (el.dataset.for || '').split(/\s+/);
      el.classList.toggle('visible', tools.includes(state.tool));
    });

    $('optionsTitle').textContent = OPTION_TITLES[state.tool] || 'Options';
    $('instruction').innerHTML = INSTRUCTIONS[state.tool] || '';

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
    $('cropApply').disabled = !usable;
    $('cropCancel').disabled = !sel;
  }

  function syncHistoryButtons() {
    $('btnUndo').disabled = !edit.canUndo();
    $('btnRedo').disabled = !edit.canRedo();
  }

  N4DU.tools = { initTools, syncTools, selectTool, withBusy, stepHistory };

})(window.N4DU ??= {});
