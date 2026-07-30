// Crop box: a rectangle over the picture with handles on its corners and
// edges. Drag a handle to pull that side in, drag inside to move the whole
// box. The pointer changes to the matching resize arrow as you approach an
// edge, the way a window resize behaves.
(function (N4DU) {

  const { state } = N4DU;

  // How close (in screen pixels) the pointer must be to grab an edge.
  const GRAB = 10;
  const MIN_SIZE = 8;   // smallest crop, in image pixels

  // Which part of the box is under the pointer, and the cursor for it.
  const CURSORS = {
    nw: 'nwse-resize', se: 'nwse-resize',
    ne: 'nesw-resize', sw: 'nesw-resize',
    n: 'ns-resize', s: 'ns-resize',
    w: 'ew-resize', e: 'ew-resize',
    inside: 'move',
    outside: 'crosshair',
  };

  // Returns the handle under a screen point, given the box in screen space.
  function hitTest(sx, sy, box) {
    const nearL = Math.abs(sx - box.x) <= GRAB;
    const nearR = Math.abs(sx - (box.x + box.w)) <= GRAB;
    const nearT = Math.abs(sy - box.y) <= GRAB;
    const nearB = Math.abs(sy - (box.y + box.h)) <= GRAB;
    const withinX = sx >= box.x - GRAB && sx <= box.x + box.w + GRAB;
    const withinY = sy >= box.y - GRAB && sy <= box.y + box.h + GRAB;

    if (nearT && nearL) return 'nw';
    if (nearT && nearR) return 'ne';
    if (nearB && nearL) return 'sw';
    if (nearB && nearR) return 'se';
    if (nearT && withinX) return 'n';
    if (nearB && withinX) return 's';
    if (nearL && withinY) return 'w';
    if (nearR && withinY) return 'e';
    if (sx > box.x && sx < box.x + box.w && sy > box.y && sy < box.y + box.h) return 'inside';
    return 'outside';
  }

  // Applies a drag of (dx, dy) image pixels to the given handle.
  // bounds keeps the result inside the picture.
  function resize(rect, handle, dx, dy, bounds) {
    let { x, y, w, h } = rect;
    let x2 = x + w, y2 = y + h;

    if (handle === 'inside') {
      x = clamp(x + dx, 0, bounds.w - w);
      y = clamp(y + dy, 0, bounds.h - h);
      return { x, y, w, h };
    }
    if (handle.includes('w')) x = clamp(x + dx, 0, x2 - MIN_SIZE);
    if (handle.includes('e')) x2 = clamp(x2 + dx, x + MIN_SIZE, bounds.w);
    if (handle.includes('n')) y = clamp(y + dy, 0, y2 - MIN_SIZE);
    if (handle.includes('s')) y2 = clamp(y2 + dy, y + MIN_SIZE, bounds.h);
    return { x, y, w: x2 - x, h: y2 - y };
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // A box covering the whole picture, the starting point when the tool opens.
  function fullBox() {
    return { x: 0, y: 0, w: state.origW, h: state.origH };
  }

  N4DU.cropBox = { GRAB, MIN_SIZE, CURSORS, hitTest, resize, fullBox };

})(window.N4DU ??= {});
