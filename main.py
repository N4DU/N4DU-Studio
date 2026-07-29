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

import os
import sys
import json
import time
import secrets
import mimetypes
import subprocess
import threading
import webbrowser
from collections import OrderedDict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

ROOT = os.path.dirname(os.path.abspath(__file__))
HOST = "127.0.0.1"
PORTS = range(4517, 4537)          # primer puerto libre del rango
GRACE_SECONDS = 3                  # espera tras cerrar la página (¿fue un F5?)
# Sin latidos → se considera cerrada. Generoso a propósito: los navegadores
# frenan los temporizadores en pestañas de fondo (hasta ~1 por minuto), así
# que un umbral corto apagaría el servidor mientras seguís trabajando. El
# cierre normal no depende de esto: llega al instante por /api/bye.
STALL_SECONDS = 150
MAX_SESSIONS = 64                  # archivos recordados (se descarta el más viejo)
ALLOWED_EXT = {"png", "jpg", "webp", "avif", "bmp", "ico"}

# Secreto de esta ejecución. Autentica /api/bye, que no puede exigir cabeceras
# porque sendBeacon no las admite: sin esto, cualquier web abierta en otra
# pestaña podría apagar el servidor.
SECRET = secrets.token_urlsafe(24)

# Archivos abiertos: token efímero -> ruta real. El navegador solo conoce
# tokens; ningún endpoint acepta rutas arbitrarias.
_files = OrderedDict()
_lock = threading.Lock()

# Estado de la página (para el auto-cierre)
_page = {"connected": False, "last_ping": 0.0, "closing_since": None}
_shutdown = {"event": threading.Event(), "reason": ""}


# ── Consola ─────────────────────────────────────────────────────────
def _supports_color():
    if os.name == "nt":
        os.system("")  # habilita secuencias ANSI en la consola de Windows
    try:
        return sys.stdout.isatty()
    except Exception:
        return False


def _supports_unicode():
    """¿La consola puede mostrar los símbolos bonitos? En Windows con una
    codificación antigua (cp1252) imprimirlos lanzaría UnicodeEncodeError y
    tiraría el programa, así que se usan equivalentes ASCII."""
    try:
        "─✓⚠⟳⬈".encode(sys.stdout.encoding or "ascii")
        return True
    except (UnicodeEncodeError, LookupError, TypeError):
        return False


_COLOR = _supports_color()
_UNICODE = _supports_unicode()

# Símbolos de los eventos, con recambio ASCII si la consola no da para más.
SYM = {
    "ok": "✓" if _UNICODE else "*",
    "warn": "⚠" if _UNICODE else "!",
    "swap": "⟳" if _UNICODE else "~",
    "open": "⬈" if _UNICODE else ">",
    "line": "─" if _UNICODE else "-",
    "arrow": "→" if _UNICODE else "->",
}


def _c(code, text):
    return f"\033[{code}m{text}\033[0m" if _COLOR else text


_print_lock = threading.Lock()


def _write(text):
    """Imprime sin poder fallar por la codificación de la consola."""
    try:
        print(text)
    except UnicodeEncodeError:
        enc = sys.stdout.encoding or "ascii"
        print(text.encode(enc, "replace").decode(enc, "replace"))


def event(symbol, text, color="0"):
    stamp = _c("2", time.strftime("%H:%M:%S"))
    with _print_lock:
        _write(f"  {stamp}  {_c(color, symbol + ' ' + text)}")


def banner(url):
    line = SYM["line"] * 46
    dot = "·" if _UNICODE else "-"
    with _print_lock:
        _write("")
        _write(_c("2", "  " + line))
        _write("  " + _c("1;93", "N4DU Studio") + _c("2", f"  {dot}  puente al disco"))
        _write(_c("2", "  " + line))
        _write(f"  Interfaz   {_c('96', url)}")
        _write(f"  Salir      Ctrl+C  {_c('2', '(o cerra la pagina)' if not _UNICODE else '(o cerrá la página)')}")
        _write(_c("2", "  " + line))


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
# Nombres que Windows reserva para dispositivos: un archivo así no se puede
# crear (o se comporta de forma extraña), así que se les añade un guion bajo.
_WINDOWS_RESERVED = {
    "con", "prn", "aux", "nul",
    *(f"com{i}" for i in range(1, 10)),
    *(f"lpt{i}" for i in range(1, 10)),
}


def _safe_stem(name):
    """Nombre de archivo sin ruta ni caracteres inválidos (defensa en
    profundidad: el front ya limpia, pero el servidor no confía en él)."""
    name = os.path.basename(name or "")           # descarta cualquier ruta
    name = os.path.splitext(name)[0]              # descarta cualquier extensión
    for ch in '\\/:*?"<>|':
        name = name.replace(ch, "")
    name = "".join(c for c in name if ord(c) >= 32)   # sin caracteres de control
    # Windows no admite puntos ni espacios al final del nombre.
    name = name.strip().strip(".").strip()
    if name.lower() in _WINDOWS_RESERVED:
        name += "_"
    return name


