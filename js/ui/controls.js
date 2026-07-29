// Output panel: framing, shape, size, format, quality and weight limit.
(function (N4DU) {

  const { state } = N4DU;
  const { shapeLabel } = N4DU.geometry;
  const { FORMATS, detectEncodeSupport, renderAndEncode, exportBlob } = N4DU.exporter;

  const $ = (id) => document.getElementById(id);

  const MAX_SIDE = 8192;   // matches the max attribute on the inputs

  // Returns a valid side (1…MAX_SIDE), or null when there is no number yet
  // (empty field while typing: state is left alone).
  function clampSide(raw) {
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return null;
    return Math.max(1, Math.min(MAX_SIDE, n));
  }

  function setActive(containerId, match) {
    document.querySelectorAll(`#${containerId} .pill`).forEach(b =>
      b.classList.toggle('active', match(b)));
  }

  function initControls(onChange) {
    // ── Framing mode ──
    document.querySelectorAll('#modePills .pill').forEach(btn => {
      btn.addEventListener('click', () => {
        if (state.mode === btn.dataset.mode) return;
        state.mode = btn.dataset.mode;
        if (state.mode === 'crop') {
          state.cx = state.origW / 2;
          state.cy = state.origH / 2;
          state.zoom = 1;
          state.outW = state.outH = 400;
        } else {
          state.outW = state.origW;
          state.outH = state.origH;
        }
        onChange();
      });
    });

    // ── Shape (corner rounding) ──
    $('shapeSlider').addEventListener('input', e => {
      state.roundness = Math.max(0, Math.min(100, parseInt(e.target.value) || 0));
      onChange();
    });
    $('resetShape').addEventListener('click', () => {
      state.roundness = 0;
      onChange();
    });

    // ── Size: percentages (whole-image mode) ──
    document.querySelectorAll('#percentPills .pill').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = parseInt(btn.dataset.pct) / 100;
        state.outW = Math.max(1, Math.round(state.origW * p));
        state.outH = Math.max(1, Math.round(state.origH * p));
        onChange();
      });
    });

    // ── Size: square presets (avatar crop mode) ──
    document.querySelectorAll('#presetPills .pill').forEach(btn => {
      btn.addEventListener('click', () => {
        state.outW = state.outH = parseInt(btn.dataset.size);
        onChange();
      });
    });

    // ── Size: manual fields ──
    // Clamped to MAX_SIDE: a huge value (pasted by accident) would create an
    // impossible canvas and take the page down.
    $('outW').addEventListener('input', e => {
      const w = clampSide(e.target.value);
      if (w === null) return;                 // empty while typing
      state.outW = w;
      if (state.mode === 'crop') state.outH = w;
      else if (state.lockAspect) state.outH = Math.max(1, Math.round(w * state.origH / state.origW));
      onChange();
    });
    $('outH').addEventListener('input', e => {
      const h = clampSide(e.target.value);
      if (h === null) return;
      state.outH = h;
      if (state.mode === 'crop') state.outW = h;
      else if (state.lockAspect) state.outW = Math.max(1, Math.round(h * state.origW / state.origH));
      onChange();
    });
    // Leaving the field normalises whatever was typed.
    $('outW').addEventListener('blur', () => onChange());
    $('outH').addEventListener('blur', () => onChange());
    $('lockBtn').addEventListener('click', () => {
      state.lockAspect = !state.lockAspect;
      $('lockBtn').classList.toggle('active', state.lockAspect);
    });

    // ── Format ──
    document.querySelectorAll('#fmtPills .pill').forEach(btn => {
      btn.addEventListener('click', () => {
        state.fmt = btn.dataset.fmt;
        onChange();
      });
    });
    $('qualityVal').addEventListener('input', e => {
      state.quality = Math.max(1, Math.min(100, parseInt(e.target.value) || 92)) / 100;
      onChange();
    });
    $('maxKb').addEventListener('input', e => {
      state.maxKb = e.target.value ? Math.max(1, parseInt(e.target.value)) : null;
      onChange();
    });

    // Hide formats this browser cannot encode. If the selected format is
    // among them, fall back to PNG (supported everywhere) so the state never
    // points at a dead format.
    detectEncodeSupport().then(support => {
      document.querySelectorAll('#fmtPills .pill').forEach(btn => {
        if (!support[btn.dataset.fmt]) btn.style.display = 'none';
      });
      if (!support[state.fmt]) {
        state.fmt = 'png';
        onChange();
      }
    });
  }

  // Mirrors state into the controls (active pills, fields, hints).
  function syncControls() {
    setActive('modePills', b => b.dataset.mode === state.mode);
    setActive('fmtPills',  b => b.dataset.fmt === state.fmt);
    setActive('percentPills', b =>
      Math.round(state.origW * parseInt(b.dataset.pct) / 100) === state.outW &&
      Math.round(state.origH * parseInt(b.dataset.pct) / 100) === state.outH);
    setActive('presetPills', b =>
      parseInt(b.dataset.size) === state.outW && state.outW === state.outH);

    $('percentPills').style.display = state.mode === 'original' ? 'flex' : 'none';
    $('presetPills').style.display  = state.mode === 'crop' ? 'flex' : 'none';
    $('lockBtn').style.visibility   = state.mode === 'original' ? 'visible' : 'hidden';
    $('lockBtn').classList.toggle('active', state.lockAspect);

    $('outW').value = state.outW;
    $('outH').value = state.outH;

    $('shapeSlider').value = state.roundness;
    $('shapeVal').textContent = shapeLabel(state);

    $('qualityRow').style.display = FORMATS[state.fmt].lossy ? 'flex' : 'none';

    $('modeHint').textContent = state.mode === 'original'
      ? 'Exports the whole image at its own aspect ratio.'
      : 'Drag to move the framing; wheel or slider to zoom; arrow keys to nudge.';

    const hints = [];
    if (!FORMATS[state.fmt].alpha && state.roundness > 0)
      hints.push(`${FORMATS[state.fmt].label} has no transparency: outside the shape the background will be white.`);
    if (state.fmt === 'ico')
      hints.push('ICO supports up to 256×256 px; larger sizes are scaled down.');
    $('fmtHint').textContent = hints.join(' ');
  }

  // Size estimate (async and debounced: encoding costs CPU).
  // With a limit set, the REAL compressed file is computed, so what is shown
  // is what you get — and when the limit cannot be met it says so instead of
  // promising it.
  let estimateTimer = null;
  let estimateSeq = 0;

  function updateEstimate() {
    const el = $('sizeEstimate');
    if (!state.img) { el.textContent = '—'; el.classList.remove('warn'); return; }
    el.textContent = 'Calculating size…';
    el.classList.remove('warn');
    clearTimeout(estimateTimer);
    const seq = ++estimateSeq;
    estimateTimer = setTimeout(async () => {
      try {
        const withLimit = !!state.maxKb;
        const result = withLimit ? await exportBlob(state) : { blob: await renderAndEncode(state) };
        if (seq !== estimateSeq) return; // stale: a newer estimate is running
        const size = result.blob.size;
        const kb = size / 1024;
        const label = kb >= 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(1) + ' KB';
        if (withLimit && result.limit && !result.limit.ok) {
          el.textContent = `Size: ${label} — cannot get under ${state.maxKb} KB`;
          el.classList.add('warn');
        } else {
          el.textContent = `Size: ${label}`;
        }
      } catch {
        if (seq === estimateSeq) el.textContent = '—';
      }
    }, 350);
  }

  N4DU.controls = { initControls, syncControls, updateEstimate };

})(window.N4DU ??= {});
