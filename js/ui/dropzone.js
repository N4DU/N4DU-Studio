// File input: drag & drop, click to browse, and Ctrl+V paste.
(function (N4DU) {

  const { ACCEPT } = N4DU.loader;

  let acceptFile = null;
  let pick = null; // how to browse: browser picker or the native dialog

  function initDropzone(onFile, pickImpl) {
    // Deliberately no extension filter: the format is decided by reading
    // the content, so a JPEG with an odd extension (.jfif, .foto…) still
    // opens. If it really is not an image, the decoder will say so.
    acceptFile = (file) => { if (file) onFile(file); };
    pick = pickImpl || openPicker;
    const dz = document.getElementById('dropzone');

    dz.addEventListener('dragenter', e => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragover',  e => { e.preventDefault(); dz.classList.add('over'); });
    dz.addEventListener('dragleave', () => dz.classList.remove('over'));

    // Dropping anywhere in the window works (desktop convenience). A single
    // handler on window also covers the drop zone: listening on both would
    // load a file dropped on the zone twice, through event bubbling.
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => {
      e.preventDefault();
      dz.classList.remove('over');
      acceptFile(e.dataTransfer?.files[0]);
    });

    dz.addEventListener('click', () => pick());
    document.getElementById('btnChange').addEventListener('click', () => pick());

    // Paste an image from the clipboard (Ctrl+V anywhere).
    // Content wins over focus: if the clipboard holds an image it is loaded
    // (pasting it into a text field would do nothing useful); if it holds
    // text, this stays out of the way and the field receives it.
    window.addEventListener('paste', e => {
      const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
      if (item) {
        e.preventDefault();
        acceptFile(item.getAsFile());
      }
    });
  }

  // Opens the system file dialog. The input lives in the DOM instead of
  // being recreated per click: some browsers ignore click() on a freshly
  // created input and the dialog never appears.
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
        inp.value = ''; // allows re-opening the same file
      });
      document.body.appendChild(inp);
    }
    inp.click();
  }

  N4DU.dropzone = { initDropzone, openPicker };

})(window.N4DU ??= {});
