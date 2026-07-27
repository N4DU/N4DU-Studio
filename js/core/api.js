// Cliente del backend. Todo el procesamiento pesado (recorte, redimensionado,
// conversión de formato y compresión por peso) ocurre en server.py; este
// módulo solo manda la imagen y los parámetros y recibe el resultado.
(function (N4DU) {

  let sessionId = null;

  // ¿Estamos servidos por el backend? (abrir el HTML con doble clic usa
  // file:// y no hay servidor).
  function hasBackend() {
    return location.protocol === 'http:' || location.protocol === 'https:';
  }

  async function getFormats() {
    const res = await fetch('/api/formats');
    if (!res.ok) throw new Error('formats');
    return res.json();
  }

  // Sube la imagen ya decodificada (PNG a resolución completa) una sola vez.
  // El navegador decodifica cualquier formato —incluido SVG— y manda píxeles.
  async function upload(bitmap) {
    const blob = await bitmapToPng(bitmap);
    const res = await fetch('/api/upload', { method: 'POST', body: blob });
    if (!res.ok) throw new Error('No se pudo subir la imagen al backend.');
    const data = await res.json();
    sessionId = data.id;
    return data;
  }

  // Peso estimado (bytes) para los parámetros actuales.
  async function estimate(params) {
    const res = await fetch('/api/estimate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sessionId, ...params }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'estimate');
    return data.size;
  }

  // Procesa y devuelve { blob, filename } listo para descargar.
  async function process(params) {
    const res = await fetch('/api/process', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: sessionId, ...params }),
    });
    if (!res.ok) {
      let msg = 'No se pudo procesar la imagen.';
      try { msg = (await res.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    const blob = await res.blob();
    const disp = res.headers.get('Content-Disposition') || '';
    const m = disp.match(/filename="([^"]+)"/);
    return { blob, filename: m ? m[1] : 'imagen' };
  }

  function bitmapToPng(bitmap) {
    const c = new OffscreenCanvas(bitmap.width, bitmap.height);
    c.getContext('2d').drawImage(bitmap, 0, 0);
    return c.convertToBlob({ type: 'image/png' });
  }

  N4DU.api = { hasBackend, getFormats, upload, estimate, process, hasSession: () => !!sessionId };

})(window.N4DU ??= {});
