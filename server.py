#!/usr/bin/env python3
"""
N4DU Studio — servidor local.

Sirve la interfaz (HTML/CSS/JS) y hace TODO el procesamiento de imágenes en
el backend con Pillow: recorte, redondeo, redimensionado, conversión de
formato y compresión por límite de peso. El navegador solo es la interfaz.

Corre en 127.0.0.1 (solo tu máquina, no queda expuesto en la red). Se
arranca con doble clic al lanzador (start.bat / start.command) o con:

    python3 server.py
"""

import io
import os
import sys
import json
import uuid
import socket
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse
from collections import OrderedDict

try:
    from PIL import Image, ImageDraw, features
except ImportError:
    sys.stderr.write(
        "\n[N4DU Studio] Falta Pillow. Instalalo con:\n"
        "    python3 -m pip install Pillow\n\n"
    )
    sys.exit(1)

ROOT = os.path.dirname(os.path.abspath(__file__))
HOST = "127.0.0.1"
PORT_RANGE = range(4517, 4537)  # se prueba el primero libre
MAX_SESSIONS = 8                # imágenes en memoria (se descarta la más vieja)
SUPERSAMPLE = 4                 # antialiasing de la máscara redondeada

# ── Formatos de salida ─────────────────────────────────────────────
# lossy = admite parámetro de calidad · alpha = admite transparencia
FORMATS = {
    "png":  {"pil": "PNG",  "ext": "png",  "label": "PNG",  "lossy": False, "alpha": True},
    "jpeg": {"pil": "JPEG", "ext": "jpg",  "label": "JPG",  "lossy": True,  "alpha": False},
    "webp": {"pil": "WEBP", "ext": "webp", "label": "WEBP", "lossy": True,  "alpha": True},
    "avif": {"pil": "AVIF", "ext": "avif", "label": "AVIF", "lossy": True,  "alpha": True},
    "bmp":  {"pil": "BMP",  "ext": "bmp",  "label": "BMP",  "lossy": False, "alpha": False},
    "ico":  {"pil": "ICO",  "ext": "ico",  "label": "ICO",  "lossy": False, "alpha": True},
}
ICO_MAX = 256  # el formato ICO admite hasta 256×256

# Sesiones: id -> imagen original (RGBA) en memoria. Se sube una vez y se
# reutiliza para cada estimación/exportación sin re-enviarla.
_sessions = OrderedDict()
_sessions_lock = threading.Lock()


# ── Detección de formatos disponibles en esta instalación de Pillow ──
def detect_formats():
    support = {}
    for key, f in FORMATS.items():
        try:
            probe = Image.new("RGBA", (4, 4), (255, 0, 0, 128))
            if not f["alpha"]:
                probe = probe.convert("RGB")
            buf = io.BytesIO()
            probe.save(buf, format=f["pil"])
            support[key] = True
        except Exception:
            support[key] = False
    return support


SUPPORT = detect_formats()


# ── Sesiones ────────────────────────────────────────────────────────
def store_image(img):
    sid = uuid.uuid4().hex
    with _sessions_lock:
        _sessions[sid] = img.convert("RGBA")
        _sessions.move_to_end(sid)
        while len(_sessions) > MAX_SESSIONS:
            _sessions.popitem(last=False)
    return sid


def get_image(sid):
    with _sessions_lock:
        img = _sessions.get(sid)
        if img is not None:
            _sessions.move_to_end(sid)
        return img


# ── Procesamiento (réplica de la lógica del front original) ─────────
def output_dims(p):
    """Dimensiones reales de salida (ICO se limita a 256)."""
    w = max(1, round(p["outW"]))
    h = max(1, round(p["outH"]))
    if p["fmt"] == "ico" and (w > ICO_MAX or h > ICO_MAX):
        s = ICO_MAX / max(w, h)
        w = max(1, round(w * s))
        h = max(1, round(h * s))
    return w, h


def rounded_mask(w, h, roundness):
    """Máscara de transparencia con esquinas redondeadas y antialiasing.
    roundness 0 = rectángulo completo · 100 = círculo (si es cuadrado)."""
    radius = (roundness / 100.0) * (min(w, h) / 2.0)
    ss = SUPERSAMPLE
    mask = Image.new("L", (w * ss, h * ss), 0)
    d = ImageDraw.Draw(mask)
    r = max(0, min(radius * ss, w * ss / 2, h * ss / 2))
    if r <= 0.5:
        d.rectangle([0, 0, w * ss - 1, h * ss - 1], fill=255)
    else:
        d.rounded_rectangle([0, 0, w * ss - 1, h * ss - 1], radius=r, fill=255)
    return mask.resize((w, h), Image.LANCZOS)


