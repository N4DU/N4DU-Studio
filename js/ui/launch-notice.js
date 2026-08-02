// Offering the window, and saying why there is not one.
//
// The attempt itself happens in js/own-window.js, in the HEAD, long before
// this file loads — it has to, or the tab paints first. What is here is the
// part that needs an interface: doing it on purpose from a button, and
// putting the outcome on screen when the browser refused.
(function (N4DU) {

  const { toast, bridge } = N4DU;
  const ownWindow = N4DU.ownWindow;

  // The attempt itself happens in js/own-window.js, in the HEAD, before this
  // file has even loaded — it has to, or the tab paints first. What is left
  // here is the part that needs the interface: doing it on purpose from the
  // button, and saying out loud why it did not happen on its own.
  function inOwnWindow() {
    return ownWindow.isOwnWindow();
  }

  function openInOwnWindow() {
    // Measured, not guessed: the window arrives at the size the interface
    // says it needs rather than arriving wrong and correcting itself.
    if (!ownWindow.open(N4DU.windowSize.measure())) {
      toast('Your browser blocked the window — allow pop-ups for this page', 'err');
      return;
    }
    hideWindowNotice();
  }

  // What happened before the page was painted.
  //
  // Shown over everything, on arrival, and only when the browser refused to
  // open the window by itself. One button, because there is only one thing
  // worth doing: opening a window from a click is something every browser
  // allows, so nothing has to be permitted in advance.
  //
  // The way out is a small x rather than a second button. A notice with a
  // "Later" next to its "Yes" gets dismissed by reflex, and this one only
  // appears when there is something real to gain by reading it.
  function showWindowNotice() {
    const box = document.getElementById('windowModal');
    if (!box) return;
    if (inOwnWindow() || bridge.active) return;   // this IS the window

    const { tried, opened, reason } = ownWindow.outcome;

    // It went out into its own window but this page could neither go back
    // nor close. Nothing to decide, so nothing to interrupt anybody with —
    // the title bar's own Window button brings it back to the front.
    if (opened) return;
    if (!(tried && reason === 'blocked')) return;

    const local = location.protocol === 'file:';
    document.getElementById('windowModalBody').innerHTML =
      'N4DU Studio is made for a <b>small window of its own</b>, and this '
      + 'browser does not let a page open one without being asked.';
    document.getElementById('windowModalFine').innerHTML = local
      ? 'Opening <b>main.pyw</b> instead skips this every time.'
      : 'To skip this step in future, allow pop-ups for this page.';

    const go = document.getElementById('windowModalGo');
    const shut = () => {
      box.hidden = true;
      N4DU.modal.closed(box);
      N4DU.windowSize.fit();
    };

    go.addEventListener('click', () => { openInOwnWindow(); shut(); });
    document.getElementById('windowModalClose').addEventListener('click', shut);
    // Escape closes it; clicking the dimmed background does not. Missing a
    // notice by clicking slightly off target is exactly the accident this
    // is trying to avoid.
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !box.hidden) shut();
    });

    box.hidden = false;
    // It already put focus on the one button that helps; this keeps it in
    // the sheet, and hands it back on close — see js/ui/modal.js.
    N4DU.modal.opened(box, go);
  }

  function hideWindowNotice() {
    const box = document.getElementById('windowModal');
    if (box) box.hidden = true;
  }

  N4DU.launchNotice = {
    inOwnWindow, openInOwnWindow, showWindowNotice, hideWindowNotice,
  };

})(window.N4DU ??= {});
