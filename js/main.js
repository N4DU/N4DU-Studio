// N4DU Studio — punto de entrada. Carga la imagen y coordina los módulos.
// El procesamiento pesado corre en el backend (server.py); este archivo
// arma la interfaz y delega en la API.
(function (N4DU) {

  const { state, resetForImage, buildParams, toast } = N4DU;
  const { loadImage, decodeErrorMessage } = N4DU.loader;
  const { api } = N4DU;
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
    let bmp;
    try {
      bmp = await loadImage(file);
    } catch {
      toast(decodeErrorMessage(file), 'err');
      return;
    }
    resetForImage(bmp, file);

    // Subir la imagen al backend (una sola vez) para estimar y exportar.
    try {
      await api.upload(bmp);
    } catch (err) {
      toast(err.message || 'No se pudo conectar con el backend.', 'err');
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
      const { blob, filename } = await api.process(buildParams());
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

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  // Si se abrió el HTML sin el servidor (file://), avisar cómo arrancar.
  function checkBackend() {
    if (api.hasBackend()) return;
    const label = document.getElementById('titleFile');
    label.textContent = 'Iniciá con start.bat (Windows) o start.command (Mac/Linux)';
    label.style.color = 'var(--danger)';
    const dz = document.getElementById('dropzone');
    dz.querySelector('.drop-label').textContent = 'Falta iniciar el servidor';
    dz.querySelector('.drop-sub').textContent =
      'Cerrá esta pestaña y abrí N4DU Studio con el lanzador (start.bat / start.command).';
    dz.style.cursor = 'default';
    dz.style.borderColor = 'var(--danger)';
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
  checkBackend();

})(window.N4DU ??= {});
