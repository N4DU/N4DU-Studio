// N4DU Studio — punto de entrada. Carga la imagen y coordina los módulos.

import { state, resetForImage } from './state.js';
import { loadImage } from './core/loader.js';
import { exportBlob, download } from './core/exporter.js';
import { initDropzone } from './ui/dropzone.js';
import { initEditorCanvas, drawEditor, syncCanvasUI } from './ui/editor-canvas.js';
import { initControls, syncControls, updateEstimate } from './ui/controls.js';
import { drawThumb, drawHero } from './ui/previews.js';
import { toast } from './ui/toast.js';

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
    toast('No se pudo leer la imagen', 'err');
    return;
  }

  document.getElementById('fileInfo').innerHTML =
    `<strong>${escapeHtml(file.name)}</strong><br>` +
    `${state.origW} × ${state.origH} px<br>` +
    `${(file.size / 1024).toFixed(0)} KB`;

  document.getElementById('editor').classList.add('visible');
  document.getElementById('btnExport').classList.add('visible');
  document.getElementById('dropzone').style.display = 'none';

  document.getElementById('zoomSlider').value = 1;
  document.getElementById('zoomVal').textContent = '100%';

  refresh();
  drawHero();
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
    btn.textContent = '⬇ Descargar imagen';
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

initDropzone(onFile);
initEditorCanvas(refresh);
initControls(refresh);
document.getElementById('btnExport').addEventListener('click', onExport);
