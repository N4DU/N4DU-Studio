// N4DU Studio — punto de entrada. Carga la imagen y coordina los módulos.
(function (N4DU) {

  const { state, resetForImage, toast } = N4DU;
  const { loadImage, decodeErrorMessage } = N4DU.loader;
  const { exportBlob, download } = N4DU.exporter;
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
  }

  async function onFile(file) {
    try {
      const bmp = await loadImage(file);
      resetForImage(bmp, file);
    } catch {
      toast(decodeErrorMessage(file), 'err');
      return;
    }

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
      download(blob, filename);
      const kb = blob.size / 1024;
      toast(`Guardado ${filename} · ${kb >= 1024 ? (kb / 1024).toFixed(2) + ' MB' : kb.toFixed(0) + ' KB'}`, 'ok');
    } catch (err) {
      toast('Error al exportar: ' + err.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = '⬇ Exportar';
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
    if (k === 'o') { e.preventDefault(); openPicker(); }
    if ((k === 's' || k === 'e') && state.img) { e.preventDefault(); onExport(); }
  });

  initDropzone(onFile);
  initEditorCanvas(refresh);
  initControls(refresh);
  document.getElementById('btnExport').addEventListener('click', onExport);

})(window.N4DU ??= {});
