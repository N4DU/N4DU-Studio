// N4DU Studio — punto de entrada. Carga la imagen y coordina los módulos.
// Todo el procesamiento corre en el navegador; si main.py está corriendo,
// el puente (bridge) agrega abrir con diálogo nativo y reemplazar en disco.
(function (N4DU) {

  const { state, resetForImage, toast, bridge } = N4DU;
  const { loadImage, decodeErrorMessage } = N4DU.loader;
  const { exportBlob, download, FORMATS } = N4DU.exporter;
  const { initDropzone, openPicker } = N4DU.dropzone;
  const { initEditorCanvas, drawEditor, syncCanvasUI } = N4DU.editorCanvas;
  const { initControls, syncControls, updateEstimate } = N4DU.controls;
  const { drawThumb } = N4DU.previews;

  // Redibuja todo lo que depende del estado. Es el único callback que los
  // módulos de UI necesitan conocer.
  function refresh() {
    if (!state.img) return;
    syncControls();
    syncCanvasUI();
    drawEditor();
    drawThumb();
    updateEstimate();
    syncSaveUI();
  }

  // Elegir archivo: diálogo nativo si hay puente; si no, el del navegador.
  async function chooseFile() {
    if (bridge.active) {
      try {
        const picked = await bridge.pickFile();
        if (picked) await onFile(picked.file, true);
        return;
      } catch (err) {
        toast(err.message, 'err'); // cae al selector del navegador
      }
    }
    openPicker();
  }

  async function onFile(file, fromBridge = false) {
    try {
      const bmp = await loadImage(file);
      resetForImage(bmp, file);
    } catch {
      toast(decodeErrorMessage(file), 'err');
      return;
    }
    // Si vino por drag & drop / Ctrl+V / selector del navegador no hay ruta
    // en disco, así que no se puede reemplazar.
    if (!fromBridge) bridge.clearFile();

    document.getElementById('fileInfo').innerHTML =
      `<strong>${escapeHtml(file.name)}</strong><br>` +
      `${state.origW} × ${state.origH} px<br>` +
      `${(file.size / 1024).toFixed(0)} KB`;
    document.getElementById('titleFile').textContent =
      `${file.name} — ${state.origW}×${state.origH} px`;

    document.body.classList.add('has-image');
    document.getElementById('btnExport').disabled = false;

    document.getElementById('zoomSlider').value = 1;
    document.getElementById('zoomVal').textContent = '100%';

    refresh();
  }

  async function onExport() {
    if (!state.img) return;
    const btn = document.getElementById('btnExport');
    btn.disabled = true;
    btn.textContent = 'Procesando…';
    try {
      const { blob, filename } = await exportBlob(state);
      const kb = blob.size / 1024;
      const peso = kb >= 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(0) + ' KB';

      if (replaceChecked()) {
        const out = await bridge.replaceOriginal(blob, FORMATS[state.fmt].ext);
        document.getElementById('titleFile').textContent =
          `${out.name} — ${state.origW}×${state.origH} px`;
        toast(`Reemplazado en disco: ${out.name} · ${peso}`, 'ok');
        syncSaveUI();
      } else {
        download(blob, filename);
        toast(`Guardado ${filename} · ${peso}`, 'ok');
      }
    } catch (err) {
      toast('Error al exportar: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '⬇ Exportar';
    }
  }

  // ── Casilla "Reemplazar el archivo original" ──
  function replaceChecked() {
    return bridge.canReplace() && document.getElementById('replaceChk').checked;
  }

  function syncSaveUI() {
    const section = document.getElementById('saveSection');
    if (!bridge.active) { section.style.display = 'none'; return; }
    section.style.display = 'flex';

    const chk = document.getElementById('replaceChk');
    const hint = document.getElementById('replaceHint');
    if (bridge.canReplace()) {
      chk.disabled = false;
      const orig = bridge.path.split(/[\\/]/).pop();
      const dest = orig.replace(/\.[^.]+$/, '') + '.' + FORMATS[state.fmt].ext;
      hint.textContent = chk.checked
        ? (orig === dest ? `Se sobreescribirá ${orig}.` : `${orig} → ${dest} (el original se elimina).`)
        : 'Al exportar, el resultado sustituye al archivo abierto (aunque cambie la extensión).';
    } else {
      chk.disabled = true;
      chk.checked = false;
      hint.textContent = 'Disponible al abrir con el botón 📂 Abrir (con arrastrar o pegar no hay ruta en disco).';
    }
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Atajos de teclado de escritorio
  window.addEventListener('keydown', e => {
    if (!(e.ctrlKey || e.metaKey)) return;
    const k = e.key.toLowerCase();
    if (k === 'o') { e.preventDefault(); chooseFile(); }
    if ((k === 's' || k === 'e') && state.img) { e.preventDefault(); onExport(); }
  });

  initDropzone(onFile, chooseFile);
  initEditorCanvas(refresh);
  initControls(refresh);
  document.getElementById('btnExport').addEventListener('click', onExport);
  document.getElementById('replaceChk').addEventListener('change', syncSaveUI);
  bridge.init().then(syncSaveUI);

})(window.N4DU ??= {});
