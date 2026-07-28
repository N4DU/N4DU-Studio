#!/usr/bin/env python3
"""
N4DU Studio — puente al disco (opcional).

La app procesa las imágenes 100% en el navegador y funciona sola (podés
abrir index.html o usarla hosteada). Este programa agrega lo único que el
navegador no puede hacer: abrir archivos con el diálogo nativo del sistema
y REEMPLAZAR el original en disco al exportar (aunque cambie la extensión).

Sin dependencias: solo la biblioteca estándar de Python 3.8+.
Escucha únicamente en 127.0.0.1 (tu máquina; no queda expuesto a la red).

    python3 main.py        ← o doble clic en start.bat / start.command

Se cierra con Ctrl+C, o solo: al cerrar la página espera 3 segundos por si
fue un F5 y, si nadie vuelve, apaga el servidor.
"""

import io
import os
import sys
import json
import time
import socket
import secrets
import mimetypes
import subprocess
import threading
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

ROOT = os.path.dirname(os.path.abspath(__file__))
HOST = "127.0.0.1"
PORTS = range(4517, 4537)          # primer puerto libre del rango
GRACE_SECONDS = 3                  # espera tras cerrar la página (¿fue un F5?)
STALL_SECONDS = 6                  # sin latidos → se considera cerrada
ALLOWED_EXT = {"png", "jpg", "webp", "avif", "bmp", "ico"}

# Archivos abiertos: token efímero -> ruta real. El navegador solo conoce
# tokens; ningún endpoint acepta rutas arbitrarias.
_files = {}
_lock = threading.Lock()

# Estado de la página (para el auto-cierre)
_page = {"connected": False, "last_ping": 0.0, "closing_since": None}
_shutdown = {"event": threading.Event(), "reason": ""}


# ── Consola ─────────────────────────────────────────────────────────
def _supports_color():
    if os.name == "nt":
        os.system("")  # habilita secuencias ANSI en la consola de Windows
    return sys.stdout.isatty()


_COLOR = _supports_color()


def _c(code, text):
    return f"\033[{code}m{text}\033[0m" if _COLOR else text


_print_lock = threading.Lock()


def event(symbol, text, color="0"):
    stamp = _c("2", time.strftime("%H:%M:%S"))
    with _print_lock:
        print(f"  {stamp}  {_c(color, symbol + ' ' + text)}")


def banner(url):
    line = "─" * 46
    with _print_lock:
        print()
        print(_c("2", "  " + line))
        print("  " + _c("1;93", "N4DU Studio") + _c("2", "  ·  puente al disco"))
        print(_c("2", "  " + line))
        print(f"  Interfaz   {_c('96', url)}")
        print(f"  Salir      Ctrl+C  {_c('2', '(o cerrá la página)')}")
        print(_c("2", "  " + line))


# ── Diálogo nativo (en subproceso: tkinter exige su propio hilo main) ──
_PICKER_SCRIPT = """
import sys, tkinter as tk
from tkinter import filedialog
title = sys.argv[1] if len(sys.argv) > 1 else "N4DU Studio"
root = tk.Tk(); root.withdraw()
root.attributes("-topmost", True)
path = filedialog.askopenfilename(title=title, filetypes=[
    ("Imagenes", "*.png *.jpg *.jpeg *.jfif *.webp *.avif *.gif *.bmp *.ico *.svg *.tif *.tiff"),
    ("Todos los archivos", "*.*")])
print(path or "", end="")
"""

_PICK_TITLES = {
    "open":   "N4DU Studio - Abrir imagen",
    "target": "N4DU Studio - Elegir el archivo a reemplazar",
}


def native_pick(intent="open"):
    """Devuelve la ruta elegida, '' si canceló, o lanza si no hay tkinter."""
    test = os.environ.get("N4DU_TEST_PICK")  # gancho para tests automatizados
    if test is not None:
        return test
    title = _PICK_TITLES.get(intent, _PICK_TITLES["open"])
    proc = subprocess.run([sys.executable, "-c", _PICKER_SCRIPT, title],
                          capture_output=True, text=True)
    if proc.returncode != 0:
        raise RuntimeError(
            "No se pudo abrir el diálogo del sistema (falta tkinter). "
            "Usá el selector del navegador; el reemplazo no estará disponible.")
    return proc.stdout.strip()