def target_path(original, ext, new_stem=None):
    """Ruta que resultaría de reemplazar, sin escribir nada."""
    if ext not in ALLOWED_EXT:
        raise ValueError(f"Extensión no permitida: {ext}")
    folder = os.path.dirname(original)
    stem = _safe_stem(new_stem) if new_stem else os.path.splitext(os.path.basename(original))[0]
    if not stem:
        raise ValueError("Nombre de archivo vacío.")
    target = os.path.join(folder, f"{stem}.{ext}")
    if os.path.dirname(os.path.abspath(target)) != os.path.abspath(folder):
        raise ValueError("Nombre de archivo inválido.")
    return target


def replace_file(original, data, ext, new_stem=None, overwrite=False):
    """Escribe los bytes en la carpeta del original con la extensión (y, si se
    indica, el nombre) nuevos, de forma atómica, y elimina el archivo anterior
    si la ruta resultante cambió.

    Si el destino es OTRO archivo que ya existe, no se pisa nada: se lanza
    FileExistsError para que la interfaz pida confirmación (sin esto, un
    nombre repetido destruiría dos archivos: el ajeno y el original).

    Devuelve (ruta_final, aviso_o_None).
    """
    target = target_path(original, ext, new_stem)
    same_file = os.path.abspath(target) == os.path.abspath(original)

    if not same_file and os.path.exists(target) and not overwrite:
        raise FileExistsError(os.path.basename(target))

    folder = os.path.dirname(original)
    stem = os.path.splitext(os.path.basename(target))[0]
    tmp = os.path.join(folder, f".{stem}.{secrets.token_hex(4)}.tmp")
    with open(tmp, "wb") as fh:
        fh.write(data)
        fh.flush()
        os.fsync(fh.fileno())   # los bytes están en disco antes de publicar
    try:
        os.replace(tmp, target)  # atómico: nunca queda un archivo a medias
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise

    # El archivo nuevo ya está escrito: a partir de acá nada puede fallar de
    # forma que se pierda trabajo, así que un borrado fallido solo se avisa.
    warning = None
    if not same_file:
        try:
            os.remove(original)
        except FileNotFoundError:
            pass
        except OSError as exc:
            warning = f"No se pudo borrar {os.path.basename(original)} ({exc.strerror})."
    return target, warning


# ── Sesiones de archivos ────────────────────────────────────────────
def remember_file(path):
    """Guarda la ruta y devuelve un token. Descarta el más viejo si hace falta
    (sin esto la tabla crecería sin fin durante una sesión larga)."""
    token = secrets.token_urlsafe(16)
    with _lock:
        _files[token] = path
        _files.move_to_end(token)
        while len(_files) > MAX_SESSIONS:
            _files.popitem(last=False)
    return token


def lookup_file(token):
    with _lock:
        path = _files.get(token)
        if path is not None:
            _files.move_to_end(token)   # en uso: no lo descartes
        return path


