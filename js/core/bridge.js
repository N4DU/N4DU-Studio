// Puente al disco (opcional). Si la página fue servida por main.py, este
// módulo habla con él para abrir archivos con diálogo nativo y REEMPLAZAR
// el original al exportar. Si no hay puente (GitHub Pages, doble clic al
// HTML), todo lo demás funciona igual y este módulo queda inactivo.
(function (N4DU) {

  const bridge = {
    active: false,   // hay servidor puente corriendo
    token: null,     // identifica el archivo abierto en el servidor
    path: null,      // ruta real del archivo abierto (solo informativa)
  };

  // Cabecera anti-CSRF: obliga un preflight CORS, así ninguna otra página
  // web puede invocar al puente desde el navegador.
  const HDR = { 'X-N4DU': '1' };

  async function init() {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return false;
    try {
      const res = await fetch('/api/ping', { headers: HDR });
      bridge.active = (await res.json()).ok === true;
    } catch {
      bridge.active = false;
    }
    if (bridge.active) startHeartbeat();
    return bridge.active;
  }

  // Latido: el servidor sabe que la página sigue viva. Al cerrarla se avisa
  // con sendBeacon y el servidor espera 3 s por si fue solo un F5.
  function startHeartbeat() {
    fetch('/api/hello', { method: 'POST', headers: HDR }).catch(() => {});
    setInterval(() => fetch('/api/ping', { headers: HDR }).catch(() => {}), 1000);
    window.addEventListener('pagehide', () => {
      navigator.sendBeacon('/api/bye');
    });
  }

  // Abre el diálogo nativo del sistema. Devuelve { file, path } o null si
  // el usuario canceló. Si el servidor no puede mostrar diálogos, lanza.
  async function pickFile() {
    const res = await fetch('/api/pick', { method: 'POST', headers: HDR });
    if (res.status === 204) return null; // canceló
    if (!res.ok) throw new Error((await safeJson(res)).error || 'No se pudo abrir el diálogo.');
    const meta = await res.json();
    const fileRes = await fetch('/api/read?token=' + meta.token, { headers: HDR });
    if (!fileRes.ok) throw new Error('No se pudo leer el archivo.');
    const blob = await fileRes.blob();
    bridge.token = meta.token;
    bridge.path = meta.path;
    return { file: new File([blob], meta.name, { type: blob.type }), path: meta.path };
  }

  // El archivo actual vino sin ruta (drag & drop, Ctrl+V, selector del
  // navegador): no se puede reemplazar.
  function clearFile() {
    bridge.token = null;
    bridge.path = null;
  }

  // Reemplaza el archivo original por los bytes nuevos con la extensión
  // nueva. Si la extensión cambia, el servidor escribe el archivo nuevo y
  // elimina el viejo. Devuelve { path, name } del resultado.
  async function replaceOriginal(blob, ext) {
    const res = await fetch('/api/replace', {
      method: 'POST',
      headers: { ...HDR, 'X-N4DU-Token': bridge.token, 'X-N4DU-Ext': ext },
      body: blob,
    });
    if (!res.ok) throw new Error((await safeJson(res)).error || 'No se pudo reemplazar el archivo.');
    const out = await res.json();
    bridge.path = out.path; // los próximos reemplazos siguen sobre el nuevo
    return out;
  }

  async function safeJson(res) {
    try { return await res.json(); } catch { return {}; }
  }

  bridge.init = init;
  bridge.pickFile = pickFile;
  bridge.clearFile = clearFile;
  bridge.replaceOriginal = replaceOriginal;
  bridge.canReplace = () => bridge.active && !!bridge.token;

  N4DU.bridge = bridge;

})(window.N4DU ??= {});
