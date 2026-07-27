// Decodificación de archivos de imagen a ImageBitmap.

const NAME_RE = /\.(jpe?g|png|webp|avif|bmp|gif|svg|ico)$/i;

export function isImageFile(file) {
  return /^image\//i.test(file.type) || NAME_RE.test(file.name);
}

// Decodifica cualquier formato que el navegador entienda.
// createImageBitmap cubre los rasterizados; el fallback con <img>
// rasteriza SVG y otros casos que createImageBitmap rechaza.
export async function loadImage(file) {
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
