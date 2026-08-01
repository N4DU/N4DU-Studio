// Arriving in a window of its own, without being asked twice.
//
// This runs in the HEAD, before the page has painted a single pixel, because
// by the time anything is on screen the decision has already been made for
// you: you are looking at a full-width browser tab holding an interface built
// for a 452-pixel window.
//
// WHAT A BROWSER WILL AND WILL NOT DO, measured rather than assumed:
//
//   * A tab cannot resize itself. Not a normal tab, and not even a tab that
//     is alone in its own window — resizeTo is simply ignored. The only
//     windows that may resize themselves are ones a script opened, and app
//     windows (an installed web app, or a browser launched with --app).
//
//   * The click that brought you here does not come with you. A real click on
//     a real link gives the page that opens `hasBeenActive: false`; window.open
//     returns null and resizeTo does nothing. There is no clever way around
//     this: user activation deliberately does not survive a navigation.
//
//   * But a site you have allowed pop-ups for may call window.open with no
//     gesture at all, while the document is still parsing. That is the whole
//     mechanism this file rests on. The first visit is refused and explains
//     itself; every visit after the permission is granted opens straight into
//     its own window.
//
//   * The width and height passed to window.open are a REQUEST. They are
//     ignored outright when a window of that name already exists, and can be
//     ignored even when creating one. So the size is set by the new window
//     resizing ITSELF once it is open — window-size.js does that, and keeps
//     doing it as files are added.
//
// The one thing that cannot be delivered here is the address bar: a pop-up
// keeps a compact one. Only an installed app has none, and not every
// Chromium browser offers installing.
(function (N4DU) {

  const NAME = 'n4du-studio';       // the window we open, and re-use
  const STORE = 'n4du.window';      // the size you last left it at
  const OPT_OUT = 'n4du.noPopOut';  // "stop doing this"

  // Where the compact layout starts to make sense. Below this the tab is
  // already about the size the window would be, and a pop-up would be a
  // pointless piece of theatre.
  const MIN_SCREEN = 900;

  const DEFAULT = { w: 452, h: 560 };

  // Our own address without the query or the hash. Built from href rather
  // than pathname: on Windows a file:// pathname is "/C:/Users/..." and
  // handing that to window.open is asking the browser to guess.
  function selfUrl() {
    return location.href.split('#')[0].split('?')[0] + '?app=1' + location.hash;
  }

  function readStored() {
    try {
      const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
      if (saved && saved.w > 200 && saved.h > 200) return saved;
    } catch { /* private mode, or file:// — the default is fine */ }
    return DEFAULT;
  }

  // Remembered so that re-opening the link does not undo a size you chose by
  // hand. window-size.js calls this when it notices you resized the window.
  function remember(w, h) {
    try { localStorage.setItem(STORE, JSON.stringify({ w: Math.round(w), h: Math.round(h) })); }
    catch { /* nothing lost that matters */ }
  }

  // Are we already the window, rather than the tab that should spawn it?
  //
  // Three separate signals, because each one can be missing: window.open sets
  // the name, an opened window has an opener, and the desktop launcher passes
  // ?app=1 without either. Getting this wrong means a window that opens a
  // window that opens a window.
  function isOwnWindow() {
    try {
      if (window.name === NAME) return true;
      if (window.opener && !window.opener.closed) return true;
    } catch { /* a cross-origin opener still counts as an opener */ return true; }
    return new URLSearchParams(location.search).get('app') === '1';
  }

  function optedOut() {
    try { return localStorage.getItem(OPT_OUT) === '1'; } catch { return false; }
  }

  // Why we are still a tab. Read by main.js once the DOM exists, so the
  // explanation appears in the interface rather than in the console.
  const outcome = { tried: false, opened: false, reason: '' };

  // The desktop version serves itself from loopback and opens its own window
  // through the browser's --app switch. When that fails it falls back to a
  // plain tab, and popping out from there would leave TWO live pages talking
  // to one bridge: close the pop-up and the server shuts down underneath the
  // tab that is still open. The launcher owns its window; leave it alone.
  function servedByTheLauncher() {
    return location.protocol === 'http:' &&
           /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
  }

  function popOut() {
    if (isOwnWindow()) { outcome.reason = 'already its own window'; return; }
    if (optedOut())    { outcome.reason = 'turned off'; return; }
    // A test harness is not a person. Automated browsers do not run a pop-up
    // blocker, so without this every suite in the project would find itself
    // yanked into a second window mid-test and left looking at an empty page.
    // navigator.webdriver is the standard flag for exactly this question and
    // is never set in a browser somebody is actually using.
    if (navigator.webdriver) { outcome.reason = 'automated browser'; return; }
    if (servedByTheLauncher()) { outcome.reason = 'the desktop version owns its window'; return; }
    if (!window.screen || screen.availWidth < MIN_SCREEN) {
      outcome.reason = 'screen too small to be worth it';
      return;
    }

    outcome.tried = true;
    const opened = spawn(readStored());

    if (!opened) {
      // The pop-up blocker. Not an error — the default, on a first visit.
      outcome.reason = 'blocked';
      return;
    }

    // Do not leave a corpse behind. If there is somewhere to go back to —
    // the page whose link you followed — go there, and the whole thing reads
    // as the link having opened an application. If there is nothing behind
    // us (the file was opened directly), stay put and say what happened;
    // main.js paints that once the DOM exists.
    if (history.length > 1) {
      outcome.reason = 'went back';
      setTimeout(() => { try { history.back(); } catch { /* stay */ } }, 120);
    } else {
      outcome.reason = 'nowhere to go back to';
    }
  }

  // Opens the window. The features are a REQUEST — measured to be ignored
  // outright when a window of this name already exists — so the window sizes
  // itself once it is there; window-size.js does that on every launch.
  function spawn(want) {
    const features = [
      'popup=yes',
      `width=${Math.round(want.w)}`,
      `height=${Math.round(want.h)}`,
      // Centred. A window that opens in a corner reads as an accident; one
      // that opens in the middle reads as deliberate.
      `left=${Math.max(0, Math.round((screen.availWidth - want.w) / 2))}`,
      `top=${Math.max(0, Math.round((screen.availHeight - want.h) / 2))}`,
      'resizable=yes',
      'scrollbars=no',
    ].join(',');
    try {
      const win = window.open(selfUrl(), NAME, features);
      if (win) {
        outcome.opened = true;
        outcome.reason = '';
        try { win.focus(); } catch { /* focus is a courtesy */ }
        return win;
      }
      outcome.reason = 'blocked';
    } catch (err) {
      outcome.reason = err.message;
    }
    return null;
  }

  N4DU.ownWindow = {
    NAME, outcome, remember, isOwnWindow,
    stopAsking() { try { localStorage.setItem(OPT_OUT, '1'); } catch { /* ignore */ } },
    // The button path: no "should we?" checks, because you asked for it.
    // `want` is in INNER pixels, which is what the interface measures; the
    // few pixels of frame are made up by the window resizing itself.
    open(want) { return !!spawn(want || readStored()); },
  };

  popOut();

})(window.N4DU ??= {});
