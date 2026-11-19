"""Локальный HTTP(S)-сервер для стерео-галереи Quest 3.

Без внешних зависимостей. Pillow опционален (миниатюры и даунскейл 4K).
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import mimetypes
import re
import socket
import ssl
import sys
import threading
import ctypes
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

BASE_DIR = Path(__file__).resolve().parent
WEB_DIR = BASE_DIR / "web"
THUMB_DIR = BASE_DIR / "thumbs"
EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}

try:
    from PIL import Image

    RESAMPLE = getattr(Image, "Resampling", Image).LANCZOS
except ImportError:  # Pillow не обязателен
    Image = None
    RESAMPLE = None

try:
    from send2trash import send2trash as _send2trash
except ImportError:  # опционально: Windows использует ctypes, Linux/macOS — жёсткое удаление
    _send2trash = None

try:
    import segno  # опционально: QR-код со ссылкой для Quest 3
except ImportError:
    segno = None

if sys.platform == "win32":
    from ctypes import wintypes

    class _SHFILEOPSTRUCTW(ctypes.Structure):
        _fields_ = [
            ("hwnd", wintypes.HWND),
            ("wFunc", wintypes.UINT),
            ("pFrom", wintypes.LPCWSTR),
            ("pTo", wintypes.LPCWSTR),
            ("fFlags", ctypes.c_ushort),
            ("fAnyOperationsAborted", wintypes.BOOL),
            ("hNameMappings", ctypes.c_void_p),
            ("lpszProgressTitle", wintypes.LPCWSTR),
        ]

CONFIG: dict = {}
STATE: dict = {"zoom": {}, "curve": {}, "view": {}, "lang": None, "root": None}
STATE_LOCK = threading.Lock()
STATE_PATH: Path = BASE_DIR / "state.json"
QR_PNG: bytes | None = None

# Предпочтительный способ удаления в корзину в текущем окружении.
TRASH_MODE = "send2trash" if _send2trash else ("windows" if sys.platform == "win32" else "none")


# ---------------------------------------------------------------------------
# Конфиг и утилиты
# ---------------------------------------------------------------------------

def load_config(path: Path) -> dict:
    cfg = json.loads(path.read_text(encoding="utf-8"))
    cfg.setdefault("host", "0.0.0.0")
    cfg.setdefault("port", 8443)
    cfg.setdefault("certfile", "cert/cert.pem")
    cfg.setdefault("keyfile", "cert/key.pem")
    cfg.setdefault("ip", None)
    cfg.setdefault("thumb_width", 320)
    cfg.setdefault("max_texture_size", 4096)
    cfg.setdefault("language", "ru")
    cfg.setdefault("statefile", "state.json")
    cfg.setdefault("qr", True)
    cfg.setdefault("qrfile", "cert/connect.png")
    cfg.setdefault("delete_to_trash", True)
    cfg.setdefault("roots", [])
    return cfg


def local_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return socket.gethostname()


def connection_url(http: bool = False) -> str:
    """Адрес, который нужно открыть в Quest Browser."""
    scheme = "http" if http else "https"
    host = CONFIG.get("ip") or local_ip()
    return f"{scheme}://{host}:{CONFIG['port']}"


def make_qr_png(url: str, path: Path) -> bytes | None:
    """Сохраняет QR в PNG и возвращает его байты. Без segno — только URL в консоли."""
    global QR_PNG
    if segno is None:
        return None
    try:
        qr = segno.make(url, error="m", boost_error=False)
        buf = io.BytesIO()
        qr.save(buf, kind="png", scale=8, border=4, dark="#10131a", light="#ffffff")
        data = buf.getvalue()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        QR_PNG = data
        return data
    except Exception as exc:  # noqa: BLE001 - QR не должен мешать запуску сервера
        print(f"[ВНИМАНИЕ] Не удалось создать QR: {exc}", file=sys.stderr)
        return None


def get_root(root_id: str) -> dict:
    for root in CONFIG["roots"]:
        if root["id"] == root_id:
            return root
    raise ValueError(f"Неизвестный каталог: {root_id}")


def root_base(root: dict) -> Path:
    """Относительные пути в конфиге считаем от папки со скриптом."""
    p = Path(root["path"]).expanduser()
    if not p.is_absolute():
        p = BASE_DIR / p
    return p.resolve()


def resolve(root: dict, rel: str) -> Path:
    """Безопасное превращение (root id, relatives path) в абсолютный путь."""
    base = root_base(root)
    if not base.is_dir():
        raise FileNotFoundError(f"Каталог не найден: {base}")
    target = (base / unquote(rel)).resolve()
    try:
        target.relative_to(base)
    except ValueError as exc:
        raise ValueError("Путь выходит за пределы разрешённого каталога") from exc
    if not target.exists():
        raise FileNotFoundError(f"Не найдено: {target}")
    return target


def image_size(path: Path):
    if Image is None:
        return None
    try:
        with Image.open(path) as im:
            return im.size
    except Exception:
        return None


def list_dir(root: dict, rel: str) -> dict:
    target = resolve(root, rel)
    if not target.is_dir():
        raise ValueError("Это не каталог")
    base = root_base(root)
    entries = []
    for p in target.iterdir():
        if p.name.startswith("."):
            continue
        rel_path = p.relative_to(base).as_posix()
        if p.is_dir():
            entries.append({"type": "dir", "name": p.name, "path": rel_path})
        elif p.is_file() and p.suffix.lower() in EXTENSIONS:
            item = {
                "type": "image",
                "name": p.name,
                "path": rel_path,
                "size": p.stat().st_size,
            }
            dims = image_size(p)
            if dims:
                item["width"], item["height"] = dims
            entries.append(item)
    entries.sort(key=lambda e: (e["type"] != "dir", e["name"].lower()))
    return {"root": root["id"], "path": rel, "entries": entries}


def move_to_trash(paths: list[Path]) -> str:
    """Перемещает файлы в корзину. Возвращает использованный способ."""
    mode = TRASH_MODE if CONFIG.get("delete_to_trash", True) else "none"
    if mode == "none" or not paths:
        for path in paths:
            path.unlink()
        return "none"

    if mode == "send2trash":
        for path in paths:
            _send2trash(str(path))
        return "send2trash"

    # Windows: SHFileOperationW с FOF_ALLOWUNDO — стандартная Корзина.
    FO_DELETE = 3
    FOF_ALLOWUNDO = 0x0040
    FOF_NOCONFIRMATION = 0x0010
    FOF_SILENT = 0x0004
    FOF_NOERRORUI = 0x0400
    op = _SHFILEOPSTRUCTW()
    op.wFunc = FO_DELETE
    op.pFrom = "\0".join(str(p) for p in paths) + "\0\0"
    op.fFlags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_SILENT | FOF_NOERRORUI
    result = ctypes.windll.shell32.SHFileOperationW(ctypes.byref(op))
    if result != 0 or op.fAnyOperationsAborted:
        raise OSError(f"SHFileOperationW завершилось с кодом {result}")
    return "windows"


def delete_files(root_id: str, rel: str, paths: list) -> dict:
    """Удаляет только отмеченные изображения из текущего каталога."""
    root = get_root(root_id)
    folder = resolve(root, rel)
    if not folder.is_dir():
        raise ValueError("Это не каталог")
    if not isinstance(paths, list):
        raise ValueError("Ожидается список файлов")

    targets = []
    seen = set()
    for item in paths:
        if not isinstance(item, str):
            raise ValueError("Некорректный путь файла")
        if item in seen:
            continue
        seen.add(item)
        target = resolve(root, item)
        if target.parent != folder:
            raise ValueError("Можно удалять только файлы текущего каталога")
        if not target.is_file() or target.suffix.lower() not in EXTENSIONS:
            raise ValueError("Можно удалять только изображения")
        targets.append(target)

    mode = move_to_trash(targets)
    return {"deleted": [p.name for p in targets], "trash": mode != "none"}


def thumbnail(path: Path, width: int):
    """Возвращает (bytes, mime). Без Pillow отдаёт оригинал."""
    if Image is None:
        return path.read_bytes(), guess_mime(path)
    key = hashlib.sha256(f"{path}|{width}".encode("utf-8")).hexdigest()[:24] + ".jpg"
    out = THUMB_DIR / key
    if not out.exists():
        with Image.open(path) as im:
            im = im.convert("RGB")
            ratio = width / im.width
            im = im.resize((max(1, int(width)), max(1, int(im.height * ratio))), RESAMPLE)
            im.save(out, "JPEG", quality=82)
    return out.read_bytes(), "image/jpeg"


def image_bytes(path: Path, max_size: int):
    if not max_size or Image is None:
        return path.read_bytes(), guess_mime(path)
    with Image.open(path) as im:
        w, h = im.size
        if max(w, h) <= max_size:
            return path.read_bytes(), guess_mime(path)
        ratio = max_size / max(w, h)
        out = im.convert("RGB").resize(
            (max(1, int(w * ratio)), max(1, int(h * ratio))), RESAMPLE
        )
    buf = io.BytesIO()
    out.save(buf, "JPEG", quality=90)
    return buf.getvalue(), "image/jpeg"


def guess_mime(path: Path) -> str:
    return mimetypes.guess_type(str(path))[0] or "application/octet-stream"


def config_payload() -> dict:
    return {
        "ip": CONFIG.get("ip") or local_ip(),
        "port": CONFIG["port"],
        "secure": True,
        "qr": QR_PNG is not None,
        "language": CONFIG["language"],
        "maxTextureSize": CONFIG["max_texture_size"],
        "trash": bool(CONFIG.get("delete_to_trash", True) and TRASH_MODE != "none"),
        "roots": [
            {
                "id": r["id"],
                "name": r["name"],
                "sbs": r.get("sbs", "full"),   # full | half
                "eyeAspect": r.get("eye_aspect"),
                "distance": r.get("distance", 2.0),
                "height": r.get("height", 1.2),
            }
            for r in CONFIG["roots"]
        ],
    }


# ---------------------------------------------------------------------------
# Состояние (зум/изгиб/вид по каталогам, выбранный язык)
# ---------------------------------------------------------------------------

def load_state() -> None:
    global STATE_PATH, STATE
    p = Path(CONFIG["statefile"])
    STATE_PATH = p if p.is_absolute() else BASE_DIR / p
    if STATE_PATH.is_file():
        try:
            data = json.loads(STATE_PATH.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                saved_root = data.get("root")
                root_ids = {r["id"] for r in CONFIG["roots"]}

                def clean_values(raw, low, high, digits):
                    result = {}
                    if isinstance(raw, dict):
                        for key, value in raw.items():
                            if key not in root_ids:
                                continue
                            try:
                                number = float(value)
                            except (TypeError, ValueError):
                                continue
                            result[key] = round(min(high, max(low, number)), digits)
                    return result

                def clean_views(raw):
                    ranges = {
                        "panX": (-1.0, 1.0, 3),
                        "panY": (-1.0, 1.0, 3),
                        "shift": (-0.1, 0.1, 3),
                    }
                    result = {}
                    if not isinstance(raw, dict):
                        return result
                    for root_id, values in raw.items():
                        if root_id not in root_ids or not isinstance(values, dict):
                            continue
                        clean = {}
                        for key, (low, high, digits) in ranges.items():
                            if key not in values:
                                continue
                            try:
                                number = float(values[key])
                            except (TypeError, ValueError):
                                continue
                            clean[key] = round(min(high, max(low, number)), digits)
                        if clean:
                            result[root_id] = clean
                    return result

                STATE = {
                    "zoom": clean_values(data.get("zoom"), 0.6, 2.5, 3),
                    "curve": clean_values(data.get("curve"), 0.0, 1.0, 2),
                    "view": clean_views(data.get("view")),
                    "lang": data.get("lang") if isinstance(data.get("lang"), str) else None,
                    "root": saved_root if isinstance(saved_root, str) and saved_root in root_ids else None,
                }
            return
        except (OSError, ValueError):
            pass
    STATE = {"zoom": {}, "curve": {}, "view": {}, "lang": None, "root": None}


def save_state() -> None:
    tmp = STATE_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(STATE, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(STATE_PATH)


def available_languages() -> list:
    result = []
    i18n_dir = WEB_DIR / "i18n"
    for path in sorted(i18n_dir.glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and data.get("__name"):
            result.append({"code": path.stem, "name": data["__name"]})
    return result


def valid_language(code: str) -> bool:
    return bool(re.fullmatch(r"[a-zA-Z0-9_-]+", code)) and (WEB_DIR / "i18n" / f"{code}.json").is_file()


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "VRSlides/0.1"

    def do_GET(self):
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query, keep_blank_values=True)
        path = parsed.path
        try:
            if path == "/":
                return self._file(WEB_DIR / "index.html")
            if path in ("/app.js", "/style.css"):
                return self._file(WEB_DIR / path.lstrip("/"))
            if path.startswith("/i18n/"):
                name = path[len("/i18n/"):]
                if not re.fullmatch(r"[a-zA-Z0-9_-]+\.json", name):
                    raise ValueError("Некорректный файл локализации")
                return self._file(WEB_DIR / "i18n" / name)
            if path in ("/qr", "/qr.png"):
                if QR_PNG is None:
                    raise ValueError("QR-код не создан. Установите: pip install segno")
                return self._bytes(QR_PNG, "image/png", cache=0)
            if path == "/api/config":
                return self._json(config_payload())
            if path == "/api/state":
                with STATE_LOCK:
                    return self._json(STATE)
            if path == "/api/i18n/list":
                return self._json(available_languages())
            if path == "/api/list":
                root = get_root(query.get("root", [""])[0])
                return self._json(list_dir(root, query.get("path", [""])[0]))
            if path == "/api/thumb":
                root = get_root(query.get("root", [""])[0])
                target = resolve(root, query.get("path", [""])[0])
                width = int(query.get("w", [CONFIG["thumb_width"]])[0])
                data, mime = thumbnail(target, width)
                return self._bytes(data, mime, cache=86400)
            if path == "/api/image":
                root = get_root(query.get("root", [""])[0])
                target = resolve(root, query.get("path", [""])[0])
                max_size = int(query.get("max", [0])[0])
                data, mime = image_bytes(target, max_size)
                return self._bytes(data, mime, cache=3600)
            return self._error(404, "Не найдено")
        except (ValueError, FileNotFoundError, KeyError, IndexError) as exc:
            return self._error(400, str(exc))
        except Exception as exc:  # noqa: BLE001 - отдаём ошибку в браузер
            return self._error(500, f"{type(exc).__name__}: {exc}")

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path not in ("/api/state", "/api/delete"):
            return self._error(404, "Не найдено")
        try:
            length = int(self.headers.get("Content-Length", "0"))
            payload = json.loads(self.rfile.read(max(0, length)).decode("utf-8") or "{}")
            if not isinstance(payload, dict):
                raise ValueError("Ожидается JSON-объект")
            if parsed.path == "/api/delete":
                result = delete_files(
                    str(payload.get("root", "")),
                    str(payload.get("rel", "")),
                    payload.get("paths", []),
                )
                return self._json(result)
            with STATE_LOCK:
                changed = False
                if "zoom" in payload:
                    root_id = str(payload.get("root", ""))
                    get_root(root_id)  # проверяем, что каталог разрешён
                    zoom = float(payload["zoom"])
                    zoom = min(2.5, max(0.6, zoom))
                    STATE.setdefault("zoom", {})[root_id] = round(zoom, 3)
                    changed = True
                if "curve" in payload:
                    root_id = str(payload.get("root", ""))
                    get_root(root_id)  # проверяем, что каталог разрешён
                    curve = float(payload["curve"])
                    curve = min(1.0, max(0.0, curve))
                    STATE.setdefault("curve", {})[root_id] = round(curve, 2)
                    changed = True
                if "view" in payload:
                    root_id = str(payload.get("root", ""))
                    get_root(root_id)  # проверяем, что каталог разрешён
                    raw_view = payload["view"]
                    if not isinstance(raw_view, dict):
                        raise ValueError("Ожидается объект настроек вида")
                    view = STATE.setdefault("view", {}).setdefault(root_id, {})
                    for key, low, high, digits in (
                        ("panX", -1.0, 1.0, 3),
                        ("panY", -1.0, 1.0, 3),
                        ("shift", -0.1, 0.1, 3),
                    ):
                        if key not in raw_view:
                            continue
                        number = round(min(high, max(low, float(raw_view[key]))), digits)
                        if view.get(key) != number:
                            view[key] = number
                            changed = True
                if "lang" in payload:
                    lang = str(payload["lang"])
                    if not valid_language(lang):
                        raise ValueError("Неизвестный язык")
                    STATE["lang"] = lang
                    changed = True
                if "root" in payload:
                    root_id = str(payload["root"])
                    get_root(root_id)  # проверяем, что каталог разрешён
                    STATE["root"] = root_id
                    changed = True
                if changed:
                    save_state()
                return self._json(STATE)
        except (ValueError, KeyError, TypeError) as exc:
            return self._error(400, str(exc))
        except Exception as exc:  # noqa: BLE001
            return self._error(500, f"{type(exc).__name__}: {exc}")

    def _file(self, path: Path):
        if not path.is_file():
            return self._error(404, "Файл не найден")
        return self._bytes(path.read_bytes(), guess_mime(path), cache=0)

    def _json(self, obj):
        self._bytes(
            json.dumps(obj, ensure_ascii=False).encode("utf-8"),
            "application/json; charset=utf-8",
            cache=0,
        )

    def _bytes(self, data: bytes, mime: str, cache: int = 0):
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", f"public, max-age={cache}")
        self.end_headers()
        self.wfile.write(data)

    def _error(self, code: int, message: str):
        data = message.encode("utf-8", errors="replace")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        if "/api/" in (self.path or ""):
            super().log_message(fmt, *args)


def main():
    parser = argparse.ArgumentParser(description="VR стерео-галерея для Quest 3")
    parser.add_argument("--config", default=str(BASE_DIR / "config.json"))
    parser.add_argument("--http", action="store_true", help="без TLS (только localhost)")
    parser.add_argument("--no-qr", action="store_true", help="не создавать QR-код при запуске")
    args = parser.parse_args()

    global CONFIG
    CONFIG = load_config(Path(args.config))
    THUMB_DIR.mkdir(exist_ok=True)
    load_state()

    for root in CONFIG["roots"]:
        p = root_base(root)
        if not p.is_dir():
            print(f"[ВНИМАНИЕ] Каталог не найден: {p}", file=sys.stderr)

    httpd = ThreadingHTTPServer((CONFIG["host"], CONFIG["port"]), Handler)
    if not args.http:
        cert = BASE_DIR / CONFIG["certfile"]
        key = BASE_DIR / CONFIG["keyfile"]
        if not cert.is_file() or not key.is_file():
            print("Нет сертификата. Запустите: python tools/make_cert.py", file=sys.stderr)
            sys.exit(1)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(str(cert), str(key))
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

    url = connection_url(args.http)
    print(f"Откройте на Quest 3: {url}")
    if CONFIG.get("qr", True) and not args.no_qr:
        qr_path = BASE_DIR / CONFIG["qrfile"]
        if make_qr_png(url, qr_path):
            print(f"QR-код: {qr_path}  (или {url}/qr)")
        else:
            print("[QR] Для генерации установите: pip install segno", file=sys.stderr)
    if args.http:
        print("[ВНИМАНИЕ] --http: для Quest 3 нужен HTTPS, иначе WebXR не запустится.", file=sys.stderr)
    print("Ctrl+C для остановки.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nСтоп.")
        httpd.server_close()


if __name__ == "__main__":
    main()
