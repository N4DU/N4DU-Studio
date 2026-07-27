// Metadata de formatos para la interfaz. El procesamiento real y la lista de
// formatos disponibles vienen del backend (server.py); acá solo vive lo que la
// UI necesita para mostrar etiquetas, el slider de calidad, los avisos y la
// vista previa.
(function (N4DU) {

  const FORMATS = {
    png:  { label: 'PNG',  lossy: false, alpha: true  },
    jpeg: { label: 'JPG',  lossy: true,  alpha: false },
    webp: { label: 'WEBP', lossy: true,  alpha: true  },
    avif: { label: 'AVIF', lossy: true,  alpha: true  },
    bmp:  { label: 'BMP',  lossy: false, alpha: false },
    ico:  { label: 'ICO',  lossy: false, alpha: true  },
  };

  const ICO_MAX = 256; // el formato ICO admite hasta 256×256

  // Dimensiones reales de salida (mismo cálculo que el backend).
  function outputDims(state) {
    let W = Math.max(1, Math.round(state.outW));
    let H = Math.max(1, Math.round(state.outH));
    if (state.fmt === 'ico' && (W > ICO_MAX || H > ICO_MAX)) {
      const s = ICO_MAX / Math.max(W, H);
      W = Math.max(1, Math.round(W * s));
      H = Math.max(1, Math.round(H * s));
    }
    return { W, H };
  }

  N4DU.FORMATS = FORMATS;
  N4DU.outputDims = outputDims;

})(window.N4DU ??= {});
