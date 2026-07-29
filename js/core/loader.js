// Decoding image files into an ImageBitmap.
(function (N4DU) {

  // Extensions offered in the file dialog. Decoding does not depend on the
  // extension: the browser identifies the format from the file's bytes, so a
  // JPEG renamed to .jfif — or to anything else — still opens.
  const EXTENSIONS = [
    // JPEG and its many variants
    'jpg', 'jpeg', 'jpe', 'jif', 'jfif', 'jfi', 'pjpeg', 'pjp',
    // PNG / APNG
    'png', 'apng',
    // Modern formats
    'webp', 'avif', 'avifs', 'jxl',
    // Classic formats
    'gif', 'bmp', 'dib', 'ico', 'cur',
    // Vector (rasterised on load)
    'svg',
    // Others some browsers can decode
    'tif', 'tiff', 'heic', 'heif', 'jp2', 'j2k', 'jpx',
  ];

  // Value for the file input's accept attribute. It only guides the dialog:
  // the app accepts any file and decides by content.
  const ACCEPT = 'image/*,' + EXTENSIONS.map(e => '.' + e).join(',');

  // Decodes any format the browser understands. createImageBitmap covers
  // raster formats; the <img> fallback rasterises SVG and anything else
  // createImageBitmap rejects.
  async function loadImage(file) {
    try {
      return await createImageBitmap(file);
    } catch {
      return decodeViaElement(file);
    }
  }

  async function decodeViaElement(file) {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const w = img.naturalWidth || 512;
      const h = img.naturalHeight || 512;
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      return canvas.transferToImageBitmap();
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Specific message for the extension that failed to decode.
  function decodeErrorMessage(file) {
    const ext = (file.name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase();
    if (ext === 'heic' || ext === 'heif')
      return 'HEIC/HEIF is not supported by this browser. Convert it to JPG first.';
    if (ext === 'tif' || ext === 'tiff')
      return 'TIFF is not supported by this browser.';
    return `Could not decode this file${ext ? ` (.${ext})` : ''}. Is it really an image?`;
  }

  N4DU.loader = { EXTENSIONS, ACCEPT, loadImage, decodeErrorMessage };

})(window.N4DU ??= {});
