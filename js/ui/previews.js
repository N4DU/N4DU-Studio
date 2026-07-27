// Miniaturas: vista previa del panel y avatar del hero.

import { state } from '../state.js';
import { renderOutput } from '../core/render.js';
import { shapeLabel } from '../core/geometry.js';
import { FORMATS, outputDims } from '../core/exporter.js';

// Miniatura fiel a la salida (misma proporción y forma), sobre fondo
// a cuadros para ver la transparencia.
export function drawThumb() {
  if (!state.img) return;
  const { W, H } = outputDims(state);
  const MAX = 90;
  const s = Math.min(MAX / W, MAX / H, 1);
  const w = Math.max(1, Math.round(W * s));
  const h = Math.max(1, Math.round(H * s));

  const out = renderOutput(state, w, h);
  const c = document.getElementById('thumbCanvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(out, 0, 0);

  document.getElementById('previewLabel').textContent =
    `${W}×${H} px · ${FORMATS[state.fmt].label} · ${shapeLabel(state)}`;
}

// Avatar decorativo del hero: siempre circular, recorte centrado.
export function drawHero() {
  if (!state.img) return;
  const S = 90;
  const c = document.getElementById('heroCanvas');
  c.width = c.height = S;
  c.style.display = 'block';
  document.querySelector('.hero-circle-icon').style.display = 'none';

  const ctx = c.getContext('2d');
  const side = Math.min(state.origW, state.origH);
  const sx = (state.origW - side) / 2;
  const sy = (state.origH - side) / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
  ctx.clip();
  ctx.drawImage(state.img, sx, sy, side, side, 0, 0, S, S);
  ctx.restore();
}
