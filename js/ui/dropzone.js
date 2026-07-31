// File input: drag & drop, click to browse, and Ctrl+V paste.
// Everything here hands over a LIST of files. The converter takes the whole
// selection; the editor takes the first one.
(function (N4DU) {

  const { ACCEPT } = N4DU.loader;

  let acceptFiles = null;
  let pick = null; // how to browse: browser picker or the native dialog

  function initDropzone(onFiles, pickImpl) {
    // Deliberately no extension filter: the format is decided by reading
    // the content, so a JPEG with an odd extension (.jfif, .foto…) still
    // opens. If it really is not an image, the decoder will say so.
    acceptFiles = (files) => {
      const list = [...(files || [])].filter(Boolean);
      if (list.length) onFiles(list);
    };
    pick = pickImpl || openPicker;

    for (const id of ['dropzone', 'convertDrop']) {
      const zone = document.getElementById(id);
      if (!zone) continue;
      zone.addEventListener('dragenter', e => { e.preventDefault(); zone.classList.add('over'); });
      zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('over'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('over'));
      zone.addEventListener('click', () => pick());
    }

    // Dropping anywhere in the window works (desktop convenience). A single
    // handler on window also covers the drop zones: listening on both would
    // load files dropped on a zone twice, through event bubbling.
    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => {
      e.preventDefault();
      document.querySelectorAll('.over').forEach(el => el.classList.remove('over'));
      acceptFiles(e.dataTransfer?.files);
    });

    document.getElementById('btnChange').addEventListener('click', () => pick());

    // Paste images from the clipboard (Ctrl+V anywhere).
    // Content wins over focus: if the clipboard holds an image it is loaded
    // (pasting it into a text field would do nothing useful); if it holds
    // text, this stays out of the way and the field receives it.
    window.addEventListener('paste', e => {
      const files = [...(e.clipboardData?.items || [])]
        .filter(i => i.type.startsWith('image/'))
        .map(i => i.getAsFile())
        .filter(Boolean);
      if (files.length) {
        e.preventDefault();
        acceptFiles(files);
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
      inp.multiple = true;      // a converter is for batches
      inp.style.display = 'none';
      inp.addEventListener('change', () => {
        acceptFiles(inp.files);
        inp.value = ''; // allows re-opening the same file
      });
      document.body.appendChild(inp);
    }
    inp.click();
  }

  N4DU.dropzone = { initDropzone, openPicker };

})(window.N4DU ??= {});
