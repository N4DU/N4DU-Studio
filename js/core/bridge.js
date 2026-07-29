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

  let byeKey = null;   // secreto que autoriza el aviso de cierre

  async function init() {
    if (location.protocol !== 'http:' && location.protocol !== 'https:') return false;
    try {
      const res = await fetch('/api/ping', { headers: HDR });
      bridge.active = (await res.json()).ok === true;
    } catch {
      bridge.active = false;
    }
    if (bridge.active) await startHeartbeat();
    return bridge.active;
  }

  // Latido: el servidor sabe que la página sigue viva. Al cerrarla se avisa
  // con sendBeacon y el servidor espera 3 s por si fue solo un F5.
  async function startHeartbeat() {
    try {
      const res = await fetch('/api/hello', { method: 'POST', headers: HDR });
      byeKey = (await res.json()).key || null;
    } catch { /* el servidor igual detecta la ausencia de latidos */ }

    const ping = () => fetch('/api/ping', { headers: HDR }).catch(() => {});
    setInterval(ping, 1000);
    // Al volver de una pestaña en segundo plano (donde el navegador frena
    // los temporizadores) se avisa enseguida que la página sigue viva.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) ping();
    });

    window.addEventListener('pagehide', () => {
      if (byeKey) navigator.sendBeacon('/api/bye?k=' + encodeURIComponent(byeKey));
    });
  }

  // Abre el diálogo nativo del sistema. Devuelve { file, path } o null si
  // el usuario canceló. Si el servidor no puede mostrar diálogos, lanza.
  async function pickFile() {
    const meta = await pick('open');
    if (!meta) return null;
    const blob = await readCurrent(meta.token);
    bridge.token = meta.token;
    bridge.path = meta.path;
    return { file: new File([blob], meta.name, { type: blob.type }), path: meta.path };
  }

  // Elige QUÉ archivo del disco será reemplazado, sin tocar la imagen de
  // trabajo (para imágenes pegadas o arrastradas que no tienen ruta).
  // Devuelve { path, name } o null si canceló.
  async function pickTarget() {
    const meta = await pick('target');
    if (!meta) return null;
    bridge.token = meta.token;
    bridge.path = meta.path;
    return { path: meta.path, name: meta.name };
  }

  async function pick(intent) {
    const res = await fetch('/api/pick?intent=' + intent, { method: 'POST', headers: HDR });
    if (res.status === 204) return null; // canceló
    if (!res.ok) throw new Error((await safeJson(res)).error || 'No se pudo abrir el diálogo.');
    const meta = await res.json();
    // el pick anterior queda invalidado recién acá (con cancelar no se pierde nada)
    return meta;
  }

  // Bytes del archivo actualmente elegido (para miniaturas o para cargarlo).
  async function readCurrent(token) {
    const res = await fetch('/api/read?token=' + (token ?? ''), { headers: HDR });
    if (!res.ok) throw new Error('No se pudo leer el archivo.');
    return res.blob();
  }

  // El archivo actual vino sin ruta (drag & drop, Ctrl+V, selector del
  // navegador): no se puede reemplazar.
  function clearFile() {
    bridge.token = null;
    bridge.path = null;
  }

  // Reemplaza el archivo elegido por los bytes nuevos, con la extensión
  // nueva y (opcional) otro nombre. Si la ruta resultante difiere, el
  // servidor escribe el archivo nuevo y elimina el viejo.
  // Devuelve { path, name } del resultado.
  // overwrite = true confirma pisar un archivo distinto que ya existía.
  async function replaceOriginal(blob, ext, stem, overwrite = false) {
    const headers = { ...HDR, 'X-N4DU-Token': bridge.token, 'X-N4DU-Ext': ext };
    if (stem) headers['X-N4DU-Name'] = encodeURIComponent(stem);
    if (overwrite) headers['X-N4DU-Overwrite'] = '1';
    const res = await fetch('/api/replace', { method: 'POST', headers, body: blob });
    if (!res.ok) {
      const info = await safeJson(res);
      const err = new Error(info.error || 'No se pudo reemplazar el archivo.');
      // El destino ya existe: quien llama debe pedir confirmación.
      if (res.status === 409) err.conflict = info.conflict;
      throw err;
    }
    const out = await res.json();
    bridge.path = out.path; // los próximos reemplazos siguen sobre el nuevo
    return out;
  }

  async function safeJson(res) {
    try { return await res.json(); } catch { return {}; }
  }

  bridge.init = init;
  bridge.pickFile = pickFile;
  bridge.pickTarget = pickTarget;
  bridge.readCurrent = () => readCurrent(bridge.token);
  bridge.clearFile = clearFile;
  bridge.replaceOriginal = replaceOriginal;
  bridge.canReplace = () => bridge.active && !!bridge.token;

  N4DU.bridge = bridge;

})(window.N4DU ??= {});