# ── Reemplazo en disco ──────────────────────────────────────────────
def _safe_stem(name):
    """Nombre de archivo sin ruta ni caracteres inválidos (defensa en
    profundidad: el front ya limpia, pero el servidor no confía en él)."""
    name = os.path.basename(name or "")           # descarta cualquier ruta
    name = os.path.splitext(name)[0]              # descarta cualquier extensión
    for ch in '\\/:*?"<>|':
        name = name.replace(ch, "")
    name = name.strip().lstrip(".")
    return name


def replace_file(original, data, ext, new_stem=None):
    """Escribe los bytes en la carpeta del original con la extensión (y, si se
    indica, el nombre) nuevos, de forma atómica, y elimina el archivo anterior
    si la ruta resultante cambió."""
    if ext not in ALLOWED_EXT:
        raise ValueError(f"Extensión no permitida: {ext}")
    folder = os.path.dirname(original)
    stem = _safe_stem(new_stem) if new_stem else os.path.splitext(os.path.basename(original))[0]
    if not stem:
        raise ValueError("Nombre de archivo vacío.")
    target = os.path.join(folder, f"{stem}.{ext}")
    if os.path.dirname(os.path.abspath(target)) != os.path.abspath(folder):
        raise ValueError("Nombre de archivo inválido.")

    tmp = os.path.join(folder, f".{stem}.{secrets.token_hex(4)}.tmp")
    with open(tmp, "wb") as fh:
        fh.write(data)
    try:
        os.replace(tmp, target)  # atómico: nunca queda un archivo a medias
    except Exception:
        os.unlink(tmp)
        raise
    if os.path.abspath(target) != os.path.abspath(original):
        try:
            os.remove(original)
        except FileNotFoundError:
            pass
    return target


# ── Latidos de la página / auto-cierre ──────────────────────────────
def page_alive():
    _page["last_ping"] = time.time()
    if _page["closing_since"] is not None:
        _page["closing_since"] = None
        event("✓", "Página reconectada", "92")
    if not _page["connected"]:
        _page["connected"] = True


def request_shutdown(reason):
    if not _shutdown["event"].is_set():
        _shutdown["reason"] = reason
        _shutdown["event"].set()


def watchdog():
    while not _shutdown["event"].is_set():
        time.sleep(0.25)
        now = time.time()
        closing = _page["closing_since"]
        if closing is None:
            # ¿Se esfumó sin avisar? (se cerró el navegador de golpe)
            if _page["connected"] and now - _page["last_ping"] > STALL_SECONDS:
                _page["closing_since"] = now
                event("⚠", f"Se perdió la conexión — esperando {GRACE_SECONDS} s…", "93")
        elif now - closing >= GRACE_SECONDS and _page["last_ping"] <= closing:
            request_shutdown("La página se cerró.")


