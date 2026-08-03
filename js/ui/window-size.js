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
        : block.offsetHeight;
    }
    // A couple of pixels of headroom: rounding a fraction the wrong way
    // clips the last row of files and puts a scrollbar on a list that fits.
    return chrome + pad + gap * Math.max(0, blocks.length - 1) + content + 4;
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
  function apply(innerW, innerH) {
    if (!canResize()) return;
    const frameW = window.outerWidth - window.innerWidth;
    const frameH = window.outerHeight - window.innerHeight;
    const maxH = (window.screen.availHeight || 1080) - 60;
    const maxW = (window.screen.availWidth || 1920) - 60;

    const w = Math.min(innerW + frameW, maxW);
    const h = Math.min(Math.max(innerH, MIN_H) + frameH, maxH);
    if (Math.abs(w - window.outerWidth) < SLACK && Math.abs(h - window.outerHeight) < SLACK) {
      return;   // already the right size; resizing again would only flicker
    }
    try {
      window.resizeTo(Math.round(w), Math.round(h));
      asked = { w: Math.round(w), h: Math.round(h), at: Date.now() };
    } catch { /* a normal tab: nothing to do, and nothing broken */ }
  }

  // Called after anything that changes the contents.
  let pending = null;
  function fit() {
    clearTimeout(pending);
    // One frame of settle time: this runs right after the list is redrawn.
    pending = setTimeout(() => {
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
    }, 60);
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

  // Immediately, before anything is painted: start at the smallest useful
  // size and grow from there.
  //
  // The launcher gives the window its own browser profile so --window-size
  // is honoured, but a window can still arrive too large — a browser that
  // ignores the flag, or a session restored from somewhere. Shrinking first
  // turns that into growing into place, which reads as the window settling
  // rather than as a glitch. In a normal tab resizeTo does nothing and this
  // costs nothing.
  apply(WIDTH, MIN_H);

  N4DU.windowSize = { init, fit, measure };

})(window.N4DU ??= {});
