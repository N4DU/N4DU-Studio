// Disk bridge (optional). When the page is served by main.pyw, this module
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

  let byeKey = null;          // secret authorising the shutdown notice
  let onPending = () => {};   // files handed over while the page was open
  let onFolderChanged = () => {};   // the folder gained or lost a picture
  let onStateChange = () => {};   // the helper appeared, or went away
  let heartbeat = null;

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

    // The heartbeat doubles as the delivery channel for files opened from
    // the right-click menu while this window was already up. Windows starts
    // one process per selected file; they all hand their file to this
    // server, which parks it here until the page collects it — so twenty
    // right-clicked images land in ONE window instead of twenty.
    // take=1: this is the heartbeat, and it is ready to receive files.
    // The probe in init() deliberately does not ask for them.
    // A run of failures means the helper is gone — it was stopped with
    // Ctrl+C, its console was closed, it crashed. Swallowing that left
    // "Replace on disk" lit up for ever, and the only sign was a raw
    // "Failed to fetch" the moment somebody used it. One miss is normal
    // (a busy moment, a reload); three in a row is not.
    let misses = 0;
    const ping = () => fetch('/api/ping?take=1', { headers: HDR })
      .then(res => {
        if (!res.ok) throw new Error('bridge ' + res.status);
        return res.json();
      })
      .then(info => {
        misses = 0;
        if (!bridge.active) {
          // It came back — a restart, or a moment of trouble that passed.
          bridge.active = true;
          onStateChange();
        }
        if (info && info.pending && info.pending.length) onPending(info.pending);
        // The operating system noticed something appear next to the picture
        // you have open, and said so — see watchdir.py. Nothing here polls
        // the disk; this heartbeat exists anyway, so it is what carries the
        // news home.
        bridge.watching = info ? info.watching !== false : true;
        if (info && info.folderChanged) onFolderChanged();
      })
      .catch(() => {
        if (++misses >= 3 && bridge.active) {
          bridge.active = false;
          onStateChange();
        }
      });
    // Kept in one place, so calling init() twice cannot leave two beating.
    clearInterval(heartbeat);
    heartbeat = setInterval(ping, 1000);
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
    const picked = await pickFiles(false);
    if (!picked.length) return null;
    const one = picked[0];
    bridge.token = one.token;
    bridge.path = one.path;
    return one;
  }

  // The dialog in multi-select mode, for the converter. Every file keeps its
  // own token, which is what lets a whole batch be overwritten in place.
  // Returns [{ file, path, token }].
  async function pickFiles(many = true) {
    const res = await fetch('/api/pick?intent=' + (many ? 'open-many' : 'open'),
                            { method: 'POST', headers: HDR });
    if (res.status === 204) return []; // cancelled
    if (!res.ok) throw new Error((await safeJson(res)).error || 'Could not open the dialog.');
    const info = await res.json();
    const metas = info.files || (info.token ? [info] : []);
    return collect(metas);
  }

  // Turns [{token, name, path}] into real File objects by reading each one
  // back through the bridge.
  async function collect(metas) {
    const out = [];
    for (const meta of metas) {
      try {
        const blob = await readCurrent(meta.token);
        out.push({
          file: new File([blob], meta.name, { type: blob.type }),
          path: meta.path,
          token: meta.token,
        });
      } catch { /* a file that vanished between listing and reading */ }
    }
    return out;
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

  // Takes over a file the server already holds — how a picture arrives when
  // the page was launched from the right-click entry (?open=TOKEN). The URL
  // only ever carries a token; the real path stays on the server side.
  // Returns { file, path } or null when the token is no longer valid.
  async function adopt(token) {
    if (!token) return null;
    try {
      const res = await fetch('/api/file?token=' + encodeURIComponent(token), { headers: HDR });
      if (!res.ok) return null;
      const meta = await res.json();
      const [picked] = await collect([{ ...meta, token }]);
      if (!picked) return null;
      bridge.token = picked.token;
      bridge.path = picked.path;
      return picked;
    } catch {
      return null;
    }
  }

  // The other images sitting beside one that is already open. Windows
  // decides how many files a right-click hands over; this is how the rest of
  // the folder can be pulled in regardless.
  // Returns { folder, files: [{ file, path, token }] }.
  async function siblings(token, have = []) {
    const params = new URLSearchParams();
    params.set('token', token);
    for (const path of have) params.append('have', path);
    const res = await fetch('/api/siblings?' + params.toString(), { headers: HDR });
    if (!res.ok) throw new Error((await safeJson(res)).error || 'Could not read that folder.');
    const info = await res.json();
    return { folder: info.folder, metas: info.files || [] };
  }

  // ── Settings ──
  // The state of the system integration lives on the server (the registry is
  // the source of truth), so the settings screen always reads it fresh.
  async function readSettings() {
    const res = await fetch('/api/settings', { headers: HDR });
    if (!res.ok) throw new Error('Could not read the settings.');
    return res.json();
  }

  // patch is { contextMenu: bool } and/or { appWindow: bool }. Returns the
  // new state; throws with the reason when the system refused.
  async function writeSettings(patch) {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { ...HDR, 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const info = await safeJson(res);
    if (!res.ok) {
      const err = new Error(info.error || 'Could not apply the setting.');
      err.status = info;   // the unchanged state, so the switch can snap back
      throw err;
    }
    return info;
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
    const out = await replaceByToken(bridge.token, blob, ext, stem, overwrite);
    bridge.path = out.path; // further replacements follow the new file
    return out;
  }

  // Same, for a file the batch converter holds. Each item in a batch has its
  // own token, so the single "current file" the editor uses is not enough.
  async function replaceByToken(token, blob, ext, stem, overwrite = false) {
    const headers = { ...HDR, 'X-N4DU-Token': token, 'X-N4DU-Ext': ext };
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
    return res.json();
  }

  async function safeJson(res) {
    try { return await res.json(); } catch { return {}; }
  }

  bridge.init = init;
  bridge.pickFile = pickFile;
  bridge.pickFiles = pickFiles;
  bridge.collect = collect;
  bridge.siblings = siblings;
  bridge.replaceByToken = replaceByToken;
  // Where converted files should go, and putting them there.
  //
  // The folder comes back as a TOKEN, never as a path this page could have
  // typed: the same rule the whole bridge keeps. What the page holds is a
  // receipt for a place the person picked in their own file dialog.
  bridge.pickDestination = async () => {
    const res = await fetch('/api/pick-folder', { method: 'POST', headers: HDR });
    if (res.status === 204) return null;              // cancelled
    if (!res.ok) throw new Error((await safeJson(res)).error || 'Could not ask.');
    return res.json();
  };

  // `source` is the token of the picture this one came from, and passing it
  // is what turns a copy into a move: the server deletes it, but only after
  // the new file is safely down.
  bridge.saveInto = async (destToken, name, blob, { overwrite, source } = {}) => {
    const q = new URLSearchParams({ dest: destToken });
    if (source) q.set('source', source);
    const headers = { ...HDR, 'X-N4DU-Name': encodeURIComponent(name) };
    if (overwrite) headers['X-N4DU-Overwrite'] = '1';
    const res = await fetch('/api/save?' + q, { method: 'POST', headers, body: blob });
    if (!res.ok) throw new Error((await safeJson(res)).error || 'Could not save.');
    return res.json();
  };

  // What the window really came out as, frame included, so the next launch
  // can open at exactly that instead of at an estimate. Fire and forget: if
  // it does not arrive, the only cost is one correction next time.
  bridge.rememberWindow = (w, h) => {
    if (!bridge.active) return;
    fetch('/api/window', {
      method: 'POST',
      headers: { ...HDR, 'Content-Type': 'application/json' },
      body: JSON.stringify({ w, h }),
    }).catch(() => { /* the helper went away; nothing here is essential */ });
  };

  bridge.setOnFolderChanged = (fn) => { onFolderChanged = fn || (() => {}); };
  bridge.setOnPending = (fn) => { onPending = fn || (() => {}); };
  // Told when the helper stops answering, or starts again — so the
  // interface can lock and unlock what only the helper can do.
  bridge.setOnStateChange = (fn) => { onStateChange = fn || (() => {}); };
  bridge.pickTarget = pickTarget;
  bridge.readCurrent = () => readCurrent(bridge.token);
  bridge.adopt = adopt;
  bridge.readSettings = readSettings;
  bridge.writeSettings = writeSettings;
  bridge.clearFile = clearFile;
  bridge.replaceOriginal = replaceOriginal;
  bridge.canReplace = () => bridge.active && !!bridge.token;

  N4DU.bridge = bridge;

})(window.N4DU ??= {});
