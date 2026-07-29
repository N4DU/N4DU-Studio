// Diálogo de reemplazo: muestra qué archivo del disco se sustituye por cuál,
// con miniaturas estilo Windows y el nombre del resultado editable.
// Solo se usa cuando el puente (main.py) está activo.
(function (N4DU) {

  const { state, toast, bridge } = N4DU;
  const { loadImage } = N4DU.loader;
  const { exportBlob, FORMATS, outputDims } = N4DU.exporter;
  const { renderOutput } = N4DU.render;

  const $ = (id) => document.getElementById(id);

  // Miniatura del archivo que será reemplazado (bytes reales del disco).
  let srcBitmap = null;
  let onDone = null; // callback tras un reemplazo exitoso

  function initReplaceDialog(afterReplace) {
    onDone = afterReplace;
    $('btnReplaceCancel').addEventListener('click', close);
    $('btnPickTarget').addEventListener('click', chooseTarget);
    $('btnReplaceConfirm').addEventListener('click', confirm);
    $('dstStem').addEventListener('input', syncModal);

    // Cerrar con Escape o clic en el fondo
    $('replaceModal').addEventListener('click', e => {
      if (e.target === $('replaceModal')) close();
    });
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !$('replaceModal').hidden) close();
    });
  }

  async function open() {
    if (!state.img) return;
    srcBitmap = null;

    // Nombre por defecto del resultado: el del archivo a reemplazar si ya
    // hay uno elegido; si no, el de la imagen de trabajo.
    const stem = bridge.canReplace()
      ? baseName(bridge.path).replace(/\.[^.]+$/, '')
      : state.fileName;
    $('dstStem').value = stem;

    $('replaceModal').hidden = false;
    paintSource();      // nombre y estado (vacío/lleno) al instante…
    drawDestThumb();
    syncModal();
    await loadSourceThumb();  // …y la miniatura del origen cuando llegue
  }

  function close() {
    $('replaceModal').hidden = true;
    releaseSource();
  }

  // Elegir (o cambiar) el archivo del disco a reemplazar.
  async function chooseTarget() {
    try {
      const picked = await bridge.pickTarget();
      if (!picked) return; // canceló
      // Adoptá el nombre del objetivo elegido (podés editarlo después).
      $('dstStem').value = baseName(picked.path).replace(/\.[^.]+$/, '');
      paintSource();        // nombre y botón al instante…
      syncModal();
      await loadSourceThumb();  // …y la miniatura cuando llegue
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  // Carga los bytes del archivo a reemplazar y arma su miniatura.
  async function loadSourceThumb() {
    releaseSource();
    if (!bridge.canReplace()) return;
    try {
      const blob = await bridge.readCurrent();
      srcBitmap = await loadImage(new File([blob], baseName(bridge.path)));
    } catch {
      srcBitmap = null; // no se pudo previsualizar; igual se puede reemplazar
    }
    paintSource();
  }

  // Libera la miniatura anterior (retiene memoria de imagen decodificada).
  function releaseSource() {
    if (srcBitmap && typeof srcBitmap.close === 'function') srcBitmap.close();
    srcBitmap = null;
  }

  function paintSource() {
    const doc = $('srcDoc');
    const name = $('srcName');
    if (bridge.canReplace()) {
      doc.classList.remove('empty');
      name.textContent = baseName(bridge.path);
      if (srcBitmap) fitInto($('srcThumb'), srcBitmap);
      else clearCanvas($('srcThumb'));
    } else {
      doc.classList.add('empty');
      name.textContent = 'Ningún archivo elegido';
      clearCanvas($('srcThumb'));
    }
  }

  // Miniatura del resultado: refleja recorte, forma, tamaño real (con el
  // recorte a 256 del ICO) y el fondo del formato elegido.
  function drawDestThumb() {
    const MAX = 88;
    const { W, H } = outputDims(state);
    const s = Math.min(MAX / W, MAX / H, 1);
    const w = Math.max(1, Math.round(W * s));
    const h = Math.max(1, Math.round(H * s));
    const bg = FORMATS[state.fmt].alpha ? null : '#ffffff';
    const out = renderOutput(state, w, h, bg);
    const c = $('dstThumb');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(out, 0, 0);
  }

  function syncModal() {
    paintSource();
    const ext = FORMATS[state.fmt].ext;
    $('dstExt').textContent = '.' + ext;

    const stem = cleanStem($('dstStem').value);
    const canDo = bridge.canReplace() && stem.length > 0;
    $('btnReplaceConfirm').disabled = !canDo;

    const hint = $('replaceModalHint');
    if (!bridge.canReplace()) {
      hint.textContent = 'Elegí el archivo del disco que será reemplazado.';
    } else {
      const from = baseName(bridge.path);
      const to = stem + '.' + ext;
      hint.textContent = from === to
        ? `Se sobreescribirá ${from}.`
        : `${from}  →  ${to}   (el archivo anterior se elimina)`;
    }
  }

  async function confirm() {
    const stem = cleanStem($('dstStem').value);
    if (!bridge.canReplace() || !stem) return;
    const btn = $('btnReplaceConfirm');
    btn.disabled = true;
    btn.textContent = 'Reemplazando…';
    try {
      const { blob, limit } = await exportBlob(state);
      const ext = FORMATS[state.fmt].ext;
      let out;
      try {
        out = await bridge.replaceOriginal(blob, ext, stem);
      } catch (err) {
        // El destino ya existe y es otro archivo: el servidor no pisa nada
        // sin permiso, así que se pregunta antes de destruirlo.
        if (!err.conflict) throw err;
        const ok = window.confirm(
          `Ya existe "${err.conflict}" en esa carpeta.\n\n` +
          `Si continuás, ese archivo se reemplaza por el nuevo y ` +
          `"${baseName(bridge.path)}" se elimina.\n\n¿Continuar?`);
        if (!ok) { toast('Reemplazo cancelado', ''); return; }
        out = await bridge.replaceOriginal(blob, ext, stem, true);
      }
      const kb = blob.size / 1024;
      const peso = kb >= 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(0) + ' KB';
      close();
      if (limit && !limit.ok) {
        toast(`Reemplazado ${out.name} · ${peso} — no se pudo bajar de ${limit.maxKb} KB`, 'err');
      } else if (out.warning) {
        toast(`Reemplazado ${out.name} · ${peso} — ${out.warning}`, 'err');
      } else {
        toast(`Reemplazado en disco: ${out.name} · ${peso}`, 'ok');
      }
      if (onDone) onDone(out);
    } catch (err) {
      toast('Error al reemplazar: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '⇄ Reemplazar';
    }
  }

  // ── Utilidades ──
  function baseName(p) { return (p || '').split(/[\\/]/).pop(); }

  // Quita caracteres inválidos para nombres de archivo en Windows/Unix.
  function cleanStem(s) {
    return (s || '').replace(/[\\/:*?"<>|]/g, '').replace(/^\.+/, '').trim();
  }

  function fitInto(canvas, bitmap) {
    const MAX_W = 72, MAX_H = 88;
    const s = Math.min(MAX_W / bitmap.width, MAX_H / bitmap.height, 1);
    const w = Math.max(1, Math.round(bitmap.width * s));
    const h = Math.max(1, Math.round(bitmap.height * s));
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
  }

  function clearCanvas(canvas) {
    canvas.width = canvas.height = 1;
    canvas.getContext('2d').clearRect(0, 0, 1, 1);
  }

  N4DU.replaceDialog = { initReplaceDialog, open, refresh: syncModal, redraw: drawDestThumb };

})(window.N4DU ??= {});
