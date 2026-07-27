// Panel de controles: modo, forma, tamaño, formato, calidad y peso.
(function (N4DU) {

  const { state, buildParams } = N4DU;
  const { shapeLabel } = N4DU.geometry;
  const { FORMATS } = N4DU;
  const { api } = N4DU;

  const $ = (id) => document.getElementById(id);

  function setActive(containerId, match) {
    document.querySelectorAll(`#${containerId} .pill`).forEach(b =>
      b.classList.toggle('active', match(b)));
  }

  function initControls(onChange) {
    // ── Modo ──
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

    // ── Forma (redondeo) ──
    $('shapeSlider').addEventListener('input', e => {
      state.roundness = Math.max(0, Math.min(100, parseInt(e.target.value) || 0));
      onChange();
    });
    $('resetShape').addEventListener('click', () => {
      state.roundness = 0;
      onChange();
    });

    // ── Tamaño: porcentajes (modo imagen completa) ──
    document.querySelectorAll('#percentPills .pill').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = parseInt(btn.dataset.pct) / 100;
        state.outW = Math.max(1, Math.round(state.origW * p));
        state.outH = Math.max(1, Math.round(state.origH * p));
        onChange();
      });
    });

    // ── Tamaño: presets cuadrados (modo recorte) ──
    document.querySelectorAll('#presetPills .pill').forEach(btn => {
      btn.addEventListener('click', () => {
        state.outW = state.outH = parseInt(btn.dataset.size);
        onChange();
      });
    });

    // ── Tamaño: campos manuales ──
    $('outW').addEventListener('input', e => {
      const w = parseInt(e.target.value);
      if (!w || w < 1) return;
      state.outW = w;
      if (state.mode === 'crop') state.outH = w;
      else if (state.lockAspect) state.outH = Math.max(1, Math.round(w * state.origH / state.origW));
      onChange();
    });
    $('outH').addEventListener('input', e => {
      const h = parseInt(e.target.value);
      if (!h || h < 1) return;
      state.outH = h;
      if (state.mode === 'crop') state.outW = h;
      else if (state.lockAspect) state.outW = Math.max(1, Math.round(h * state.origW / state.origH));
      onChange();
    });
    $('lockBtn').addEventListener('click', () => {
      state.lockAspect = !state.lockAspect;
      $('lockBtn').classList.toggle('active', state.lockAspect);
    });

    // ── Formato ──
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

    // Ocultar formatos que el backend no puede generar
    if (api.hasBackend()) {
      api.getFormats().then(info => {
        document.querySelectorAll('#fmtPills .pill').forEach(btn => {
          if (!info.support[btn.dataset.fmt]) btn.style.display = 'none';
        });
      }).catch(() => {});
    }
  }

  // Refleja el estado en los controles (pills activos, campos, hints).
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
      ? 'Se exporta la imagen entera, con su proporción original.'
      : 'Arrastrá para mover el encuadre; rueda o slider para el zoom; flechas para ajuste fino.';

    const hints = [];
    if (!FORMATS[state.fmt].alpha && state.roundness > 0)
      hints.push(`El ${FORMATS[state.fmt].label} no admite transparencia: fuera de la forma el fondo será blanco.`);
    if (state.fmt === 'ico')
      hints.push('El formato ICO admite hasta 256×256 px; tamaños mayores se reducen.');
    $('fmtHint').textContent = hints.join(' ');
  }

  // Estimación de peso: la calcula el backend (mismo encoder que la
  // exportación). Con debounce para no saturar en cada cambio de slider.
  let estimateTimer = null;
  let estimateSeq = 0;

  function updateEstimate() {
    const el = $('sizeEstimate');
    if (!state.img || !api.hasSession()) { el.textContent = '—'; return; }
    el.textContent = 'Calculando peso…';
    clearTimeout(estimateTimer);
    const seq = ++estimateSeq;
    estimateTimer = setTimeout(async () => {
      try {
        const size = await api.estimate(buildParams());
        if (seq !== estimateSeq) return; // llegó tarde: hay un cálculo más nuevo
        const kb = size / 1024;
        let txt = `Peso: ${kb >= 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(1) + ' KB'}`;
        if (state.maxKb && size > state.maxKb * 1024)
          txt += ` → se comprimirá a ≤ ${state.maxKb} KB`;
        el.textContent = txt;
      } catch {
        if (seq === estimateSeq) el.textContent = '—';
      }
    }, 300);
  }

  N4DU.controls = { initControls, syncControls, updateEstimate };

})(window.N4DU ??= {});