def render(src, p):
    """Compone la imagen final RGBA según los parámetros."""
    w, h = output_dims(p)
    ow, oh = src.size

    if p["mode"] == "crop":
        # Recorte cuadrado centrado en (cx, cy) con el zoom dado.
        side = min(ow, oh) / max(0.0001, p["zoom"])
        cx = min(max(p["cx"], side / 2), ow - side / 2)
        cy = min(max(p["cy"], side / 2), oh - side / 2)
        left = round(cx - side / 2)
        top = round(cy - side / 2)
        box = (left, top, left + round(side), top + round(side))
        region = src.crop(box)
    else:
        region = src

    out = region.resize((w, h), Image.LANCZOS).convert("RGBA")

    if p["roundness"] > 0:
        mask = rounded_mask(w, h, p["roundness"])
        # Combina con el alpha existente para no descartar transparencia previa
        base = out.getchannel("A")
        out.putalpha(Image.composite(base, Image.new("L", (w, h), 0), mask))

    return out


def encode(img, p):
    """Codifica la imagen al formato pedido. Devuelve bytes."""
    fmt = p["fmt"]
    f = FORMATS[fmt]
    quality = max(1, min(100, round(p["quality"] * 100)))
    buf = io.BytesIO()

    if not f["alpha"]:
        # Sin transparencia: se aplana sobre blanco.
        bg = Image.new("RGB", img.size, (255, 255, 255))
        bg.paste(img, mask=img.getchannel("A"))
        img = bg

    if fmt == "jpeg":
        img.save(buf, format="JPEG", quality=quality, optimize=True)
    elif fmt == "webp":
        img.save(buf, format="WEBP", quality=quality)
    elif fmt == "avif":
        img.save(buf, format="AVIF", quality=quality)
    elif fmt == "png":
        img.save(buf, format="PNG", optimize=True)
    elif fmt == "bmp":
        img.save(buf, format="BMP")
    elif fmt == "ico":
        w, h = img.size
        img.save(buf, format="ICO", sizes=[(w, h)])
    else:
        img.save(buf, format=f["pil"])
    return buf.getvalue()


def produce(src, p):
    """Renderiza + codifica respetando el límite de peso si lo hay."""
    data = encode(render(src, p), p)
    limit = p["maxKb"] * 1024 if p["maxKb"] else None
    if limit and len(data) > limit:
        data = fit_to_limit(src, p, limit)
    return data


def fit_to_limit(src, p, limit):
    f = FORMATS[p["fmt"]]

    # 1) Búsqueda binaria de calidad (formatos con pérdida)
    if f["lossy"]:
        img = render(src, p)
        found = _search_quality(img, p, limit)
        if found is not None:
            return found

    # 2) Reducir resolución progresivamente re-renderizando desde el original
    best = encode(render(src, p), p)
    scale = 0.9
    w0, h0 = output_dims(p)
    for _ in range(14):
        if min(w0, h0) * scale < 16:
            break
        q = dict(p, outW=max(1, round(w0 * scale)), outH=max(1, round(h0 * scale)))
        img = render(src, q)
        if f["lossy"]:
            data = _search_quality(img, q, limit)
            if data is None:
                data = encode_at(img, q, 0.05)
        else:
            data = encode(img, q)
        best = data
        if len(data) <= limit:
            return data
        scale *= 0.82
    return best


def encode_at(img, p, quality_frac):
    return encode(img, dict(p, quality=quality_frac))


def _search_quality(img, p, limit):
    """Mayor calidad cuyo peso quede bajo el límite, o None."""
    lo, hi, best = 0.02, p["quality"], None
    for _ in range(8):
        q = (lo + hi) / 2
        data = encode_at(img, p, q)
        if len(data) <= limit:
            best = data
            lo = q
        else:
            hi = q
    return best


