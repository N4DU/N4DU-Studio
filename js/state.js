// Central application state. The single place where editing data lives.
// Modules are plain scripts (no ES modules) so the app also works when
// index.html is opened directly from disk.
(function (N4DU) {

  const state = {
    // Loaded image (pristine; edits live on the edit surface)
    img: null,          // ImageBitmap
    origW: 0,           // current surface width  (changes on rotate/crop)
    origH: 0,           // current surface height
    fileName: '',       // name without extension
    fileSize: 0,        // bytes of the original file
    fileLabel: '',      // full original name

    // Framing mode: 'original' (whole image) | 'crop' (square avatar crop)
    mode: 'original',

    // Avatar crop (mode 'crop' only), in surface coordinates
    cx: 0,
    cy: 0,
    zoom: 1,            // 1 = the short side fits the crop exactly

    // Corner rounding: 0 = original shape, 100 = maximum (circle if square)
    roundness: 0,

    // Output
    outW: 0,
    outH: 0,
    lockAspect: true,
    fmt: 'png',
    quality: 0.92,
    maxKb: null,

    // Active tool and its options
    tool: 'move',       // move | crop | brush | blur | erase | remove | pick
    brushColor: '#ff3b3b',
    brushSize: 24,
    blurRadius: 8,
    tolerance: 18,      // colour remover: 0–100
    contiguous: true,   // colour remover: connected region only
  };

  // Resets state for a freshly loaded image.
  function resetForImage(bmp, file) {
    // Release the previous bitmap: it holds decoded image memory that the
    // garbage collector is slow to reclaim.
    if (state.img && state.img !== bmp && typeof state.img.close === 'function') {
      state.img.close();
    }
    state.img = bmp;
    state.origW = bmp.width;
    state.origH = bmp.height;
    state.fileName = file.name.replace(/\.[^.]+$/, '') || 'image';
    state.fileSize = file.size;
    state.fileLabel = file.name;

    state.mode = 'original';
    state.cx = bmp.width / 2;
    state.cy = bmp.height / 2;
    state.zoom = 1;
    state.roundness = 0;

    state.outW = bmp.width;
    state.outH = bmp.height;
    state.lockAspect = true;
    state.tool = 'move';
  }

  // Keeps state in step with the edit surface after an operation that
  // changes the pixel dimensions (rotate, flip, crop).
  // keepOutput = true preserves the chosen output size (e.g. after a flip,
  // where dimensions are unchanged).
  function syncToSurface(w, h, keepOutput = false) {
    const sameSize = state.origW === w && state.origH === h;
    state.origW = w;
    state.origH = h;
    state.cx = w / 2;
    state.cy = h / 2;
    state.zoom = 1;

    if (keepOutput || sameSize) return;
    if (state.mode === 'crop') {
      // Square output: leave the requested size alone.
      return;
    }
    state.outW = w;
    state.outH = h;
  }

  N4DU.state = state;
  N4DU.resetForImage = resetForImage;
  N4DU.syncToSurface = syncToSurface;

})(window.N4DU ??= {});
