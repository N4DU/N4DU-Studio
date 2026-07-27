// Estado central de la app. Único lugar donde viven los datos de edición.

export const state = {
  // Imagen cargada
  img: null,          // ImageBitmap
  origW: 0,
  origH: 0,
  fileName: '',       // nombre sin extensión
  fileSize: 0,        // bytes del archivo original
  fileLabel: '',      // nombre completo original

  // Modo de edición: 'original' (imagen completa) | 'crop' (recorte cuadrado)
  mode: 'original',

  // Recorte (solo modo 'crop'), en coordenadas de la imagen original
  cx: 0,
  cy: 0,
  zoom: 1,            // 1 = el lado corto entra completo en el recorte

  // Redondeo de esquinas: 0 = forma original, 100 = máximo (círculo si es cuadrado)
  roundness: 0,

  // Salida
  outW: 0,
  outH: 0,
  lockAspect: true,
  fmt: 'png',
  quality: 0.92,
  maxKb: null,
};

// Reinicia el estado para una imagen recién cargada.
export function resetForImage(bmp, file) {
  state.img = bmp;
  state.origW = bmp.width;
  state.origH = bmp.height;
  state.fileName = file.name.replace(/\.[^.]+$/, '') || 'imagen';
  state.fileSize = file.size;
  state.fileLabel = file.name;

  state.mode = 'original';
  state.cx = bmp.width / 2;
  state.cy = bmp.height / 2;
  state.zoom = 1;
  state.roundness = 0;

  state.outW = bmp.width;
  state.outH = bmp.height;
  state.lockAspect = true;
}
