// Entrada de archivos: arrastrar, clic para elegir y pegar con Ctrl+V.
(function (N4DU) {

  const { ACCEPT } = N4DU.loader;

  let acceptFile = null;
  let pick = null; // cómo elegir archivo: selector del navegador o diálogo nativo

  function initDropzone(onFile, pickImpl) {
    acceptFile = (file) => { if (file) onFile(file); };
    pick = pickImpl || openPicker;
    const dz = document.getElementById('dropzone');

    dz.addEventListener('dragenter', e => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));
    dz.addEventListener('drop', e => {
      e.preventDefault();
      dz.classList.remove('over');
      acceptFile(e.dataTransfer.files[0]);
    });

    // Arrastrar sobre cualquier parte de la ventana también funciona
    // (comodidad de escritorio: no hace falta apuntar a la caja).
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => {
      e.preventDefault();
      if (e.dataTransfer.files[0]) acceptFile(e.dataTransfer.files[0]);
    });

    dz.addEventListener('click', () => pick());
    document.getElementById('btnChange').addEventListener('click', () => pick());

    // Pegar una imagen desde el portapapeles
    window.addEventListener('paste', e => {
      const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
      if (item) acceptFile(item.getAsFile());
    });
  }

  // Abre el diálogo de archivos del sistema. El input vive en el DOM (y no
  // se recrea en cada clic): algunos navegadores ignoran el click() de un
  // input recién creado y el diálogo nunca aparece.
  function openPicker() {
    let inp = document.getElementById('filePicker');
    if (!inp) {
      inp = document.createElement('input');
      inp.type = 'file';
      inp.id = 'filePicker';
      inp.accept = ACCEPT;
      inp.style.display = 'none';
      inp.addEventListener('change', () => {
        if (inp.files[0]) acceptFile(inp.files[0]);
        inp.value = ''; // permite reabrir el mismo archivo
      });
      document.body.appendChild(inp);
    }
    inp.click();
  }

  N4DU.dropzone = { initDropzone, openPicker };

})(window.N4DU ??= {});