def parse_params(raw):
    """Normaliza y valida los parámetros que manda el front."""
    fmt = str(raw.get("fmt", "png")).lower()
    if fmt not in FORMATS:
        fmt = "png"
    mode = "crop" if raw.get("mode") == "crop" else "original"
    max_kb = raw.get("maxKb")
    try:
        max_kb = int(max_kb) if max_kb not in (None, "", 0) else None
    except (TypeError, ValueError):
        max_kb = None
    return {
        "mode": mode,
        "cx": float(raw.get("cx", 0)),
        "cy": float(raw.get("cy", 0)),
        "zoom": max(1.0, float(raw.get("zoom", 1))),
        "roundness": max(0, min(100, int(raw.get("roundness", 0)))),
        "outW": max(1, int(raw.get("outW", 1))),
        "outH": max(1, int(raw.get("outH", 1))),
        "fmt": fmt,
        "quality": max(0.01, min(1.0, float(raw.get("quality", 0.92)))),
        "maxKb": max_kb,
        "name": str(raw.get("name", "imagen")),
    }


# ── Servidor HTTP ───────────────────────────────────────────────────
STATIC_TYPES = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".json": "application/json",
}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *args):
        pass  # silencioso

    # ── utilidades de respuesta ──
    def _json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _bytes(self, data, ctype, filename=None):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self):
        length = int(self.headers.get("Content-Length", 0))
        return self.rfile.read(length) if length else b""

    # ── GET: estáticos + info ──
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/formats":
            return self._json({"support": SUPPORT, "formats": {
                k: {"label": v["label"], "lossy": v["lossy"], "alpha": v["alpha"], "ext": v["ext"]}
                for k, v in FORMATS.items()}})
        if path == "/api/ping":
            return self._json({"ok": True})
        return self._serve_static(path)

    def _serve_static(self, path):
        if path in ("/", ""):
            path = "/index.html"
        # Evita salir del directorio del proyecto
        safe = os.path.normpath(os.path.join(ROOT, path.lstrip("/")))
        if not safe.startswith(ROOT) or not os.path.isfile(safe):
            self.send_error(404, "No encontrado")
            return
        ext = os.path.splitext(safe)[1].lower()
        ctype = STATIC_TYPES.get(ext, "application/octet-stream")
        with open(safe, "rb") as fh:
            data = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    # ── POST: subir, estimar, procesar ──
    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/upload":
                return self._upload()
            if path == "/api/estimate":
                return self._estimate()
            if path == "/api/process":
                return self._process()
        except Exception as exc:  # nunca tirar el servidor por una request
            return self._json({"error": str(exc)}, status=400)
        self.send_error(404, "No encontrado")

    def _upload(self):
        # El front sube un PNG a resolución completa (decodificado por el
        # navegador, así soporta hasta SVG). El backend lo guarda en memoria.
        raw = self._read_body()
        img = Image.open(io.BytesIO(raw))
        img.load()
        sid = store_image(img)
        return self._json({"id": sid, "width": img.width, "height": img.height})

    def _params_from_json(self):
        raw = json.loads(self._read_body() or b"{}")
        sid = raw.get("id")
        img = get_image(sid)
        if img is None:
            raise ValueError("Sesión no encontrada; volvé a cargar la imagen.")
        return img, parse_params(raw)

    def _estimate(self):
        img, p = self._params_from_json()
        data = produce(img, p)
        return self._json({"size": len(data)})

    def _process(self):
        img, p = self._params_from_json()
        data = produce(img, p)
        w, h = output_dims(p)
        f = FORMATS[p["fmt"]]
        filename = f"{p['name']}_{w}x{h}.{f['ext']}"
        ctype = {"png": "image/png", "jpeg": "image/jpeg", "webp": "image/webp",
                 "avif": "image/avif", "bmp": "image/bmp", "ico": "image/x-icon"}[p["fmt"]]
        return self._bytes(data, ctype, filename)


def find_port():
    for port in PORT_RANGE:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            if s.connect_ex((HOST, port)) != 0:  # libre
                return port
    return PORT_RANGE.start


def main():
    port = find_port()
    url = f"http://{HOST}:{port}/"
    server = ThreadingHTTPServer((HOST, port), Handler)

    avail = [FORMATS[k]["label"] for k, v in SUPPORT.items() if v]
    print("\n  N4DU Studio")
    print(f"  Servidor local: {url}")
    print(f"  Formatos de salida: {', '.join(avail)}")
    print("  (cerrá esta ventana o Ctrl+C para salir)\n")

    if "--no-browser" not in sys.argv:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n  Cerrando N4DU Studio…")
        server.shutdown()


if __name__ == "__main__":
    main()
