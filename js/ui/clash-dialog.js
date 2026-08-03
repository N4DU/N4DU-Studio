// "Something in there is already called that."
//
// Asked once, after the folder has been chosen and before any file is
// written, and only when it is a real question. That is the whole reason
// this exists as a dialog rather than as a permanent tick-box beside the
// buttons: a tick-box would sit on screen on every run, in a 452-pixel
// window, answering a question that almost never comes up — and it would
// have to be answered before you knew whether it applied.
//
// Three ways out, and all three are honest. Replace overwrites. Keep both
// lets the server pick a free name, the same «foto (2).png» shape Windows
// uses. Cancel stops before a single picture is converted.
(function (N4DU) {

  const $ = (id) => document.getElementById(id);

  // At most this many names are listed. Beyond it the list stops being
  // something you read and starts being something you scroll past.
  const SHOWN = 12;

  let settle = null;      // resolves the promise the caller is waiting on

  function init() {
    $('btnClashReplace').addEventListener('click', () => finish('replace'));
    $('btnClashKeep').addEventListener('click', () => finish('keep'));
    $('btnClashCancel').addEventListener('click', () => finish('cancel'));
    // A dialog you cannot escape from is a dialog that has taken your
    // program hostage. Backdrop and Escape both mean "no, stop".
    $('clashModal').addEventListener('click', e => {
      if (e.target === $('clashModal')) finish('cancel');
    });
    window.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !$('clashModal').hidden) finish('cancel');
    });
  }

  // Returns 'replace', 'keep' or 'cancel'.
  function ask(taken, folderName) {
    // Nothing to ask about: do not put an empty dialog on screen.
    if (!taken || !taken.length) return Promise.resolve('keep');

    const many = taken.length > 1;
    $('clashText').textContent =
      `${taken.length} file${many ? 's' : ''} in ${folderName || 'that folder'} ` +
      `${many ? 'are' : 'is'} already called what N4DU Studio is about to write.`;

    const list = $('clashList');
    list.innerHTML = '';
    for (const name of taken.slice(0, SHOWN)) {
      const li = document.createElement('li');
      li.textContent = name;
      list.appendChild(li);
    }
    // The count is in the sentence above; this line only says the list is
    // not the whole story, which the list itself cannot say.
    if (taken.length > SHOWN) {
      const li = document.createElement('li');
      li.textContent = `…and ${taken.length - SHOWN} more`;
      list.appendChild(li);
    }

    $('clashModal').hidden = false;
    // Keep both is the focused answer: it is the one that cannot lose
    // anything, and Enter is pressed by reflex.
    N4DU.modal.opened($('clashModal'), $('btnClashKeep'));
    return new Promise(resolve => { settle = resolve; });
  }

  function finish(answer) {
    if ($('clashModal').hidden) return;
    $('clashModal').hidden = true;
    N4DU.modal.closed($('clashModal'));
    const done = settle;
    settle = null;
    if (done) done(answer);
  }

  N4DU.clashDialog = { init, ask };

})(window.N4DU ??= {});
