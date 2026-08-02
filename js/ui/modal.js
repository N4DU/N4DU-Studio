// Making a dialog behave like one, for somebody using the keyboard.
//
// All four dialogs here are a dimmed backdrop with a card on top. That looks
// modal and was not: focus stayed on the button that opened it, and Tab
// walked straight past the card into the page underneath — six presses took
// you to "Add files", a control you could not see, under a dim overlay, and
// pressing it did what it always does. A screen reader had no idea a dialog
// had opened at all, because nothing said so.
//
// Three things fix that, and they are the same three every time, which is
// why they live here rather than in each dialog: say what it is (done in
// the markup, role="dialog" and aria-modal), put focus inside it, and keep
// focus inside it until it closes — then give focus back to whatever the
// person was on when they opened it.
(function (N4DU) {

  // What can be tabbed to, in document order. Written out rather than using
  // a library because the set is small and the page owns all of it.
  const FOCUSABLE = [
    'a[href]', 'button:not([disabled])', 'input:not([disabled])',
    'select:not([disabled])', 'textarea:not([disabled])', '[tabindex]',
  ].join(',');

  function focusables(box) {
    return [...box.querySelectorAll(FOCUSABLE)]
      .filter(el => el.tabIndex !== -1 && el.offsetParent !== null);
  }

  const open = new Map();   // box -> what to put focus back on

  // Call when a dialog becomes visible. `first` is what to focus, if the
  // dialog has an obvious answer (the Allow button, a text field).
  function opened(box, first) {
    if (!box || open.has(box)) return;
    open.set(box, document.activeElement);
    const target = first || focusables(box)[0];
    if (target) target.focus();
  }

  // Call when it is hidden again.
  function closed(box) {
    const back = open.get(box);
    open.delete(box);
    // Only if the thing is still there and still focusable — a dialog can
    // close because the button that opened it went away.
    if (back && document.contains(back) && back.offsetParent !== null) {
      try { back.focus(); } catch { /* not worth failing a close over */ }
    }
  }

  // One listener for every dialog. Tab wraps at both ends of whichever one
  // is on top; anything already inside is left alone.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const boxes = [...open.keys()].filter(b => !b.hidden);
    if (!boxes.length) return;
    const box = boxes[boxes.length - 1];
    const items = focusables(box);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    // Focus that escaped — or never arrived — comes back to the near end.
    if (!box.contains(document.activeElement)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
      return;
    }
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }, true);

  N4DU.modal = { opened, closed };

})(window.N4DU ??= {});
