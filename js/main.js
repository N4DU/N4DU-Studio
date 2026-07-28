// N4DU Studio — punto de entrada. Carga la imagen y coordina los módulos.
// Todo el procesamiento corre en el navegador; si main.py está corriendo,
// el puente (bridge) agrega abrir con diálogo nativo y reemplazar en disco.
(function (N4DU) {

  const { state, resetForImage, toast, bridge } = N4DU;
  const { loadImage, decodeErrorMessage } = N4DU.loader;
  const { exportBlob, download } = N4DU.exporter;
  const { initDropzone, openPicker } = N4DU.dropzone;
  const { initEditorCanvas, drawEditor, syncCanvasUI } = N4DU.editorCanvas;
  const { initControls, syncControls, updateEstimate } = N4DU.controls;
  const { drawThumb } = N4DU.previews;
  const { initReplaceDialog, open: openReplaceDialog, redraw: redrawReplaceThumb, refresh: refreshReplaceModal } = N4DU.replaceDialog;

  // Redibuja todo lo que depende del estado. Es el único callback que los
  // módulos de UI necesitan conocer.
  function refresh() {
    if (!state.img) return;
    syncControls();
    syncCanvasUI();
    drawEditor();
    drawThumb();
    updateEstimate();
    syncButtons();
    // Si el diálogo de reemplazo está abierto, mantené su vista al día.
    if (!document.getElementById('replaceModal').hidden) {
      redrawReplaceThumb();
      refreshReplaceModal();
    }
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
    // en disco: se limpia el objetivo de reemplazo (se elegirá en el diálogo).
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

  // Botón "Descargar": siempre baja el archivo por el navegador.
  async function onDownload() {
    if (!state.img) return;
    const btn = document.getElementById('btnExport');
    btn.disabled = true;
    btn.textContent = 'Procesando…';
    try {
      const { blob, filename } = await exportBlob(state);
      download(blob, filename);
      const kb = blob.size / 1024;
      const peso = kb >= 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(0) + ' KB';
      toast(`Descargado ${filename} · ${peso}`, 'ok');
    } catch (err) {
      toast('Error al exportar: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '⬇ Descargar';
    }
  }

  // Muestra/oculta el botón Reemplazar según haya puente e imagen.
  function syncButtons() {
    const btn = document.getElementById('btnReplace');
    const show = bridge.active;
    btn.hidden = !show;
    btn.disabled = !(show && state.img);
  }

  // Tras un reemplazo: el título pasa a reflejar el nuevo archivo en disco.
  function afterReplace(out) {
    document.getElementById('titleFile').textContent =
      `${out.name} — ${state.origW}×${state.origH} px`;
    syncButtons();
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
    if ((k === 's' || k === 'e') && state.img) { e.preventDefault(); onDownload(); }
    // Ctrl+R: abrir el diálogo de reemplazo (si hay puente e imagen)
    if (k === 'r' && bridge.active && state.img) { e.preventDefault(); openReplaceDialog(); }
  });

  initDropzone(onFile, chooseFile);
  initEditorCanvas(refresh);
  initControls(refresh);
  initReplaceDialog(afterReplace);
  document.getElementById('btnExport').addEventListener('click', onDownload);
  document.getElementById('btnReplace').addEventListener('click', openReplaceDialog);
  bridge.init().then(syncButtons);

})(window.N4DU ??= {});
