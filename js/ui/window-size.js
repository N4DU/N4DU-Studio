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

  const WIDTH = 640;           // comfortable for the settings rows
  const EDITOR = { w: 1240, h: 880 };
  const MIN_H = 430;
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
      total += child.id === 'fileGrid' ? gridHeight(child) : child.offsetHeight;
    }
    const style = getComputedStyle(block);
    const gap = parseFloat(style.rowGap || style.gap) || 0;
    const visible = [...block.children].filter(c => !c.hidden).length;
    return total + gap * Math.max(0, visible - 1);
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
      // Our own resize lands here too, and the window manager may round or
      // clamp what it grants — so only a change well after our request, and
      // well away from what we asked for, counts as the user's doing.
      if (Date.now() - asked.at < 700) return;
      const off = Math.abs(window.outerWidth - asked.w) > 24 ||
                  Math.abs(window.outerHeight - asked.h) > 24;
      if (off) manual = true;
    });
  }

  // The size the converter would ask for, without asking for it. Exposed so
  // the sizing can be checked in a normal page, where resizeTo does nothing.
  const measure = () => ({ w: WIDTH, h: Math.max(MIN_H, convertHeight()) });

  N4DU.windowSize = { init, fit, measure };

})(window.N4DU ??= {});
