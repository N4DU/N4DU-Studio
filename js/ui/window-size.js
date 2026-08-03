// Sizing the window to the work.
//
// A converter holding one file should not occupy a nine-hundred-pixel
// window. When N4DU Studio runs in its own window (the compact window the
// launcher opens), the page measures what it actually needs and resizes to
// fit — small for one file, taller as the batch grows, and roomy in the
// editor.
//
// In an ordinary browser tab resizeTo does nothing, which is the correct
// outcome: nobody wants a web page moving their tabs around.
(function (N4DU) {

  const WIDTH = 452;           // the compact window: half the area of the old one
  const EDITOR = { w: 1240, h: 880 };
  // The empty converter still has to be usable. 330 was below the height at
  // which the settings rows and the drop zone stop fitting one under the
  // other, and apply(WIDTH, MIN_H) runs at every launch — so every launch
  // flashed through a broken layout on its way to the right size.
  const MIN_H = 440;
  const SLACK = 6;             // ignore differences this small

  // The last size we asked for. If the window no longer matches it, the
  // person moved or resized it by hand — from then on this stays out of
  // the way. A tool that keeps undoing your resize is infuriating.
  let asked = null;
  let manual = false;

  function canResize() {
    return typeof window.resizeTo === 'function' && !manual;
  }

  // How tall the converter's contents really are, measured rather than
  // guessed: the settings block changes height with the format (the quality
  // row comes and goes) and the file grid grows by rows.
  function convertHeight() {
    const app = document.querySelector('.app');
    const convert = document.getElementById('convertView');
    if (!app || !convert) return MIN_H;

    const chrome = document.querySelector('.titlebar').offsetHeight +
                   document.querySelector('.statusbar').offsetHeight;
    const style = getComputedStyle(convert);
    const pad = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const gap = parseFloat(style.rowGap || style.gap) || 0;

    const blocks = [...convert.children];
    let content = 0;
    for (const block of blocks) {
      // The file list is the one part that stretches, so ask for its
      // natural height instead of the height it happens to have.
      content += block.classList.contains('conv-files')
        ? naturalFilesHeight(block)
        : block.offsetHeight + midGrowth(block);
    }
    // A couple of pixels of headroom: rounding a fraction the wrong way
    // clips the last row of files and puts a scrollbar on a list that fits.
    return chrome + pad + gap * Math.max(0, blocks.length - 1) + content + 4;
  }

  // The destination panel: what it takes up now, and what it is heading for.
  //
  // Both include the row gap the flex parent puts above it, because that gap
  // is part of what appears and disappears — shut, the panel cancels it with
  // a negative margin of the same size, so its whole contribution is zero.
  //
  // "Heading for" matters because the panel slides open over 160ms: for most
  // of that time its height is neither nothing nor everything, and sizing
  // the window to a height that is about to change is how the window ends up
  // chasing the panel instead of moving with it.
  function panelBox() {
    const panel = document.querySelector('.conv-dest-opts');
    if (!panel || !panel.parentElement) return { now: 0, target: 0 };
    const gap = parseFloat(getComputedStyle(panel.parentElement).rowGap) || 0;
    const margin = parseFloat(getComputedStyle(panel).marginTop) || 0;
    return {
      now: panel.offsetHeight + margin + gap,
      target: panel.classList.contains('open') ? panel.scrollHeight + gap : 0,
    };
  }

  // The panel's final height, added to the floor rather than left to compete
  // with it.
  //
  // The floor is what the EMPTY converter needs to be usable, and with
  // nothing in the list the layout comes in a few pixels under it — so
  // opening a panel 27 pixels tall moved the window by six, and the drop
  // zone quietly gave up the other twenty-one and took them back when the
  // panel closed. The panel is not part of what the floor is for: whatever
  // it takes, the window takes too, and nothing in between has to move.
  function panelFloor() {
    return panelBox().target;
  }

  // What this block will be once the panel has finished moving.
  function midGrowth(block) {
    if (!block.querySelector('.conv-dest-opts')) return 0;
    const box = panelBox();
    return box.target - box.now;
  }

  function naturalFilesHeight(block) {
    let total = 0;
    for (const child of block.children) {
      if (child.hidden) continue;
      if (child.id === 'fileGrid') total += gridHeight(child);
      else if (child.id === 'convertDrop') total += naturalDropHeight(child);
      else total += child.offsetHeight;
    }
    const style = getComputedStyle(block);
    const gap = parseFloat(style.rowGap || style.gap) || 0;
    const visible = [...block.children].filter(c => !c.hidden).length;
    return total + gap * Math.max(0, visible - 1);
  }

  // The height the drop zone WANTS.
  //
  // Same trap as the grid, and worse: the drop zone is told to take whatever
  // room is going, so its offsetHeight is simply the height of the window it
  // is already in. Measuring that and then sizing the window to it means the
  // window can only ever grow. Add the lines up instead, and respect the
  // floor the stylesheet sets — that floor is the whole point of the box.
  function naturalDropHeight(drop) {
    const style = getComputedStyle(drop);
    const gap = parseFloat(style.rowGap || style.gap) || 0;
    const box = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) +
                parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const lines = [...drop.children].filter(c => !c.hidden && c.offsetHeight > 0);
    let content = box + gap * Math.max(0, lines.length - 1);
    for (const line of lines) content += line.offsetHeight;
    return Math.max(content, parseFloat(style.minHeight) || 0);
  }

  // The height the file grid WANTS, counted in rows.
  //
  // Not scrollHeight: the grid is a flex child that stretches to fill the
  // window, so scrollHeight reports the stretched height and every batch
  // size looks identical. Counting rows is the only reading that reflects
  // the contents.
  function gridHeight(grid) {
    const tiles = grid.children.length;
    if (!tiles) return 0;
    const style = getComputedStyle(grid);
    const perRow = Math.max(1, style.gridTemplateColumns.split(' ').filter(Boolean).length);
    const gap = parseFloat(style.rowGap || style.gap) || 0;
    const rowH = grid.firstElementChild.offsetHeight;
    const rows = Math.ceil(tiles / perRow);
    return rows * rowH + (rows - 1) * gap;
  }

  // Applies a size, in INNER pixels. The window frame is measured rather
  // than assumed: it differs between Windows, macOS and Linux, and between
  // an app window and a tab.
  let lastApply = null;      // what the last call decided, for the tests
  const applyLog = [];
  function apply(innerW, innerH) {
    lastApply = { innerH, why: 'ok', open: !!document.querySelector('.conv-dest-opts.open'),
                  floor: MIN_H + panelFloor(), n: applyLog.length };
    applyLog.push(lastApply);
    if (applyLog.length > 40) applyLog.shift();
    if (!canResize()) { lastApply.why = 'manual'; return; }
    const frameW = window.outerWidth - window.innerWidth;
    const frameH = window.outerHeight - window.innerHeight;
    const maxH = (window.screen.availHeight || 1080) - 60;
    const maxW = (window.screen.availWidth || 1920) - 60;

    const w = Math.min(innerW + frameW, maxW);
    const h = Math.min(Math.max(innerH, MIN_H + panelFloor()) + frameH, maxH);
    lastApply.w = w; lastApply.h = h;
    lastApply.outer = { w: window.outerWidth, h: window.outerHeight };
    if (Math.abs(w - window.outerWidth) < SLACK && Math.abs(h - window.outerHeight) < SLACK) {
      lastApply.why = 'already there';
      // Nothing to do IS the window having been sized: the launcher got it
      // right. Without this the first real change of the session — opening
      // the destination panel — would be taken for the startup correction
      // and jump instead of gliding.
      if (!sizedOnce) { sizedOnce = true; reportSize(); }
      return;   // already the right size; resizing again would only flicker
    }
    // Twice ignored is twice too many. Some environments do not honour
    // resizeTo at all — a window manager that refuses, a kiosk, a window
    // the person has pinned — and nothing here noticed: every repaint saw
    // the same gap between what the window is and what it should be, and
    // asked again, for ever. One request per repaint, for the life of the
    // session, none of them granted.
    if (refused() && ++ignored >= IGNORED_LIMIT) { manual = true; return; }
    if (!refused()) ignored = 0;
    glideTo(Math.round(w), Math.round(h));
  }

  // Growing and shrinking, over about a sixth of a second.
  //
  // One resizeTo is one jump: the window snaps to its new height while the
  // page inside it reflows to a size it does not have yet, so for a frame
  // the drop zone is squashed and the file grid has rewrapped — and then it
  // all pops into place. Choosing "To a folder" moves the window 27 pixels
  // and that was enough to read as a glitch rather than as a panel opening.
  //
  // A handful of steps costs nothing and turns the jump into a movement.
  // Only for small changes: coming back from the editor is 1240x880 to
  // 452x440 and there is nothing pleasant about watching that crawl.
  const GLIDE_MS = 160;
  const GLIDE_MAX = 260;      // beyond this a jump is the kinder answer
  let gliding = null;
  let sizedOnce = false;     // has the window been sized once already?
  // How many times in a row a resize was asked for and simply not granted.
  //
  // Some environments ignore resizeTo outright — a window manager that
  // refuses, a kiosk, a browser with the window pinned. Nothing here
  // noticed: every repaint measured the same gap between what the window is
  // and what it should be, and asked again, for ever. Two refusals is
  // enough to take the hint and leave the window alone, the same way a
  // resize by hand does.
  let ignored = 0;
  const IGNORED_LIMIT = 2;

  function glideTo(w, h) {
    cancelAnimationFrame(gliding);
    const from = { w: window.outerWidth, h: window.outerHeight };
    // The first one is a jump, never a glide.
    //
    // The launcher opens the window at roughly the right size and the page
    // corrects whatever is left over — the title bar an --app window draws
    // is not something Python can measure from outside. Animating that
    // correction turns "the window opened" into "the window opened and then
    // resized itself in front of me", which reads as a fault whichever
    // direction it goes in. Done in one step, inside the first moments of
    // the page appearing, there is nothing to see.
    if (!sizedOnce) {
      sizedOnce = true;
      asked = { w, h, at: Date.now() };
      try { window.resizeTo(w, h); } catch { /* a normal tab: nothing to do */ }
      reportSize();
      return;
    }
    // Recorded once, and as the DESTINATION: the steps on the way are not
    // sizes anybody asked for, and treating them as such would make the
    // window's own movement look like somebody dragging its corner.
    asked = { w, h, at: Date.now() };
    const far = Math.abs(w - from.w) > GLIDE_MAX || Math.abs(h - from.h) > GLIDE_MAX;
    if (far || !window.requestAnimationFrame) {
      try { window.resizeTo(w, h); } catch { /* a normal tab: nothing to do */ }
      return;
    }
    // The clock starts on the first frame, not on this line. The panel below
    // is animated by the browser, and its transition starts when the style
    // change is committed — one frame after the click that caused it. Timing
    // the window from the click instead put it a frame ahead of the panel,
    // and a frame of disagreement between the two is a frame of the drop
    // zone being squeezed.
    let t0 = null;
    let sent = null;
    const step = () => {
      const now = (globalThis.performance || Date).now();
      if (t0 === null) { t0 = now; gliding = requestAnimationFrame(step); return; }
      const k = Math.min(1, (now - t0) / GLIDE_MS);
      // Fast at first, gentle at the end: the eye follows the start and
      // forgives the finish, which is the opposite of a linear ramp.
      // easeOutCubic. The panel below uses cubic-bezier(.33,1,.68,1), which
      // is the same curve: the two have to agree or they pull against each
      // other and something in between gets squeezed.
      const e = 1 - Math.pow(1 - k, 3);
      const at = { w: Math.round(from.w + (w - from.w) * e),
                   h: Math.round(from.h + (h - from.h) * e) };
      // The tail of an ease-out rounds to the same pixel several frames
      // running. Asking the window manager for the size it already has is
      // work for nothing, and on some of them it is a visible flicker.
      try {
        if (!sent || sent.w !== at.w || sent.h !== at.h) {
          window.resizeTo(at.w, at.h);
          sent = at;
        }
      } catch { return; }        // a normal tab: stop, nothing is broken
      // The clock keeps running while this glides, so the destination is
      // re-stamped: a resize event arriving mid-glide is ours, not yours.
      asked.at = Date.now();
      if (k < 1) gliding = requestAnimationFrame(step);
    };
    step();
  }

  // Tells the helper what the window really came out as, once, a moment
  // after it has settled — so the NEXT launch opens at exactly that size and
  // has nothing to correct. The frame is the part the launcher cannot know
  // from outside: an --app window still draws a title bar, and how tall it
  // is depends on the platform, the theme and the display scaling.
  //
  // Only from a window of our own, and only a size that was actually
  // granted: reporting the size of a browser tab would teach the launcher
  // to open at the size of somebody's maximised browser.
  let reported = false;
  function reportSize() {
    if (reported) return;
    reported = true;
    setTimeout(() => {
      if (!N4DU.ownWindow || !N4DU.ownWindow.isOwnWindow()) return;
      if (!N4DU.bridge || !N4DU.bridge.rememberWindow) return;
      // The window has to have taken the size we asked for. If it did not,
      // what it is now is not something to teach anybody.
      if (asked && (Math.abs(window.outerWidth - asked.w) > 24 ||
                    Math.abs(window.outerHeight - asked.h) > 24)) return;
      N4DU.bridge.rememberWindow(window.outerWidth, window.outerHeight);
    }, 900);
  }

  // Was the last thing we asked for ever granted?
  //
  // Checked here, on the way in, rather than on a timer after the fact: by
  // the time another size is being asked for, the previous request has had
  // however long the page took to decide it wants a different one, which is
  // far longer than any window manager needs.
  function refused() {
    if (!asked || Date.now() - asked.at < 500) return false;
    return Math.abs(window.outerHeight - asked.h) > 24 ||
           Math.abs(window.outerWidth - asked.w) > 24;
  }

  // Called after anything that changes the contents.
  //
  // `now` skips the settle time, for the one case that needs it: a control
  // that starts its own animation in the same breath. The window and that
  // animation have to set off together — sixty milliseconds of the panel
  // opening while the window has not moved is sixty milliseconds of the
  // drop zone being squashed to make room, which is the jolt this whole
  // arrangement exists to avoid.
  let pending = null;
  function fit(now = false) {
    clearTimeout(pending);
    const measure_ = () => {
      if (document.body.classList.contains('mode-edit')) {
        apply(EDITOR.w, EDITOR.h);
        return;
      }
      // Files still arriving. Right-clicking a folder hands over twenty of
      // them, each one repainting the list and asking for a size — so the
      // window jumped twenty times on its way to the right shape, which
      // looks like a fault rather than like settling. Worse, a window
      // manager answering those requests late made one of them look like
      // the user resizing the window by hand, and that switches this file
      // off for the session: the window then stayed at whatever size it
      // happened to be, holding a list far too long for it, with a
      // scrollbar. Wait for the last file and size once — nothing is being
      // polled for here: the batch reports again when the load finishes,
      // and that report comes back through here.
      if (N4DU.batch && N4DU.batch.loading()) return;
      // Width first, height second. How many rows the file grid needs
      // depends on how wide it is, so measuring before the width has
      // settled — coming back from the editor, say — sizes the window for a
      // layout that is about to change.
      if (Math.abs(window.innerWidth - WIDTH) > SLACK) {
        apply(WIDTH, Math.max(MIN_H, window.innerHeight));
        setTimeout(() => apply(WIDTH, convertHeight()), 140);
        return;
      }
      apply(WIDTH, convertHeight());
    };
    // One frame of settle time by default: this usually runs right after
    // the list has been redrawn.
    if (now) measure_();
    else pending = setTimeout(measure_, 60);
  }

  function init() {
    // Anything the user does to the window by hand switches this off for
    // the rest of the session.
    window.addEventListener('resize', () => {
      if (!asked) return;
      // Only a window of our own has a size worth remembering. In an
      // ordinary tab resizeTo does nothing, so `asked` is set and never
      // granted — which makes every resize of the BROWSER look like the
      // user resizing our window. Open the page in a maximised tab, nudge
      // the browser or open devtools, and 1100x800 was stored as the size
      // of the compact window; the next visit popped out at 1100x800.
      if (!(N4DU.ownWindow && N4DU.ownWindow.isOwnWindow())) return;
      // Our own resize lands here too, and the window manager may round or
      // clamp what it grants — so only a change well after our request, and
      // well away from what we asked for, counts as the user's doing.
      if (Date.now() - asked.at < 700) return;
      const off = () => Math.abs(window.outerWidth - asked.w) > 24 ||
                        Math.abs(window.outerHeight - asked.h) > 24;
      if (!off()) return;
      // And it has to still be true a moment later. A window manager
      // animating or deferring one of OUR resizes delivers the event late
      // and at an in-between size, which reads exactly like somebody
      // dragging the corner — and getting that wrong switches the sizing
      // off for the rest of the session, which is how a window full of
      // files ended up stuck at the size it had when the first one arrived.
      // Nobody drags a corner and puts it back within 400ms.
      setTimeout(() => {
        if (!asked || !off()) return;
        manual = true;
        settled();
      }, 400);
    });
  }

  // What to do once a resize really was the user's.
  function settled() {
      // And remembered, so the next launch opens at the size you chose.
      // Re-opening the link re-loads the window, and without this it would
      // shrink back to 452 every time — undoing a deliberate resize is the
      // kind of thing that makes a tool feel like it is arguing with you.
      // Inner pixels, because that is what spawn() asks window.open for.
      // Storing outer and requesting inner added the frame back on every
      // cycle, so a window resized and reopened a few times crept steadily
      // larger for no reason anybody asked for.
      if (N4DU.ownWindow) N4DU.ownWindow.remember(window.innerWidth, window.innerHeight);
  }

  // The size the converter would ask for, without asking for it. Exposed so
  // the sizing can be checked in a normal page, where resizeTo does nothing.
  const measure = () => ({ w: WIDTH, h: Math.max(MIN_H, convertHeight()) });

  // Nothing is applied here, at parse time, and that is the point.
  //
  // There used to be an apply(WIDTH, MIN_H) on this line: shrink first, then
  // grow into place. It ran before the layout had settled, so its idea of
  // the height was whatever the window happened to be — it asked for the
  // size the window already was, marked the window as sized, and left the
  // real correction to be ANIMATED a moment later. Open, pause, resize:
  // exactly the thing it was there to avoid.
  //
  // The launcher opens the window at the size the page settled on last time
  // (appstate.load_window_size), so there is usually nothing to correct at
  // all. When there is — a first run, a new screen, a different scaling —
  // the first fit() does it in one step, off a layout that is real.

  // What this module currently believes, for the tests: whether it has
  // stepped aside, and what it last asked for.
  const state = () => ({ manual, ignored, asked, floor: MIN_H + panelFloor(),
                         last: lastApply, log: applyLog });

  N4DU.windowSize = { init, fit, measure, state };

})(window.N4DU ??= {});
