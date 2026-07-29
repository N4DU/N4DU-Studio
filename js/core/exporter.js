// Encoding and export: formats, quality, weight limit and download.
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

  const ICO_MAX = 256; // the ICO format allows up to 256×256
  const MANUAL = new Set(['ico', 'bmp']); // hand-written encoders, always available

  // Detects which formats this browser can ENCODE (decoding is a separate
  // matter). AVIF, for instance, cannot be encoded everywhere yet.
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

  // Real output dimensions (ICO is capped at 256px).
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

  // Encodes a canvas to the requested format. This is a real conversion:
  // pixels are re-encoded, not just renamed.
  async function encodeCanvas(canvas, fmt, quality) {
    const f = FORMATS[fmt];
    if (fmt === 'ico') return encodeIco(canvas);
    if (fmt === 'bmp') return encodeBmp(canvas);
    if (f.lossy) return canvas.convertToBlob({ type: f.mime, quality });
    return canvas.convertToBlob({ type: f.mime });
  }

  // Modern ICO: an ICONDIR container holding a single PNG entry (valid
  // since Windows Vista; this is what current favicons use).
  async function encodeIco(canvas) {
    const png = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
    const header = new DataView(new ArrayBuffer(22));
    header.setUint16(0, 0, true);                 // reserved
    header.setUint16(2, 1, true);                 // type: icon
    header.setUint16(4, 1, true);                 // image count
    header.setUint8(6, canvas.width  >= 256 ? 0 : canvas.width);   // 0 = 256
    header.setUint8(7, canvas.height >= 256 ? 0 : canvas.height);
    header.setUint8(8, 0);                        // no palette
    header.setUint8(9, 0);                        // reserved
    header.setUint16(10, 1, true);                // colour planes
    header.setUint16(12, 32, true);               // bits per pixel
    header.setUint32(14, png.length, true);       // PNG size
    header.setUint32(18, 22, true);               // PNG offset
    return new Blob([header.buffer, png], { type: 'image/x-icon' });
  }

  // Classic 24-bit BMP (BGR, rows padded to 4 bytes, bottom-up).
  // No alpha channel: the background is already composited over white.
  function encodeBmp(canvas) {
    const w = canvas.width, h = canvas.height;
    const data = canvas.getContext('2d').getImageData(0, 0, w, h).data;
    const rowSize = Math.ceil((w * 3) / 4) * 4;
    const pixelBytes = rowSize * h;
    const buf = new ArrayBuffer(54 + pixelBytes);
    const dv = new DataView(buf);

    // BITMAPFILEHEADER
    dv.setUint8(0, 0x42); dv.setUint8(1, 0x4D);   // "BM"
    dv.setUint32(2, 54 + pixelBytes, true);       // total size
    dv.setUint32(10, 54, true);                   // pixel data offset
    // BITMAPINFOHEADER
    dv.setUint32(14, 40, true);
    dv.setInt32(18, w, true);
    dv.setInt32(22, h, true);                     // positive = bottom-up
    dv.setUint16(26, 1, true);                    // planes
    dv.setUint16(28, 24, true);                   // bits per pixel
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

  // Renders and encodes the current state, ignoring the weight limit.
  async function renderAndEncode(state) {
    const { W, H } = outputDims(state);
    const bg = FORMATS[state.fmt].alpha ? null : '#ffffff';
    const canvas = renderOutput(state, W, H, bg);
    return encodeCanvas(canvas, state.fmt, state.quality);
  }

  // Exports honouring the weight limit when one is set.
  // Returns { blob, filename, limit } where limit is:
  //   null                 → no limit requested
  //   { ok: true }          → limit met
  //   { ok: false, maxKb }  → limit NOT met (must be reported; never pass
  //                           off an oversized file as a success)
  async function exportBlob(state) {
    const maxKb = state.maxKb;
    const limitBytes = maxKb ? maxKb * 1024 : null;
    let blob = await renderAndEncode(state);
    let limit = null;

    if (limitBytes) {
      if (blob.size > limitBytes) blob = await fitToLimit(state, limitBytes);
      limit = blob.size <= limitBytes ? { ok: true } : { ok: false, maxKb };
    }

    const { W, H } = outputDims(state);
    const filename = `${state.fileName}_${W}x${H}.${FORMATS[state.fmt].ext}`;
    return { blob, filename, limit };
  }

  // Compresses until it fits: first a binary search over quality (lossy
  // formats), then progressive downscaling, re-rendering from the source so
  // the image is never degraded twice.
  // If it cannot fit, returns the SMALLEST result achieved; the caller
  // compares against the limit and reports.
  async function fitToLimit(state, limit) {
    const { W, H } = outputDims(state);
    const f = FORMATS[state.fmt];
    const bg = f.alpha ? null : '#ffffff';

    if (f.lossy) {
      const canvas = renderOutput(state, W, H, bg);
      const found = await binarySearchQuality(canvas, state.fmt, state.quality, limit);
      if (found) return found;
    }

    // Step the resolution down (with minimum quality for lossy formats).
    // Keep the smallest result seen, not the last one: for lossless formats
    // a smaller scale does not always mean a smaller file.
    let best = null;
    let scale = 0.9;
    for (let i = 0; i < 16 && Math.min(W, H) * scale >= 8; i++, scale *= 0.82) {
      const w = Math.max(1, Math.round(W * scale));
      const h = Math.max(1, Math.round(H * scale));
      const canvas = renderOutput(state, w, h, bg);
      const blob = f.lossy
        ? (await binarySearchQuality(canvas, state.fmt, state.quality, limit)) ??
          (await encodeCanvas(canvas, state.fmt, 0.05))
        : await encodeCanvas(canvas, state.fmt, state.quality);
      if (!best || blob.size < best.size) best = blob;
      if (blob.size <= limit) return blob;
    }
    return best;
  }

  // Highest quality whose size stays under the limit, or null if even the
  // lowest quality is too big.
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

  // Triggers a browser download for a blob.
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
