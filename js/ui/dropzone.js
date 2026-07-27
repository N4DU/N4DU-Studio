// Entrada de archivos: arrastrar, clic para elegir y pegar con Ctrl+V.

import { isImageFile } from '../core/loader.js';
import { toast } from './toast.js';

export function initDropzone(onFile) {
  const dz = document.getElementById('dropzone');

  const accept = (file) => {
    if (!file) return;
    if (!isImageFile(file)) { toast('Formato no soportado', 'err'); return; }
    onFile(file);
  };

  dz.addEventListener('dragenter', e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('over'); });
  dz.addEventListener('dragleave', () => dz.classList.remove('over'));
  dz.addEventListener('drop', e => {
    e.preventDefault();
    dz.classList.remove('over');
    accept(e.dataTransfer.files[0]);
  });

  dz.addEventListener('click', () => pickFile(accept));
  document.getElementById('btnChange').addEventListener('click', () => pickFile(accept));

  // Pegar una imagen desde el portapapeles
  window.addEventListener('paste', e => {
    const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
    if (item) accept(item.getAsFile());
  });
}

function pickFile(accept) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = 'image/*,.svg,.ico';
  inp.onchange = () => accept(inp.files[0]);
  inp.click();
}
