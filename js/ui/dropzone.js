// Entrada de archivos: arrastrar, clic para elegir y pegar con Ctrl+V.
(function (N4DU) {

  const { ACCEPT } = N4DU.loader;

  let acceptFile = null;
  let pick = null; // cómo elegir archivo: selector del navegador o diálogo nativo

  function initDropzone(onFile, pickImpl) {
    // No se filtra por extensión a propósito: el formato se decide leyendo
    // el contenido, así que un JPEG con extensión rara (.jfif, .foto…) abre
    // igual. Si de verdad no es una imagen, el decodificador lo dirá.
    acceptFile = (file) => { if (file) onFile(file); };
    pick = pickImpl || openPicker;
    const dz = document.getElementById('dropzone');

    dz.addEventListener('dragenter', e => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));

    // Soltar en cualquier parte de la ventana funciona (comodidad de
    // escritorio). Un solo manejador en window cubre también la caja: si
    // además se escuchara en la caja, un archivo soltado ahí se cargaría
    // dos veces por el burbujeo.
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => {
      e.preventDefault();
      dz.classList.remove('over');
      acceptFile(e.dataTransfer?.files[0]);
    });

    dz.addEventListener('click', () => pick());
    document.getElementById('btnChange').addEventListener('click', () => pick());

    // Pegar una imagen desde el portapapeles (Ctrl+V en cualquier parte).
    // Manda el contenido, no el foco: si en el portapapeles hay una imagen
    // se carga (pegarla en un campo de texto no haría nada útil); si hay
    // texto, no se toca y el campo lo recibe normalmente.
    window.addEventListener('paste', e => {
      const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
      if (item) {
        e.preventDefault();
        acceptFile(item.getAsFile());
      }
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
