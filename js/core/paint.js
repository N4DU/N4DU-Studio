// Pixel operations, and nothing else.
//
// Everything here takes what it needs as an argument and gives back what it
// produced. No surface, no history, no undo — those belong to edit.js, which
// owns the picture being edited and decides when to snapshot it.
//
// The line is drawn there on purpose: this file can be read one function at
// a time, and getting it wrong shows up as wrong pixels rather than as a
// document that quietly lost its past.
(function (N4DU) {

  // Does this browser support canvas filters? Safari only gained them
  // recently, so a manual blur is kept as a fallback.
  let filterSupport = null;
  function hasFilter() {
    if (filterSupport === null) {
      const ctx = new OffscreenCanvas(1, 1).getContext('2d');
      ctx.filter = 'blur(1px)';
      filterSupport = ctx.filter !== 'none';
    }
    return filterSupport;
  }

  // Blurs a region of src into ctx (which must be w×h). Uses the native
  // filter when available, otherwise a separable box blur — three passes
  // approximate a Gaussian closely enough to look the same.
  function blurInto(ctx, src, sx, sy, w, h, radius) {
    if (hasFilter()) {
      ctx.filter = `blur(${radius}px)`;
      ctx.drawImage(src, sx, sy, w, h, 0, 0, w, h);
      ctx.filter = 'none';
      return;
    }
    ctx.drawImage(src, sx, sy, w, h, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    const r = Math.max(1, Math.round(radius * 0.6));
    for (let pass = 0; pass < 3; pass++) {
      boxBlurPass(img.data, w, h, r, true);
      boxBlurPass(img.data, w, h, r, false);
    }
    ctx.putImageData(img, 0, 0);
  }

  // One box-blur pass over rows (horizontal) or columns (vertical).
  function boxBlurPass(d, w, h, r, horizontal) {
    const outer = horizontal ? h : w;
    const inner = horizontal ? w : h;
    const stride = horizontal ? 4 : w * 4;
    const jump = horizontal ? w * 4 : 4;
    const line = new Float32Array(inner * 4);

    for (let o = 0; o < outer; o++) {
      const base = o * jump;
      for (let i = 0; i < inner; i++) {
        const p = base + i * stride;
        line[i * 4] = d[p]; line[i * 4 + 1] = d[p + 1];
        line[i * 4 + 2] = d[p + 2]; line[i * 4 + 3] = d[p + 3];
      }
      let sr = 0, sg = 0, sb = 0, sa = 0, count = 0;
      // Prime the window.
      for (let i = 0; i <= r && i < inner; i++) {
        sr += line[i * 4]; sg += line[i * 4 + 1];
        sb += line[i * 4 + 2]; sa += line[i * 4 + 3]; count++;
      }
      for (let i = 0; i < inner; i++) {
        const p = base + i * stride;
        d[p] = sr / count; d[p + 1] = sg / count;
        d[p + 2] = sb / count; d[p + 3] = sa / count;
        const add = i + r + 1, drop = i - r;
        if (add < inner) {
          sr += line[add * 4]; sg += line[add * 4 + 1];
          sb += line[add * 4 + 2]; sa += line[add * 4 + 3]; count++;
        }
        if (drop >= 0) {
          sr -= line[drop * 4]; sg -= line[drop * 4 + 1];
          sb -= line[drop * 4 + 2]; sa -= line[drop * 4 + 3]; count--;
        }
      }
    }
  }

  // Bounding box of a set of points, padded and clipped to the picture.
  //
  // The bounds come in as arguments rather than being read off a surface:
  // that is the whole difference between a function you can reason about
  // alone and one you have to run the program to understand.
  function strokeBox(points, pad, bounds) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const p of points) {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    if (minX === Infinity) return null;
    const x = Math.max(0, Math.floor(minX - pad));
    const y = Math.max(0, Math.floor(minY - pad));
    const x2 = Math.min(bounds.width, Math.ceil(maxX + pad));
    const y2 = Math.min(bounds.height, Math.ceil(maxY + pad));
    if (x2 <= x || y2 <= y) return null;
    return { x, y, w: x2 - x, h: y2 - y };
  }

  function tracePath(ctx, points, width) {
    if (points.length === 1) {
      // A single tap still paints a dot.
      const p = points[0];
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(0.5, width / 2), 0, Math.PI * 2);
      ctx.fillStyle = ctx.strokeStyle;
      ctx.fill();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
  }

  N4DU.paint = { hasFilter, blurInto, strokeBox, tracePath };

})(window.N4DU ??= {});
