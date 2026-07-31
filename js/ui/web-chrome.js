// What a visitor sees when the link is opened in a browser tab.
//
// A tab is not a window: the tool draws itself at its proper 640px and the
// rest of a 1920px screen is empty, which reads as "the program is broken"
// rather than "the program is small". So when this page is a tab, the empty
// space explains what it is and offers the real thing.
//
// A page cannot open a window on its own — every browser requires a click
// for that, and rightly so. One click is the honest floor here.
(function (N4DU) {

  const WIN = { w: 640, h: 620 };

  // Is this already a window of its own rather than a tab?
  //
  // locationbar.visible is false in a popup and in Chrome's --app mode,
  // which is exactly the distinction that matters. window.opener catches
  // the popup case on browsers that report the bars differently.
  function inOwnWindow() {
    try {
      if (window.opener) return true;
      const bars = window.locationbar;
      if (bars && typeof bars.visible === 'boolean') return !bars.visible;
    } catch { /* cross-origin opener: treat as a tab */ }
    return false;
  }

  function openAsWindow() {
    // Centred on the screen the person is actually using.
    const left = Math.max(0, Math.round((window.screen.availWidth - WIN.w) / 2));
    const top = Math.max(0, Math.round((window.screen.availHeight - WIN.h) / 2.4));
    const features = `popup=yes,width=${WIN.w},height=${WIN.h},left=${left},top=${top}` +
                     ',menubar=no,toolbar=no,location=no,status=no';
    const win = window.open(location.href, 'n4du-studio', features);
    if (!win) {
      N4DU.toast('Your browser blocked the window — allow pop-ups for this page', 'err');
      return;
    }
    win.focus();
  }

  function initWebChrome() {
    const own = inOwnWindow();
    document.documentElement.classList.toggle('in-window', own);
    const btn = document.getElementById('btnOpenWindow');
    if (btn) btn.addEventListener('click', openAsWindow);
  }

  N4DU.webChrome = { initWebChrome, inOwnWindow, openAsWindow };

})(window.N4DU ??= {});
