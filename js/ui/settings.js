// Settings: the system integration switches.
//
// The switches do not merely remember a preference — flipping the first one
// writes the right-click entry into the operating system and flipping it back
// removes it. That work happens on the server (main.py), so this module reads
// the real state every time it opens instead of trusting a local copy.
(function (N4DU) {

  const { bridge, toast } = N4DU;
  const $ = (id) => document.getElementById(id);

  let current = null;      // last status from the server
  let busy = false;

  function initSettings() {
    const modal = $('settingsModal');
    $('btnSettings').addEventListener('click', open);
    $('btnSettingsClose').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !modal.hidden) close();
    });

    $('setContextMenu').addEventListener('change', e =>
      apply({ contextMenu: e.target.checked }));
    $('setAppWindow').addEventListener('change', e =>
      apply({ appWindow: e.target.checked }));

    // Deliberately a two-step action: it undoes system changes and deletes a
    // folder, so it should never happen on a stray click.
    $('btnForget').addEventListener('click', () => {
      const btn = $('btnForget');
      if (btn.dataset.armed !== '1') {
        btn.dataset.armed = '1';
        btn.textContent = 'Click again to confirm';
        setTimeout(() => {
          btn.dataset.armed = '';
          btn.textContent = 'Remove every trace from this machine';
        }, 4000);
        return;
      }
      btn.dataset.armed = '';
      btn.textContent = 'Remove every trace from this machine';
      apply({ forget: true });
    });
  }

  function open() {
    $('settingsModal').hidden = false;
    render(null);
    if (!bridge.active) return;   // browser-only: the locked notice explains it
    bridge.readSettings().then(render).catch(err => {
      $('setStatus').textContent = err.message;
    });
  }

  function close() {
    $('settingsModal').hidden = true;
  }

  // Sends one change and re-renders from whatever the system reports back.
  // If it was refused, the switch snaps back rather than lying about the
  // state of the machine.
  async function apply(patch) {
    if (busy || !bridge.active) return;
    busy = true;
    setDisabled(true);
    $('setStatus').textContent = 'Applying…';
    try {
      const status = await bridge.writeSettings(patch);
      render(status);
      if ('contextMenu' in patch) {
        toast(patch.contextMenu
          ? 'Added to the right-click menu for images'
          : 'Removed from the right-click menu', 'ok');
      }
      if (patch.forget) {
        toast('Removed. Nothing of N4DU Studio is left outside its own folder.', 'ok');
      }
    } catch (err) {
      render(err.status && err.status.contextMenu ? err.status : current);
      $('setStatus').textContent = err.message;
      toast(err.message, 'err');
    } finally {
      busy = false;
      setDisabled(false);
    }
  }

  function setDisabled(off) {
    $('setContextMenu').disabled = off;
    $('setAppWindow').disabled = off;
  }

  // Paints the switches. status === null means "not read yet".
  function render(status) {
    const locked = !bridge.active;
    $('settingsLocked').hidden = !locked;
    $('setContextMenu').disabled = locked;
    $('setAppWindow').disabled = locked;

    if (locked) {
      $('setStatus').textContent = '';
      $('setContextMenu').checked = false;
      $('setAppWindow').checked = false;
      $('setPlatformNote').textContent = '';
      return;
    }
    if (!status) {
      $('setStatus').textContent = 'Reading…';
      return;
    }
    current = status;

    const menu = status.contextMenu;
    $('setContextMenu').checked = !!menu.enabled;
    $('setContextMenu').disabled = !menu.supported;
    $('setPlatformNote').textContent = menu.supported ? '' : (menu.reason || '');

    // Left switchable even with no suitable browser installed: it is a
    // preference worth remembering, and the note says plainly that nothing
    // will come of it until one is there.
    const win = status.appWindow;
    $('setAppWindow').checked = !!win.enabled;

    $('setStatus').textContent = statusLine(status);
    $('setWindowNote').textContent = win.available
      ? `Uses ${win.browser}.`
      : 'No Chrome or Edge on this machine, so N4DU Studio opens in a normal ' +
        'tab until there is one.';
  }

  // One honest sentence about what the system currently looks like.
  function statusLine(status) {
    const menu = status.contextMenu;
    if (!menu.supported) return '';
    if (menu.stale) {
      return 'Registered by an older version, or pointing at a folder that has ' +
             'moved. Switch it off and on again to bring it up to date.';
    }
    if (menu.enabled) {
      return `On for ${menu.installed.length} image types. Stored in your own ` +
             'user account only; nothing was installed system-wide.';
    }
    if (menu.partial) {
      return `Half registered (${menu.installed.length} of ${menu.extensions.length} ` +
             'types). Switch it on to complete it.';
    }
    return 'Off. Nothing of N4DU Studio is registered with Windows.';
  }

  N4DU.settings = { initSettings, open: open, close };

})(window.N4DU ??= {});
