"""Локальный HTTP(S)-сервер для стерео-галереи Quest 3.

Без внешних зависимостей. Pillow опционален (миниатюры и даунскейл 4K).
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import io
import json
import mimetypes
import re
import socket
import ssl
import sys
import threading
import time
from collections import deque
from datetime import datetime
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
except ImportError:  # опционально: Windows использует ctypes, Linux/macOS — жесткое удаление
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
STATE: dict = {
    "zoom": {}, "curve": {}, "view": {}, "layout": {}, "layoutDefault": {},
    "panoMode": {}, "lang": None, "root": None, "primaryHand": "right",
}
STATE_LOCK = threading.Lock()
STATE_PATH: Path = BASE_DIR / "state.json"
QR_PNG: bytes | None = None

# Необязательное файловое логирование: включается флагом --log. Имя файла
# фиксируется в момент запуска сервера, чтобы логи разных запусков не смешивались.
STARTED_AT = datetime.now()
LOG_PATH: Path | None = None
LOG_LINES: deque[str] = deque(maxlen=500)
LOG_LOCK = threading.Lock()


def log(level: str, message: str, *args, console: bool = True) -> str:
    """Пишет строку в лог (и в консоль для ошибок), возвращает готовую строку."""
    text = message % args if args else str(message)
    line = f"[{datetime.now():%Y-%m-%d %H:%M:%S}] [{level}] {text}"
    if LOG_PATH:
        with LOG_LOCK:
            LOG_LINES.append(line)
            try:
                with LOG_PATH.open("a", encoding="utf-8") as fh:
                    fh.write(line + "\n")
            except OSError:
                pass
    if console:
        stream = sys.stderr if level in {"ERROR", "WARN"} else sys.stdout
        print(line, file=stream)
    return line


def setup_logging(enabled: bool) -> None:
    global LOG_PATH
    if not enabled:
        return
    log_dir = BASE_DIR / "logs"
    log_dir.mkdir(exist_ok=True)
    LOG_PATH = log_dir / f"server_{STARTED_AT:%Y%m%d_%H%M%S}.log"
    log("INFO", "log file: %s", LOG_PATH.name)

LAYOUT_TYPES = {"mono", "sbs", "half", "ou", "hou", "pano", "auto"}
LAYOUT_ALIASES = {
    "2d": "mono", "flat": "mono",
    "360": "pano", "panorama": "pano", "equirect": "pano", "equirectangular": "pano", "sphere": "pano",
    "full": "sbs", "lr": "sbs", "rl": "sbs", "stereo": "sbs", "3d": "sbs",
    "side-by-side": "sbs", "sidebyside": "sbs", "full-sbs": "sbs", "fullsbs": "sbs",
    "hsbs": "half", "half-sbs": "half", "sbs-half": "half", "halfsbs": "half", "sbshalf": "half", "half-side": "half",
    "tab": "ou", "tb": "ou", "bt": "ou", "ou": "ou",
    "top-bottom": "ou", "topbottom": "ou", "over-under": "ou", "overunder": "ou",
    "full-ou": "ou", "fullou": "ou", "fou": "ou", "full-tab": "ou", "fulltab": "ou",
    "hou": "hou", "half-ou": "hou", "halfou": "hou", "half-tab": "hou", "halftab": "hou",
}

# Предпочтительный способ удаления в корзину в текущем окружении.
TRASH_MODE = "send2trash" if _send2trash else ("windows" if sys.platform == "win32" else "none")


# ---------------------------------------------------------------------------
# Конфиг и утилиты
# ---------------------------------------------------------------------------

def as_bool(value, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes", "on"}
    return default


def as_num(value, default: float, low: float, high: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return default
    return max(low, min(high, number))


def normalise_layout(value) -> str | None:
    """Приводит имя формата к каноническому виду. Возвращает None для мусора."""
    key = str(value or "").strip().lower()
    key = re.sub(r"[\s_]+", "-", key)
    if key in LAYOUT_TYPES:
        return key
    return LAYOUT_ALIASES.get(key)


PANO_MODES = {"sphere", "cylinder"}


def normalise_pano_mode(value) -> str | None:
    key = str(value or "").strip().lower().replace("_", "-")
    if key in PANO_MODES:
        return key
    if key in {"spherical", "360"}:
        return "sphere"
    if key in {"cyl", "cylindrical", "wrap"}:
        return "cylinder"
    return None


def valid_rel(value) -> bool:
    """Проверка относительного пути картинки для карты ручных переопределений."""
    if not isinstance(value, str) or not value or len(value) > 512:
        return False
    if value.startswith("/") or "\\" in value or "\x00" in value:
        return False
    return all(part not in ("", ".", "..") for part in value.split("/"))


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
    cfg.setdefault("controls", {})
    controls = cfg["controls"]
    if not isinstance(controls, dict):
        controls = {}
        cfg["controls"] = controls
    controls["panInvertX"] = as_bool(controls.get("panInvertX"), True)
    controls["panInvertY"] = as_bool(controls.get("panInvertY"), True)
    controls["shiftInvert"] = as_bool(controls.get("shiftInvert"), False)
    controls["panStep"] = as_num(controls.get("panStep"), 0.08, 0.01, 0.5)
    controls["shiftStep"] = as_num(controls.get("shiftStep"), 0.005, 0.0005, 0.05)
    controls["panBase"] = as_num(controls.get("panBase"), 0.35, 0.0, 2.0)
    controls["panGain"] = as_num(controls.get("panGain"), 1.0, 0.0, 4.0)
    for root in cfg["roots"]:
        root["sbs"] = normalise_layout(root.get("sbs")) or "sbs"
        root["pano_mode"] = normalise_pano_mode(root.get("pano_mode")) or "sphere"
        # Какая доля вертикального угла обзора занята стеной. 1.0 — до краев глаза.
        root["pano_cyl_vfill"] = as_num(root.get("pano_cyl_vfill"), 1.0, 0.5, 1.0)
        # Из эквайреугольного источника берем центральную полосу: полюса в
        # верхней/нижней строке иначе выглядят как сфера. 1.0 — весь кадр.
        root["pano_cyl_vcrop"] = as_num(root.get("pano_cyl_vcrop"), 0.5, 0.2, 1.0)
        root["swap"] = as_bool(root.get("swap"), False)
        aspect = root.get("eye_aspect")
        try:
            root["eye_aspect"] = round(max(0.1, min(10.0, float(aspect))), 4) if aspect else None
        except (TypeError, ValueError):
            root["eye_aspect"] = None
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
        log("WARN", "Не удалось создать QR: %s", exc)
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
        raise ValueError("Путь выходит за пределы разрешенного каталога") from exc
    if not target.exists():
        raise FileNotFoundError(f"Не найдено: {target}")
    return target


# Только стандартные метаданные Google Photo Sphere (XMP GPano). Узлы ComfyUI
# не показатель: один и тот же результат можно получить разными нодами, поэтому
# их игнорируем — файл определится по контенту. Aspect 2:1 сам по себе тоже не
# годится: full-SBS часто имеет те же размеры.
PANO_MARKERS = re.compile(
    r"ns\.google\.com/photos/1\.0/panorama|GPano|UsePanoramaViewer|"
    r"PhotoSphere|ProjectionType.{0,40}equirectangular|Equirectangular",
    re.IGNORECASE,
)
PANO_NAME = re.compile(
    r"(?:^|[^a-z0-9])(pano|panorama|equirect|equirectangular|360)(?:[^a-z0-9]|$)",
    re.IGNORECASE,
)
# Если Pillow недоступен, сканируем только края файла. XMP обычно лежит в начале
# JPEG или в конце PNG; 64 КБ достаточно, а чтение 256 КБ у каждой картинки
# заметно тормозит первое открытие большого каталога.
PANO_SCAN_BYTES = 65536

# Размеры и признак панорамы кэшируются вместе: одно открытие файла вместо двух,
# и каталог из 300 фото открывается быстро даже после перезапуска сервера.
IMAGE_META_CACHE: dict[str, dict] = {}
IMAGE_META_CACHE_FILE = THUMB_DIR / "image_meta_cache.json"
IMAGE_META_LOCK = threading.Lock()
IMAGE_META_DIRTY = False
IMAGE_META_STATS = {}


def reset_image_meta_stats() -> None:
    global IMAGE_META_STATS
    IMAGE_META_STATS = {
        "files": 0, "hits": 0, "total": 0.0, "stat": 0.0, "lookup": 0.0,
        "open": 0.0, "info": 0.0, "regex": 0.0,
        "scan": 0.0, "store": 0.0, "slow": [],
    }


def load_image_meta_cache() -> None:
    global IMAGE_META_CACHE
    try:
        data = json.loads(IMAGE_META_CACHE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        IMAGE_META_CACHE = {}
        return
    if not isinstance(data, dict):
        IMAGE_META_CACHE = {}
        return
    cache = {}
    for key, value in data.items():
        if not isinstance(value, dict):
            continue
        width, height = value.get("w"), value.get("h")
        cache[str(key)] = {
            "w": width if isinstance(width, int) and width > 0 else None,
            "h": height if isinstance(height, int) and height > 0 else None,
            "pano": bool(value.get("pano")),
        }
    IMAGE_META_CACHE = cache


def save_image_meta_cache() -> None:
    global IMAGE_META_DIRTY
    if not IMAGE_META_DIRTY:
        return
    with IMAGE_META_LOCK:
        try:
            THUMB_DIR.mkdir(exist_ok=True)
            tmp = IMAGE_META_CACHE_FILE.with_suffix(".json.tmp")
            tmp.write_text(json.dumps(IMAGE_META_CACHE, ensure_ascii=False), encoding="utf-8")
            tmp.replace(IMAGE_META_CACHE_FILE)
            IMAGE_META_DIRTY = False
        except OSError:
            pass


def image_meta(path: Path) -> tuple[tuple[int, int] | None, bool]:
    """Возвращает (размеры, панорама). Кэш по пути, mtime и размеру файла."""
    global IMAGE_META_DIRTY
    started = time.perf_counter()
    stats = IMAGE_META_STATS
    try:
        stat = path.stat()
    except OSError:
        if stats:
            stats["stat"] += (time.perf_counter() - started) * 1000
        return None, False
    stat_ms = (time.perf_counter() - started) * 1000
    key = f"{path}|{stat.st_mtime_ns}|{stat.st_size}"
    lookup_started = time.perf_counter()
    with IMAGE_META_LOCK:
        cached = IMAGE_META_CACHE.get(key)
    lookup_ms = (time.perf_counter() - lookup_started) * 1000
    if cached is not None:
        width, height = cached.get("w"), cached.get("h")
        if stats:
            stats["hits"] += 1
            stats["stat"] += stat_ms
            stats["lookup"] += lookup_ms
            stats["total"] += (time.perf_counter() - started) * 1000
        dims = (width, height) if width and height else None
        return dims, bool(cached.get("pano"))

    name_started = time.perf_counter()
    dims = None
    pano = bool(PANO_NAME.search(path.stem))
    name_elapsed = time.perf_counter() - name_started
    open_ms = info_ms = regex_ms = scan_ms = 0.0
    if Image is not None:
        # Pillow читает только заголовок и метаданные: это на порядок быстрее,
        # чем сканировать десятки КБ в каждом файле большого каталога.
        try:
            with Image.open(path) as im:
                open_ms = (time.perf_counter() - name_started - name_elapsed) * 1000
                dims = im.size
                if not pano:
                    # Достаточно im.info: XMP и EXIF-заголовки Pillow уже кладет
                    # туда (в виде bytes), а getexif() на больших архивах стоит
                    # десятки секунд и список каталога тормозит без нужды.
                    info_started = time.perf_counter()
                    meta = str(im.info)
                    info_ms = (time.perf_counter() - info_started) * 1000
                    regex_started = time.perf_counter()
                    pano = bool(PANO_MARKERS.search(meta))
                    regex_ms = (time.perf_counter() - regex_started) * 1000
        except Exception:
            dims = None
    else:
        scan_started = time.perf_counter()
        try:
            with path.open("rb") as fh:
                head = fh.read(PANO_SCAN_BYTES)
                pano = bool(PANO_MARKERS.search(head.decode("latin-1", "ignore")))
                # XMP в PNG может лежать после IDAT — проверяем и хвост файла.
                if not pano and stat.st_size > PANO_SCAN_BYTES:
                    fh.seek(-PANO_SCAN_BYTES, 2)
                    tail = fh.read(PANO_SCAN_BYTES)
                    pano = bool(PANO_MARKERS.search(tail.decode("latin-1", "ignore")))
        except OSError:
            pass
        scan_ms = (time.perf_counter() - scan_started) * 1000

    width, height = dims if dims else (None, None)
    store_started = time.perf_counter()
    with IMAGE_META_LOCK:
        IMAGE_META_CACHE[key] = {"w": width, "h": height, "pano": pano}
        IMAGE_META_DIRTY = True
    store_ms = (time.perf_counter() - store_started) * 1000

    if stats:
        total_ms = (time.perf_counter() - started) * 1000
        stats["files"] += 1
        stats["total"] += total_ms
        stats["stat"] += stat_ms
        stats["lookup"] += lookup_ms
        stats["open"] += open_ms
        stats["info"] += info_ms
        stats["regex"] += regex_ms
        stats["scan"] += scan_ms
        stats["store"] += store_ms
        if total_ms > 200:
            stats["slow"].append((path.name, round(total_ms), round(open_ms)))
            stats["slow"] = sorted(stats["slow"], key=lambda x: -x[1])[:8]
    return dims, pano


def list_dir(root: dict, rel: str) -> dict:
    target = resolve(root, rel)
    if not target.is_dir():
        raise ValueError("Это не каталог")
    base = root_base(root)
    reset_image_meta_stats()
    iter_started = time.perf_counter()
    paths = list(target.iterdir())
    iter_ms = (time.perf_counter() - iter_started) * 1000
    entries = []
    for p in paths:
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
            dims, pano = image_meta(p)
            if dims:
                item["width"], item["height"] = dims
            if pano:
                item["pano"] = True
            entries.append(item)
    entries.sort(key=lambda e: (e["type"] != "dir", e["name"].lower()))
    save_started = time.perf_counter()
    save_image_meta_cache()
    save_ms = (time.perf_counter() - save_started) * 1000
    s = IMAGE_META_STATS
    log("INFO", "list breakdown: iterdir=%.1f ms, image_meta=%.1f ms "
        "(stat=%.1f, lookup=%.1f, open=%.1f, info=%.1f, regex=%.1f, "
        "scan=%.1f, store=%.1f, hits=%d/%d), save_cache=%.1f ms, slow=%s",
        iter_ms, s["total"], s["stat"], s["lookup"], s["open"], s["info"],
        s["regex"], s["scan"], s["store"], s["hits"], s["files"],
        save_ms, s["slow"] or "-")
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
    """Возвращает (bytes, mime). Без Pillow отдает оригинал."""
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
        "controls": CONFIG["controls"],
        "language": CONFIG["language"],
        "log": LOG_PATH is not None,
        "maxTextureSize": CONFIG["max_texture_size"],
        "trash": bool(CONFIG.get("delete_to_trash", True) and TRASH_MODE != "none"),
        "roots": [
            {
                "id": r["id"],
                "name": r["name"],
                "sbs": r["sbs"],   # mono | sbs | half | ou | hou | pano | auto
                "pano_mode": r.get("pano_mode", "sphere"),  # sphere | cylinder
                "panoCylVfill": r.get("pano_cyl_vfill", 1.0),  # доля высоты кадра
                "panoCylVcrop": r.get("pano_cyl_vcrop", 0.5),  # доля высоты источника
                "swap": r["swap"],
                "eyeAspect": r.get("eye_aspect"),
                "distance": r.get("distance", 2.0),
                "height": r.get("height", 1.2),
            }
            for r in CONFIG["roots"]
        ],
    }


# ---------------------------------------------------------------------------
# Состояние (зум/изгиб/вид/форматы по каталогам, выбранный язык)
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

                def clean_layouts(raw):
                    result = {}
                    if not isinstance(raw, dict):
                        return result
                    for root_id, items in raw.items():
                        if root_id not in root_ids or not isinstance(items, dict):
                            continue
                        clean = {}
                        for rel, value in items.items():
                            if not valid_rel(rel):
                                continue
                            if isinstance(value, str):
                                value = {"type": value}
                            if not isinstance(value, dict):
                                continue
                            layout_type = normalise_layout(value.get("type"))
                            if not layout_type:
                                continue
                            item = {"type": layout_type}
                            if "swap" in value:
                                item["swap"] = as_bool(value["swap"], False)
                            clean[rel] = item
                        if clean:
                            result[root_id] = clean
                    return result

                def clean_layout_defaults(raw):
                    result = {}
                    if isinstance(raw, dict):
                        for root_id, value in raw.items():
                            if root_id not in root_ids:
                                continue
                            layout_type = normalise_layout(value)
                            if layout_type:
                                result[root_id] = layout_type
                    return result

                def clean_pano_modes(raw):
                    result = {}
                    if isinstance(raw, dict):
                        for root_id, value in raw.items():
                            if root_id not in root_ids:
                                continue
                            mode = normalise_pano_mode(value)
                            if mode:
                                result[root_id] = mode
                    return result

                def clean_primary_hand(raw):
                    return "left" if raw == "left" else "right"

                STATE = {
                    "zoom": clean_values(data.get("zoom"), 0.6, 2.5, 3),
                    "curve": clean_values(data.get("curve"), 0.0, 1.0, 2),
                    "view": clean_views(data.get("view")),
                    "layout": clean_layouts(data.get("layout")),
                    "layoutDefault": clean_layout_defaults(data.get("layoutDefault")),
                    "panoMode": clean_pano_modes(data.get("panoMode")),
                    "lang": data.get("lang") if isinstance(data.get("lang"), str) else None,
                    "root": saved_root if isinstance(saved_root, str) and saved_root in root_ids else None,
                    "primaryHand": clean_primary_hand(data.get("primaryHand")),
                }
            return
        except (OSError, ValueError):
            pass
    STATE = {
        "zoom": {}, "curve": {}, "view": {}, "layout": {}, "layoutDefault": {},
        "panoMode": {}, "lang": None, "root": None, "primaryHand": "right",
    }


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
            if path == "/api/log":
                try:
                    tail = int(query.get("tail", ["200"])[0])
                except (TypeError, ValueError):
                    tail = 200
                tail = max(1, min(500, tail))
                with LOG_LOCK:
                    lines = list(LOG_LINES)[-tail:]
                return self._json({
                    "enabled": LOG_PATH is not None,
                    "file": LOG_PATH.name if LOG_PATH else None,
                    "lines": lines,
                })
            if path == "/api/list":
                started = time.perf_counter()
                root = get_root(query.get("root", [""])[0])
                rel = query.get("path", [""])[0]
                data = list_dir(root, rel)
                listed = time.perf_counter()
                self._json(data)
                log("INFO", "api/list: %d entries, scan=%.1f ms, total=%.1f ms, path=%s",
                    len(data["entries"]), (listed - started) * 1000,
                    (time.perf_counter() - started) * 1000, rel or "/")
                return
            if path == "/api/thumb":
                root = get_root(query.get("root", [""])[0])
                target = resolve(root, query.get("path", [""])[0])
                width = int(query.get("w", [CONFIG["thumb_width"]])[0])
                started = time.perf_counter()
                data, mime = thumbnail(target, width)
                elapsed = (time.perf_counter() - started) * 1000
                if elapsed > 100:
                    log("INFO", "api/thumb slow: %s %.1f ms", target.name, elapsed)
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
        except Exception as exc:  # noqa: BLE001 - отдаем ошибку в браузер
            return self._error(500, f"{type(exc).__name__}: {exc}")

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path not in ("/api/state", "/api/delete", "/api/log"):
            return self._error(404, "Не найдено")
        try:
            length = min(int(self.headers.get("Content-Length", "0")), 16384)
            payload = json.loads(self.rfile.read(max(0, length)).decode("utf-8") or "{}")
            if not isinstance(payload, dict):
                raise ValueError("Ожидается JSON-объект")
            if parsed.path == "/api/log":
                if payload.get("clear"):
                    with LOG_LOCK:
                        LOG_LINES.clear()
                        if LOG_PATH:
                            try:
                                LOG_PATH.write_text("", encoding="utf-8")
                            except OSError:
                                pass
                    return self._json({"ok": True, "enabled": LOG_PATH is not None, "cleared": True})
                level = str(payload.get("level", "INFO")).upper()[:12]
                if level not in {"DEBUG", "INFO", "WARN", "ERROR"}:
                    level = "INFO"
                message = str(payload.get("message", ""))[:2000]
                stack = str(payload.get("stack", ""))[:4000]
                source = str(payload.get("source", "web"))[:32]
                if message:
                    log("JS-" + level, f"{source}: {message}" + (f"\n{stack}" if stack else ""))
                return self._json({"ok": True, "enabled": LOG_PATH is not None})
            if parsed.path == "/api/delete":
                root_id = str(payload.get("root", ""))
                result = delete_files(
                    root_id,
                    str(payload.get("rel", "")),
                    payload.get("paths", []),
                )
                with STATE_LOCK:
                    layouts = STATE.get("layout", {}).get(root_id, {})
                    for rel in payload.get("paths", []):
                        if isinstance(rel, str):
                            layouts.pop(rel, None)
                    save_state()
                return self._json(result)
            with STATE_LOCK:
                changed = False
                if "zoom" in payload:
                    root_id = str(payload.get("root", ""))
                    get_root(root_id)  # проверяем, что каталог разрешен
                    zoom = float(payload["zoom"])
                    zoom = min(2.5, max(0.6, zoom))
                    STATE.setdefault("zoom", {})[root_id] = round(zoom, 3)
                    changed = True
                if "curve" in payload:
                    root_id = str(payload.get("root", ""))
                    get_root(root_id)  # проверяем, что каталог разрешен
                    curve = float(payload["curve"])
                    curve = min(1.0, max(0.0, curve))
                    STATE.setdefault("curve", {})[root_id] = round(curve, 2)
                    changed = True
                if "view" in payload:
                    root_id = str(payload.get("root", ""))
                    get_root(root_id)  # проверяем, что каталог разрешен
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
                if "layoutDefault" in payload:
                    root_id = str(payload.get("root", ""))
                    get_root(root_id)  # проверяем, что каталог разрешен
                    raw_default = payload["layoutDefault"]
                    defaults = STATE.setdefault("layoutDefault", {})
                    if raw_default is None or raw_default == "auto":
                        if defaults.pop(root_id, None) is not None:
                            changed = True
                    else:
                        layout_type = normalise_layout(raw_default)
                        if not layout_type:
                            raise ValueError("Неизвестный тип стереоформата")
                        if defaults.get(root_id) != layout_type:
                            defaults[root_id] = layout_type
                            changed = True
                if "panoMode" in payload:
                    root_id = str(payload.get("root", ""))
                    get_root(root_id)  # проверяем, что каталог разрешен
                    raw_mode = payload["panoMode"]
                    modes = STATE.setdefault("panoMode", {})
                    if raw_mode is None or raw_mode == "auto":
                        if modes.pop(root_id, None) is not None:
                            changed = True
                    else:
                        mode = normalise_pano_mode(raw_mode)
                        if not mode:
                            raise ValueError("Неизвестный тип 360-проекции")
                        if modes.get(root_id) != mode:
                            modes[root_id] = mode
                            changed = True
                if "layout" in payload:
                    root_id = str(payload.get("root", ""))
                    get_root(root_id)  # проверяем, что каталог разрешен
                    rel = str(payload.get("path", ""))
                    if not valid_rel(rel):
                        raise ValueError("Некорректный путь картинки")
                    raw_layout = payload["layout"]
                    layouts = STATE.setdefault("layout", {}).setdefault(root_id, {})
                    if raw_layout is None:
                        if layouts.pop(rel, None) is not None:
                            changed = True
                        if not layouts:
                            STATE["layout"].pop(root_id, None)
                    else:
                        if not isinstance(raw_layout, dict):
                            raise ValueError("Ожидается объект настроек формата")
                        layout_type = normalise_layout(raw_layout.get("type"))
                        if not layout_type:
                            raise ValueError("Неизвестный тип стереоформата")
                        item = {"type": layout_type}
                        if "swap" in raw_layout:
                            item["swap"] = as_bool(raw_layout["swap"], False)
                        if layouts.get(rel) != item:
                            layouts[rel] = item
                            changed = True
                if "primaryHand" in payload:
                    hand = "left" if payload["primaryHand"] == "left" else "right"
                    if STATE.get("primaryHand") != hand:
                        STATE["primaryHand"] = hand
                        changed = True
                if "lang" in payload:
                    lang = str(payload["lang"])
                    if not valid_language(lang):
                        raise ValueError("Неизвестный язык")
                    STATE["lang"] = lang
                    changed = True
                if "root" in payload:
                    root_id = str(payload["root"])
                    get_root(root_id)  # проверяем, что каталог разрешен
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
        # Раньше в файле оставался только код ответа из log_message; теперь
        # видно и причину, даже если клиент не успел отправить JS-ERROR.
        if code >= 500 or "/api/" in (self.path or ""):
            level = "ERROR" if code >= 500 else "WARN"
            log(level, "error %d for %s: %s", code, self.path, str(message)[:500])
        data = message.encode("utf-8", errors="replace")
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt, *args):
        if LOG_PATH:
            log("HTTP", f"{self.command} {self.path} :: {fmt % args}", console=False)
        elif "/api/" in (self.path or ""):
            super().log_message(fmt, *args)


def main():
    parser = argparse.ArgumentParser(description="VR стерео-галерея для Quest 3")
    parser.add_argument("--config", default=str(BASE_DIR / "config.json"))
    parser.add_argument("--http", action="store_true", help="без TLS (только localhost)")
    parser.add_argument("--no-qr", action="store_true", help="не создавать QR-код при запуске")
    parser.add_argument("--log", action="store_true",
                        help="писать логи в logs/server_<время запуска>.log (см. debug.bat)")
    args = parser.parse_args()

    setup_logging(args.log)

    global CONFIG
    CONFIG = load_config(Path(args.config))
    THUMB_DIR.mkdir(exist_ok=True)
    load_image_meta_cache()
    load_state()

    for root in CONFIG["roots"]:
        p = root_base(root)
        if not p.is_dir():
            log("WARN", "Каталог не найден: %s", p)

    httpd = ThreadingHTTPServer((CONFIG["host"], CONFIG["port"]), Handler)
    if not args.http:
        cert = BASE_DIR / CONFIG["certfile"]
        key = BASE_DIR / CONFIG["keyfile"]
        if not cert.is_file() or not key.is_file():
            log("ERROR", "Нет сертификата. Запустите: python tools/make_cert.py")
            sys.exit(1)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(str(cert), str(key))
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)

    url = connection_url(args.http)
    log("INFO", "Откройте на Quest 3: %s", url)
    if CONFIG.get("qr", True) and not args.no_qr:
        qr_path = BASE_DIR / CONFIG["qrfile"]
        if make_qr_png(url, qr_path):
            log("INFO", "QR-код: %s  (или %s/qr)", qr_path, url)
        else:
            log("WARN", "Для генерации QR установите: pip install segno")
    if args.http:
        log("WARN", "--http: для Quest 3 нужен HTTPS, иначе WebXR не запустится.")
    log("INFO", "Сервер запущен, Ctrl+C для остановки.")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("INFO", "Стоп.")
        httpd.server_close()


if __name__ == "__main__":
    main()