# ── Servidor HTTP ───────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass  # consola limpia: solo nuestros eventos

    # Toda petición de la API exige la cabecera X-N4DU (fuerza un preflight
    # CORS que este servidor no autoriza: ninguna web ajena puede invocarlo).
    def _guard(self):
        origin = self.headers.get("Origin", "")
        own = f"http://{HOST}:{self.server.server_address[1]}"
        if origin and origin != own:
            self._json({"error": "Origen no permitido"}, 403)
            return False
        if self.headers.get("X-N4DU") != "1":
            self._json({"error": "Falta cabecera"}, 403)
            return False
        return True

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))

    # ── GET ──
    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/api/ping":
            if not self._guard():
                return
            page_alive()
            return self._json({"ok": True})
        if path == "/api/read":
            return self._read()
        return self._static(path)

    # ── POST ──
    def do_POST(self):
        path = urlparse(self.path).path
        try:
            if path == "/api/bye":  # sendBeacon no admite cabeceras propias
                _page["closing_since"] = time.time()
                event("⚠", f"Página cerrada — esperando {GRACE_SECONDS} s por si fue un reinicio…", "93")
                return self._json({"ok": True})
            if not self._guard():
                return
            if path == "/api/hello":
                page_alive()
                event("✓", "Página conectada", "92")
                return self._json({"ok": True})
            if path == "/api/pick":
                return self._pick()
            if path == "/api/replace":
                return self._replace()
        except Exception as exc:  # una request mala nunca tira el servidor
            return self._json({"error": str(exc)}, 400)
        self.send_error(404)

    # ── Endpoints ──
    def _pick(self):
        intent = parse_qs(urlparse(self.path).query).get("intent", ["open"])[0]
        try:
            path = native_pick(intent)
        except RuntimeError as exc:
            return self._json({"error": str(exc)}, 501)
        if not path:
            self.send_response(204)  # canceló
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        if not os.path.isfile(path):
            return self._json({"error": "El archivo no existe."}, 400)
        token = secrets.token_urlsafe(16)
        with _lock:
            _files[token] = path
        verb = "A reemplazar" if intent == "target" else "Abierto"
        event("⬈", f"{verb}: {path}", "0")
        return self._json({"token": token, "path": path,
                           "name": os.path.basename(path)})

    def _read(self):
        if not self._guard():
            return
        token = parse_qs(urlparse(self.path).query).get("token", [""])[0]
        with _lock:
            path = _files.get(token)
        if not path or not os.path.isfile(path):
            return self._json({"error": "Archivo no disponible."}, 404)
        with open(path, "rb") as fh:
            data = fh.read()
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _replace(self):
        from urllib.parse import unquote
        token = self.headers.get("X-N4DU-Token", "")
        ext = self.headers.get("X-N4DU-Ext", "").lower().lstrip(".")
        new_stem = unquote(self.headers.get("X-N4DU-Name", ""))
        with _lock:
            original = _files.get(token)
        if not original:
            return self._json({"error": "No hay archivo abierto para reemplazar."}, 400)
        data = self._body()
        if not data:
            return self._json({"error": "No llegaron datos."}, 400)
        target = replace_file(original, data, ext, new_stem or None)
        with _lock:
            _files[token] = target  # próximos reemplazos siguen sobre el nuevo
        kb = len(data) / 1024
        peso = f"{kb/1024:.2f} MB" if kb >= 1024 else f"{kb:.0f} KB"
        old = os.path.basename(original)
        new = os.path.basename(target)
        detail = new if old == new else f"{old} → {new}"
        event("⟳", f"Reemplazado: {detail} ({peso})", "96")
        return self._json({"path": target, "name": new})

    # ── Estáticos ──
    def _static(self, path):
        # Pedir archivos de la interfaz durante la cuenta regresiva significa
        # que una página se está recargando: se cancela el cierre y el
        # vigilante de latidos retoma el control (si nunca llega el latido,
        # el servidor se cierra igual un rato después).
        if _page["closing_since"] is not None:
            _page["closing_since"] = None
            _page["last_ping"] = time.time()
        if path in ("/", ""):
            path = "/index.html"
        safe = os.path.normpath(os.path.join(ROOT, path.lstrip("/")))
        if not safe.startswith(ROOT) or not os.path.isfile(safe):
            self.send_error(404)
            return
        ctype = mimetypes.guess_type(safe)[0] or "application/octet-stream"
        with open(safe, "rb") as fh:
            data = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def free_port():
    for port in PORTS:
        with socket.socket() as s:
            if s.connect_ex((HOST, port)) != 0:
                return port
    return PORTS.start


def main():
    mimetypes.add_type("text/javascript", ".js")
    port = free_port()
    url = f"http://{HOST}:{port}/"
    server = ThreadingHTTPServer((HOST, port), Handler)

    banner(url)
    threading.Thread(target=watchdog, daemon=True).start()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    if "--no-browser" not in sys.argv:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()

    try:
        _shutdown["event"].wait()          # lo despierta el watchdog
        event("✓", _shutdown["reason"] + " Servidor cerrado. ¡Hasta luego!", "92")
    except KeyboardInterrupt:
        with _print_lock:
            print()
        event("✓", "Cerrado con Ctrl+C. ¡Hasta luego!", "92")
    server.shutdown()


if __name__ == "__main__":
    main()
