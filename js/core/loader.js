// Decodificación de archivos de imagen a ImageBitmap.
(function (N4DU) {

  // Extensiones aceptadas en el selector de archivos. La decodificación real
  // no depende de la extensión: el navegador identifica el formato por los
  // bytes del archivo, así que un JPEG renombrado a .jfif o .cualquiercosa
  // se abre igual.
  const EXTENSIONS = [
    // JPEG y sus mil variantes
    'jpg', 'jpeg', 'jpe', 'jif', 'jfif', 'jfi', 'pjpeg', 'pjp',
    // PNG / APNG
    'png', 'apng',
    // Modernos
    'webp', 'avif', 'avifs', 'jxl',
    // Clásicos
    'gif', 'bmp', 'dib', 'ico', 'cur',
    // Vectorial (se rasteriza)
    'svg',
    // Otros que algunos navegadores decodifican
    'tif', 'tiff', 'heic', 'heif', 'jp2', 'j2k', 'jpx',
  ];

  const NAME_RE = new RegExp('\\.(' + EXTENSIONS.join('|') + ')$', 'i');

  // Lista para el atributo accept del <input type=file>.
  const ACCEPT = 'image/*,' + EXTENSIONS.map(e => '.' + e).join(',');

  function isImageFile(file) {
    return /^image\//i.test(file.type) || NAME_RE.test(file.name);
  }

  // Decodifica cualquier formato que el navegador entienda.
  // createImageBitmap cubre los rasterizados; el fallback con <img>
  // rasteriza SVG y otros casos que createImageBitmap rechaza.
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

  // Mensaje de error específico según la extensión que falló.
  function decodeErrorMessage(file) {
    const ext = (file.name.match(/\.([^.]+)$/) || [])[1]?.toLowerCase();
    if (ext === 'heic' || ext === 'heif')
      return 'HEIC/HEIF no es compatible con este navegador. Convertila primero a JPG desde tu teléfono o con otra herramienta.';
    if (ext === 'tif' || ext === 'tiff')
      return 'TIFF no es compatible con este navegador.';
    return `No se pudo decodificar el archivo${ext ? ` (.${ext})` : ''}. ¿Es realmente una imagen?`;
  }

  N4DU.loader = { EXTENSIONS, ACCEPT, isImageFile, loadImage, decodeErrorMessage };

})(window.N4DU ??= {});
