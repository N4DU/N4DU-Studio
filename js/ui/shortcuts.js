// The keyboard.
//
// Every shortcut is Ctrl (or Cmd) plus one letter, and every one of them is
// refused in the situations where it would destroy something: while typing
// in a field, and under any open dialog — Ctrl+S downloading from beneath
// the help sheet, or Ctrl+R wiping a half-typed filename, are the kind of
// thing nobody reports because it looks like their own mistake.
//
// The actions are handed in rather than reached for: this module knows which
// keys mean what, and nothing about what they do.
(function (N4DU) {

  const { state, edit } = N4DU;

  function initShortcuts(app) {
    const { chooseFile, currentMode, onDownload, onCopy, openReplaceDialog } = app;

    // Ignored while typing in a field or with the replace dialog open: Ctrl+S
    // would download and Ctrl+R would wipe a half-typed name.
    window.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey)) return;
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
      if (!document.getElementById('replaceModal').hidden) return;
      if (!document.getElementById('settingsModal').hidden) return;
      // Help too: Ctrl+R was opening the Replace dialog behind the help sheet,
      // and Ctrl+S downloading from under it.
      if (!document.getElementById('helpModal').hidden) return;
      const k = e.key.toLowerCase();
      if (k === 'o') { e.preventDefault(); chooseFile(); return; }
      if (currentMode() === 'convert') return;   // the rest belong to the editor
      if (!state.img) return;
      if (k === 's' || k === 'e') { e.preventDefault(); onDownload(); }
      if (k === 'c') { e.preventDefault(); onCopy(); }
      if (k === 'r') { e.preventDefault(); openReplaceDialog(); }
      if (k === 'z') {
        e.preventDefault();
        // The same path as the Undo button. Doing it by hand here left the old
        // crop box behind: after Ctrl+Z it sat over a different part of the
        // restored picture with Apply still enabled, and one click cropped to
        // the stale rectangle — throwing the undo away.
        N4DU.tools.stepHistory(e.shiftKey ? edit.redo : edit.undo);
      }
    });
  }

  N4DU.shortcuts = { initShortcuts };

})(window.N4DU ??= {});
