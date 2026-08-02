// The "how it works" sheet.
//
// Self-contained on purpose: it owns one dialog, one button and one key, and
// nothing else in the program needs to know it exists.
(function (N4DU) {

  function initHelp() {
    const modal = document.getElementById('helpModal');
    // Never on top of another dialog. Stacked sheets looked broken, and since
    // each dialog listens for Escape on its own, one press shut both of them.
    // Refusing to stack is the fix; the Escape handlers then cannot collide.
    const show = () => {
      const busy = ['replaceModal', 'settingsModal'].some(id => {
        const m = document.getElementById(id);
        return m && !m.hidden;
      });
      if (!busy) modal.hidden = false;
    };
    const hide = () => { modal.hidden = true; };
    document.getElementById('btnHelp').addEventListener('click', show);
    document.getElementById('btnHelpClose').addEventListener('click', hide);
    modal.addEventListener('click', e => { if (e.target === modal) hide(); });
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !modal.hidden) hide();
      // "?" opens help from anywhere outside a text field.
      if (e.key === '?' && !/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) show();
    });
  }

  N4DU.help = { initHelp };

})(window.N4DU ??= {});
