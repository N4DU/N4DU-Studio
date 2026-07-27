// Codificación y exportación: formatos, calidad, límite de peso y descarga.
(function (N4DU) {

  const { renderOutput } = N4DU.render;

  const FORMATS = {
    png:  { mime: 'image/png',    ext: 'png',  label: 'PNG',  lossy: false, alpha: true  },
    jpeg: { mime: 'image/jpeg',   ext: 'jpg',  label: 'JPG',  lossy: true,  alpha: false },
    webp: { mime: 'image/webp',   ext: 'webp', label: 'WEBP', lossy: true,  alpha: true  },
    avif: { mime: 'image/avif',   ext: 'avif', label: 'AVIF', lossy: true,  alpha: true  },
    bmp:  { mime: 'image/bmp',    ext: 'bmp',  label: 'BMP',  lossy: false, alpha: false },
    ico:  { mime: 'image/x-icon', ext: 'ico',  label: 'ICO',  lossy: false, alpha: true  },
  };

  const ICO_MAX = 256; // el formato ICO admite hasta 256×256
  const MANUAL = new Set(['ico', 'bmp']); // codificadores propios, siempre disponibles

  // Detecta qué formatos puede CODIFICAR este navegador (decodificar es otra
  // cosa). AVIF, por ejemplo, aún no se codifica en todos.
  async function detectEncodeSupport() {
    const support = {};
    const probe = new OffscreenCanvas(1, 1);
    probe.getContext('2d');
    for (const [key, f] of Object.entries(FORMATS)) {
      if (MANUAL.has(key)) { support[key] = true; continue; }
      try {
        const blob = await probe.convertToBlob({ type: f.mime });
        support[key] = blob.type === f.mime;
      } catch {
        support[key] = false;
      }
    }
    return support;
  }

  // Dimensiones reales de salida (el ICO se limita a 256px).
  function outputDims(state) {
    let W = Math.max(1, Math.round(state.outW));
    let H = Math.max(1, Math.round(state.outH));
    if (state.fmt === 'ico' && (W > ICO_MAX || H > ICO_MAX)) {
      const s = ICO_MAX / Math.max(W, H);
      W = Math.max(1, Math.round(W * s));
      H = Math.max(1, Math.round(H * s));
    }
    return { W, H };
  }

  // Codifica un canvas al formato pedido. Conversión real: se re-codifican
  // los píxeles, no se renombra la extensión.
  async function encodeCanvas(canvas, fmt, quality) {
    const f = FORMATS[fmt];
    if (fmt === 'ico') return encodeIco(canvas);
    if (fmt === 'bmp') return encodeBmp(canvas);
    if (f.lossy) return canvas.convertToBlob({ type: f.mime, quality });
    return canvas.convertToBlob({ type: f.mime });
  }

  // ICO moderno: contenedor ICONDIR + una entrada con la imagen en PNG
  // (válido desde Windows Vista; es lo que usan los favicons actuales).
  async function encodeIco(canvas) {
    const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    const header = new DataView(new ArrayBuffer(22));
    header.setUint16(0, 0, true);                 // reservado
    header.setUint16(2, 1, true);                 // tipo: icono
    header.setUint16(4, 1, true);                 // cantidad de imágenes
    header.setUint8(6, canvas.width  >= 256 ? 0 : canvas.width);   // 0 = 256
    header.setUint8(7, canvas.height >= 256 ? 0 : canvas.height);
    header.setUint8(8, 0);                        // sin paleta
    header.setUint8(9, 0);                        // reservado
    header.setUint16(10, 1, true);                // planos de color
    header.setUint16(12, 32, true);               // bits por píxel
    header.setUint32(14, png.length, true);       // tamaño del PNG
    header.setUint32(18, 22, true);               // offset del PNG
    return new Blob([header.buffer, png], { type: 'image/x-icon' });
  }

  // BMP clásico de 24 bits (BGR, filas alineadas a 4 bytes, bottom-up).
  // Sin canal alfa: el fondo ya viene compuesto sobre blanco.
  function encodeBmp(canvas) {
    const w = canvas.width, h = canvas.height;
    const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const rowSize = Math.ceil((w * 3) / 4) * 4;
    const pixelBytes = rowSize * h;
    const buf = new ArrayBuffer(54 + pixelBytes);
    const dv = new DataView(buf);

    // BITMAPFILEHEADER
    dv.setUint8(0, 0x42); dv.setUint8(1, 0x4D);   // "BM"
    dv.setUint32(2, 54 + pixelBytes, true);       // tamaño total
    dv.setUint32(10, 54, true);                   // offset de píxeles
    // BITMAPINFOHEADER
    dv.setUint32(14, 40, true);
    dv.setInt32(18, w, true);
    dv.setInt32(22, h, true);                     // positivo = bottom-up
    dv.setUint16(26, 1, true);                    // planos
    dv.setUint16(28, 24, true);                   // bits por píxel
    dv.setUint32(34, pixelBytes, true);
    dv.setInt32(38, 2835, true);                  // 72 dpi
    dv.setInt32(42, 2835, true);

    const out = new Uint8Array(buf);
    for (let y = 0; y < h; y++) {
      const src = (h - 1 - y) * w * 4;
      let o = 54 + y * rowSize;
      for (let x = 0; x < w; x++) {
        const i = src + x * 4;
        out[o++] = data[i + 2];  // B
        out[o++] = data[i + 1];  // G
        out[o++] = data[i];      // R
      }
    }
    return Promise.resolve(new Blob([buf], { type: 'image/bmp' }));
  }

  // Renderiza y codifica según el estado actual, sin aplicar límite de peso.
  async function renderAndEncode(state) {
    const { W, H } = outputDims(state);
    const bg = FORMATS[state.fmt].alpha ? null : '#ffffff';
    const canvas = renderOutput(state, W, H, bg);
    return encodeCanvas(canvas, state.fmt, state.quality);
  }

  // Exporta respetando el límite de peso si está definido.
  async function exportBlob(state) {
    let blob = await renderAndEncode(state);
    const limit = state.maxKb ? state.maxKb * 1024 : null;
    if (limit && blob.size > limit) {
      blob = await fitToLimit(state, limit);
    }
    const { W, H } = outputDims(state);
    const filename = `${state.fileName}_${W}x${H}.${FORMATS[state.fmt].ext}`;
    return { blob, filename };
  }

  // Comprime hasta entrar en el límite: primero búsqueda binaria de calidad
  // (formatos con pérdida), después reducción de escala re-renderizando desde
  // la imagen original para no degradar dos veces.
  async function fitToLimit(state, limit) {
    const { W, H } = outputDims(state);
    const f = FORMATS[state.fmt];
    const bg = f.alpha ? null : '#ffffff';

    if (f.lossy) {
      const canvas = renderOutput(state, W, H, bg);
      const found = await binarySearchQuality(canvas, state.fmt, state.quality, limit);
      if (found) return found;
    }

    // Bajar resolución progresivamente (con calidad mínima si es lossy)
    let best = null;
    let scale = 0.9;
    for (let i = 0; i < 14 && Math.min(W, H) * scale >= 16; i++, scale *= 0.82) {
      const w = Math.max(1, Math.round(W * scale));
      const h = Math.max(1, Math.round(H * scale));
      const canvas = renderOutput(state, w, h, bg);
      const blob = f.lossy
        ? (await binarySearchQuality(canvas, state.fmt, state.quality, limit)) ??
          (await encodeCanvas(canvas, state.fmt, 0.05))
        : await encodeCanvas(canvas, state.fmt, state.quality);
      best = blob;
      if (blob.size <= limit) return blob;
    }
    return best; // no se pudo cumplir el límite: se devuelve lo más liviano logrado
  }

  // Mayor calidad posible cuyo peso quede bajo el límite, o null si ni la
  // calidad mínima alcanza.
  async function binarySearchQuality(canvas, fmt, maxQ, limit) {
    let lo = 0.02, hi = maxQ, best = null;
    for (let i = 0; i < 8; i++) {
      const q = (lo + hi) / 2;
      const blob = await encodeCanvas(canvas, fmt, q);
      if (blob.size <= limit) { best = blob; lo = q; }
      else hi = q;
    }
    return best;
  }

  // Dispara la descarga de un blob.
  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  N4DU.exporter = {
    FORMATS, detectEncodeSupport, outputDims,
    encodeCanvas, renderAndEncode, exportBlob, download,
  };

})(window.N4DU ??= {});
