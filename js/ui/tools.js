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

  // ── Setup ─────────────────────────────────────────────────────────

  function initTools(onChange) {
    refresh = onChange;

    // Tool selection
    document.querySelectorAll('#toolGrid .tool').forEach(btn => {
      btn.addEventListener('click', () => selectTool(btn.dataset.tool));
    });

    // Options
    bindRange('brushSize', 'brushSizeVal', v => `${v} px`, v => state.brushSize = v);
    bindRange('blurRadius', 'blurRadiusVal', v => `${v} px`, v => state.blurRadius = v);
    bindRange('tolerance', 'toleranceVal', v => `${v}%`, v => state.tolerance = v);

    $('brushColor').addEventListener('input', e => {
      state.brushColor = e.target.value;
      $('brushColorHex').textContent = e.target.value;
    });
    $('contiguous').addEventListener('change', e => {
      state.contiguous = e.target.checked;
    });

    // Crop actions
    $('cropApply').addEventListener('click', applyCrop);
    $('cropCancel').addEventListener('click', () => {
      setSelection(null);
      syncTools();
      drawEditor();
    });

    // Transform
    $('rotL').addEventListener('click', () => geometryOp(() => edit.rotate(-90)));
    $('rotR').addEventListener('click', () => geometryOp(() => edit.rotate(90)));
    $('flipH').addEventListener('click', () => geometryOp(() => edit.flip('h'), true));
    $('flipV').addEventListener('click', () => geometryOp(() => edit.flip('v'), true));
    $('blurAll').addEventListener('click', () => {
      edit.blurAll(state.blurRadius);
      toast(`Blurred the whole image (${state.blurRadius} px)`, 'ok');
    });

    // History
    $('btnUndo').addEventListener('click', () => {
      if (!edit.undo()) return;
      afterHistory();
    });
    $('btnRedo').addEventListener('click', () => {
      if (!edit.redo()) return;
      afterHistory();
    });
    $('btnRevert').addEventListener('click', () => {
      if (!state.img) return;
      edit.revert(state.img);
      afterHistory();
      toast('All edits discarded', 'ok');
    });

    setToolHandler({ down: onDown, move: onMove, up: onUp });
  }

  function bindRange(id, valId, fmt, apply) {
    const el = $(id);
    el.addEventListener('input', e => {
      const v = parseInt(e.target.value, 10);
      apply(v);
      $(valId).textContent = fmt(v);
    });
  }

  function selectTool(tool) {
    state.tool = tool;
    if (tool !== 'crop') setSelection(null);
    refresh();
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
        const ok = edit.removeColor(pt.x, pt.y, state.tolerance, state.contiguous);
        toast(ok
          ? (state.contiguous ? 'Removed the connected area' : 'Removed that colour everywhere')
          : 'Nothing matched at that spot — try a higher tolerance', ok ? 'ok' : 'err');
        return true;
      }

      case 'pick': {
        const hex = edit.pickColor(pt.x, pt.y);
        if (hex) {
          state.brushColor = hex;
          $('brushColor').value = hex;
          $('brushColorHex').textContent = hex;
          toast(`Colour picked: ${hex}`, 'ok');
          selectTool('brush');
        }
        return true;
      }
    }
    return false;
  }

  function onMove(e, pt) {
    if (stroke) {
      stroke.push(pt);
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
      refresh();          // update preview and estimated size once
      return true;
    }
    if (cropStart) {
      cropStart = null;
      syncCropButtons();
      return true;
    }
    return false;
  }

  // Draws the stroke so far. Only the canvas is repainted while drawing:
  // re-encoding the preview on every pointer move would stutter.
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
      toast('That selection is too small', 'err');
      return;
    }
    setSelection(null);
    N4DU.syncToSurface(edit.width(), edit.height());
    selectTool('move');
    toast(`Cropped to ${edit.width()}×${edit.height()} px`, 'ok');
  }

  // Runs an operation that may change the pixel dimensions.
  function geometryOp(fn, keepOutput = false) {
    fn();
    N4DU.syncToSurface(edit.width(), edit.height(), keepOutput);
    setSelection(null);
    refresh();
  }

  function afterHistory() {
    N4DU.syncToSurface(edit.width(), edit.height(), true);
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

    $('toolHint').textContent = HINTS[state.tool] || '';
    $('brushColor').value = state.brushColor;
    $('brushColorHex').textContent = state.brushColor;
    $('contiguous').checked = state.contiguous;

    syncCropButtons();
    syncHistoryButtons();
  }

  const HINTS = {
    move:   'Drag to move the view; scroll to zoom.',
    crop:   'Drag a rectangle over the image, then Apply crop.',
    brush:  'Drag to paint. Use Pick to sample a colour from the image.',
    blur:   'Drag to blur only what you cover.',
    erase:  'Drag to erase to transparency (keep PNG or WEBP to preserve it).',
    remove: 'Click the colour to remove. Connected area only keeps the same colour elsewhere.',
    pick:   'Click the image to sample a colour into the brush.',
  };

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

  N4DU.tools = { initTools, syncTools, selectTool };

})(window.N4DU ??= {});