# ── Latidos de la página / auto-cierre ──────────────────────────────
def page_alive():
    _page["last_ping"] = time.time()
    if _page["closing_since"] is not None:
        _page["closing_since"] = None
        event(SYM["ok"], "Página reconectada", "92")
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
            # ¿Se esfumó sin avisar? (se cerró el navegador de golpe). Solo
            # cuenta si alguna vez hubo página: si no, no hay nada que vigilar.
            if _page["connected"] and now - _page["last_ping"] > STALL_SECONDS:
                _page["closing_since"] = now
                event(SYM["warn"], f"Se perdió la conexión — esperando {GRACE_SECONDS} s…", "93")
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
        self._started = True
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", 0) or 0))

    # Ejecuta un handler sin dejar caer el servidor. Si la respuesta ya
    # empezó a enviarse no se puede mandar un error encima: se corta la
    # conexión para que el cliente no quede esperando bytes prometidos.
    def _safely(self, fn):
        self._started = False
        try:
            fn()
        except Exception as exc:
            if getattr(self, "_started", False):
                self.close_connection = True
            else:
                try:
                    self._json({"error": str(exc)}, 500)
                except Exception:
                    self.close_connection = True

    # ── GET ──
    def do_GET(self):
        self._safely(self._route_get)

    def _route_get(self):
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
        self._safely(self._route_post)

    def _route_post(self):
        path = urlparse(self.path).path
        # sendBeacon no admite cabeceras propias, así que /api/bye se
        # autentica con el secreto de esta ejecución en la URL. Solo la
        # página servida por este proceso lo conoce.
        if path == "/api/bye":
            token = parse_qs(urlparse(self.path).query).get("k", [""])[0]
            if not secrets.compare_digest(token, SECRET):
                return self._json({"error": "No autorizado"}, 403)
            _page["closing_since"] = time.time()
            event(SYM["warn"], f"Página cerrada — esperando {GRACE_SECONDS} s por si fue un reinicio…", "93")
            return self._json({"ok": True})
        if not self._guard():
            return
        if path == "/api/hello":
            page_alive()
            event(SYM["ok"], "Página conectada", "92")
            return self._json({"ok": True, "key": SECRET})
        if path == "/api/pick":
            return self._pick()
        if path == "/api/replace":
            return self._replace()
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
        token = remember_file(path)
        verb = "A reemplazar" if intent == "target" else "Abierto"
        event(SYM["open"], f"{verb}: {path}", "0")
        return self._json({"token": token, "path": path,
                           "name": os.path.basename(path)})

    def _read(self):
        if not self._guard():
            return
        token = parse_qs(urlparse(self.path).query).get("token", [""])[0]
        path = lookup_file(token)
        if not path or not os.path.isfile(path):
            return self._json({"error": "Archivo no disponible."}, 404)
        try:
            with open(path, "rb") as fh:
                data = fh.read()
        except OSError as exc:
            # Se leyó todo ANTES de enviar cabeceras: si falla, todavía se
            # puede responder un error limpio sin romper la conexión.
            return self._json({"error": f"No se pudo leer el archivo: {exc.strerror}"}, 500)
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        self._started = True
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _replace(self):
        token = self.headers.get("X-N4DU-Token", "")
        ext = self.headers.get("X-N4DU-Ext", "").lower().lstrip(".")
        new_stem = unquote(self.headers.get("X-N4DU-Name", ""))
        overwrite = self.headers.get("X-N4DU-Overwrite") == "1"
        original = lookup_file(token)
        if not original:
            return self._json({"error": "No hay archivo abierto para reemplazar."}, 400)
        if not os.path.isfile(original):
            return self._json(
                {"error": f"{os.path.basename(original)} ya no está en su carpeta."}, 410)
        data = self._body()
        if not data:
            return self._json({"error": "No llegaron datos."}, 400)

        try:
            target, warning = replace_file(original, data, ext, new_stem or None, overwrite)
        except FileExistsError as exc:
            # El destino es otro archivo que ya existe: no se pisa nada sin
            # que la persona lo confirme.
            return self._json({"error": f"Ya existe {exc}.", "conflict": str(exc)}, 409)

        with _lock:
            _files[token] = target  # próximos reemplazos siguen sobre el nuevo
        kb = len(data) / 1024
        peso = f"{kb/1024:.2f} MB" if kb >= 1024 else f"{kb:.0f} KB"
        old = os.path.basename(original)
        new = os.path.basename(target)
        detail = new if old == new else f'{old} {SYM["arrow"]} {new}'
        event(SYM["swap"], f"Reemplazado: {detail} ({peso})", "96")
        if warning:
            event(SYM["warn"], warning, "93")
        return self._json({"path": target, "name": new, "warning": warning})

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
        safe = os.path.normpath(os.path.join(ROOT, unquote(path).lstrip("/\\")))
        # Comparar con el separador incluido: sin él, una carpeta hermana que
        # empiece igual (Avatar_Studio_otra) pasaría el filtro.
        if not (safe == ROOT or safe.startswith(ROOT + os.sep)) or not os.path.isfile(safe):
            self.send_error(404)
            return
        ctype = mimetypes.guess_type(safe)[0] or "application/octet-stream"
        try:
            with open(safe, "rb") as fh:
                data = fh.read()
        except OSError:
            self.send_error(404)
            return
        self._started = True
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)


def start_server():
    """Levanta el servidor en el primer puerto libre. Se intenta enlazar de
    verdad (no solo sondear) para que nadie gane la carrera por el puerto."""
    last = None
    for port in PORTS:
        try:
            return ThreadingHTTPServer((HOST, port), Handler), port
        except OSError as exc:
            last = exc
    raise SystemExit(
        f"\n  No hay puertos libres entre {PORTS.start} y {PORTS.stop - 1}.\n"
        f"  ¿Ya tenés N4DU Studio abierto? Cerralo y volvé a intentar.\n"
        f"  ({last})\n")


def main():
    mimetypes.add_type("text/javascript", ".js")
    server, port = start_server()
    url = f"http://{HOST}:{port}/"

    banner(url)
    threading.Thread(target=watchdog, daemon=True).start()
    threading.Thread(target=server.serve_forever, daemon=True).start()
    if "--no-browser" not in sys.argv:
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()

    try:
        _shutdown["event"].wait()          # lo despierta el watchdog
        event(SYM["ok"], _shutdown["reason"] + " Servidor cerrado. ¡Hasta luego!", "92")
    except KeyboardInterrupt:
        with _print_lock:
            print()
        event(SYM["ok"], "Cerrado con Ctrl+C. ¡Hasta luego!", "92")
    server.shutdown()


if __name__ == "__main__":
    main()
