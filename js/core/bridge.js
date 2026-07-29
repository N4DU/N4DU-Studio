// Disk bridge (optional). When the page is served by main.py, this module
// talks to it to open files through the native dialog and REPLACE files on
// disk. Without the bridge (GitHub Pages, or opening the HTML directly)
// everything else still works and this module stays inactive.
(function (N4DU) {

  const bridge = {
    active: false,   // a bridge server is running
    token: null,     // identifies the file the server has open
    path: null,      // real path of that file (informational)
  };

  // Anti-CSRF header: forces a CORS preflight, so no other website can
  // drive the bridge from the browser.
  const HDR = { 'X-N4DU': '1' };

  let byeKey = null;   // secret authorising the shutdown notice

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

  // Heartbeat: lets the server know the page is still open. On close a
  // beacon is sent and the server waits a few seconds in case it was a
  // reload.
  async function startHeartbeat() {
    try {
      const res = await fetch('/api/hello', { method: 'POST', headers: HDR });
      byeKey = (await res.json()).key || null;
    } catch { /* the server still detects the missing heartbeat */ }

    const ping = () => fetch('/api/ping', { headers: HDR }).catch(() => {});
    setInterval(ping, 1000);
    // Coming back from a background tab (where browsers throttle timers),
    // report immediately that the page is alive.
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) ping();
    });

    window.addEventListener('pagehide', () => {
      if (byeKey) navigator.sendBeacon('/api/bye?k=' + encodeURIComponent(byeKey));
    });
  }

  // Opens the native file dialog. Returns { file, path } or null if the
  // user cancelled. Throws when the server cannot show dialogs.
  async function pickFile() {
    const meta = await pick('open');
    if (!meta) return null;
    const blob = await readCurrent(meta.token);
    bridge.token = meta.token;
    bridge.path = meta.path;
    return { file: new File([blob], meta.name, { type: blob.type }), path: meta.path };
  }

  // Chooses WHICH file on disk will be replaced, without touching the image
  // being edited (for pasted or dropped images that have no path).
  // Returns { path, name } or null if cancelled.
  async function pickTarget() {
    const meta = await pick('target');
    if (!meta) return null;
    bridge.token = meta.token;
    bridge.path = meta.path;
    return { path: meta.path, name: meta.name };
  }

  async function pick(intent) {
    const res = await fetch('/api/pick?intent=' + intent, { method: 'POST', headers: HDR });
    if (res.status === 204) return null; // cancelled
    if (!res.ok) throw new Error((await safeJson(res)).error || 'Could not open the dialog.');
    return res.json();
  }

  // Bytes of the currently selected file (for thumbnails or loading).
  async function readCurrent(token) {
    const res = await fetch('/api/read?token=' + (token ?? ''), { headers: HDR });
    if (!res.ok) throw new Error('Could not read the file.');
    return res.blob();
  }

  // The current image has no path on disk (drag & drop, paste, browser
  // picker), so there is nothing to replace until a target is chosen.
  function clearFile() {
    bridge.token = null;
    bridge.path = null;
  }

  // Replaces the selected file with the new bytes, using the new extension
  // and (optionally) a new name. When the resulting path differs, the server
  // writes the new file and deletes the old one.
  // overwrite = true confirms replacing a different file that already exists.
  async function replaceOriginal(blob, ext, stem, overwrite = false) {
    const headers = { ...HDR, 'X-N4DU-Token': bridge.token, 'X-N4DU-Ext': ext };
    if (stem) headers['X-N4DU-Name'] = encodeURIComponent(stem);
    if (overwrite) headers['X-N4DU-Overwrite'] = '1';
    const res = await fetch('/api/replace', { method: 'POST', headers, body: blob });
    if (!res.ok) {
      const info = await safeJson(res);
      const err = new Error(info.error || 'Could not replace the file.');
      // Target already exists: the caller must ask for confirmation.
      if (res.status === 409) err.conflict = info.conflict;
      throw err;
    }
    const out = await res.json();
    bridge.path = out.path; // further replacements follow the new file
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
