# SBS Stereo Photo Viewer for Oculus Quest 3

[Русская версия / Russian version](README.md)

A small server on your PC plus a page in the headset browser. No Steam Link, Virtual Desktop or SteamVR: Quest 3 renders stereo itself via **WebXR**.

## How it works

1. `server.py` reads `config.json` with the list of directories and serves:
   - the web client (`web/`);
   - `/api/list` — recursive directory listing (nested subfolders are supported);
   - `/api/image` — the source image (downscaled to `max_texture_size` when Pillow is available);
   - `/api/thumb` — thumbnails (cached in `thumbs/`).
2. Quest Browser opens `https://<PC-IP>:8443` and requests an `immersive-vr` session.
3. One SBS file is loaded as **a single texture**. The left eye samples UV `0..0.5`, the right eye samples `0.5..1`. WebXR supplies a separate view matrix for each eye with the correct IPD, so you get a proper stereo pair instead of a stretched side-by-side image.

## Quick start

### 1. Add your directories

Open `config.json`:

```json
{
  "ip": null,
  "port": 8443,
  "thumb_width": 320,
  "max_texture_size": 4096,
  "language": "en",
  "statefile": "state.json",
  "qr": true,
  "qrfile": "cert/connect.png",
  "controls": {
    "panInvertX": true,
    "panInvertY": true,
    "shiftInvert": false,
    "panStep": 0.08,
    "shiftStep": 0.005,
    "panBase": 0.35,
    "panGain": 1.0
  },
  "delete_to_trash": true,
  "roots": [
    {
      "id": "sbs",
      "name": "My SBS photos",
      "path": "D:/Stereo",
      "sbs": "full",
      "eye_aspect": null,
      "distance": 2.0,
      "height": 1.2
    }
  ]
}
```

- `sbs`: `full` — each eye occupies half of the file width (e.g. 5760×2880 → 2880×2880 per eye); `half` — each eye is horizontally compressed (e.g. 1920×1080 → 1920×1080 per eye after stretching).
- `eye_aspect`: explicit aspect ratio of one eye; when `null`, it is derived from the image size.
- `distance` / `height`: distance to the plane and its height in meters (1.5–2.5 m is comfortable).
- You can add as many `roots` as you need, each with its own path and mode.
- `language` — default UI language (`ru`, `en`, or any other file in `web/i18n/`).
- `statefile` — where to keep saved settings (per-directory zoom, curvature, pan and stereo shift, chosen language and last selected source).
- `qr` — `true` (default): create a PNG with the connection URL at startup. `qrfile` — where to save it. The QR is also available at `https://<PC-IP>:8443/qr`. Generation needs the optional `segno` package (`pip install -r requirements.txt`); without it the server only prints the URL. Use `--no-qr` to disable it.
- `controls` — thumbstick pan and stereo shift settings (see below).
- `delete_to_trash` — `true` (default): deleted photos go to the trash. On **Windows** the system **Recycle Bin** is used via the built-in Shell API (no extra packages). On **Linux/macOS**, install `pip install send2trash` to enable trash; otherwise deletion is permanent. `false` — always delete immediately.

### 2. Generate a certificate

```bat
python tools\make_cert.py
```

The script detects the PC IP and creates `cert/cert.pem` + `cert/key.pem` with `IP:<address>` and `DNS:localhost` in the SAN.

If the IP changes (DHCP), regenerate it:

```bat
python tools\make_cert.py --ip 192.168.1.50 --force
```

You can also pin the IP in `config.json` — `make_cert.py` will read it from there.

### 3. Run

Simply:

```bat
start.bat
```

Or manually:

```bat
python server.py
```

Available flags: `--config path`, `--http` (no TLS, for `localhost` only — WebXR still works there because `localhost` is a secure context), `--no-qr` (skip QR generation at startup).

At startup the server prints the URL and the QR file path:

```text
Откройте на Quest 3: https://192.168.1.50:8443
QR-код: cert/connect.png  (или https://192.168.1.50:8443/qr)
```

The QR encodes the same address that is used for the certificate. If the IP changes, regenerate the certificate and restart the server — the QR is recreated automatically.

> Quest 3 has no general built-in QR scanner: its system QR support is limited to Wi‑Fi setup. To open the link from a QR, install any third-party QR scanner app on Quest (App Lab/SideQuest), or just type the URL manually. After the first visit you can bookmark it in Quest Browser.

### 4. On Quest 3

1. Open **Browser** and enter `https://<PC-IP>:8443` (or scan the generated QR with a third-party scanner).
2. At the certificate warning choose **Advanced → Proceed** (required: without accepting the certificate WebXR will not start).
3. Pick a photo and press **Enter VR**.

   On the 2D page, only the **file grid scrolls** — the top menu and the selected-image panel stay in place. The **"⏮ To start" / "To end ⏭"** buttons in the header jump to the first/last card of the current directory, highlight it and open it. The selected-image panel has a **View settings** block with **pan ↔/↕**, **stereo shift** and a **Reset view** button, plus a **Screen curvature** slider (0% — flat, as before; 100% — a pronounced curve). All values are saved per directory.

   **Marks and deletion.** Press **A** (in VR), the **A/M** key, the **"Toggle mark"** button in the panel, or the badge in the top-right corner of a thumbnail (in 2D; `+` to mark, `✓` to unmark) to toggle a mark. In VR photo mode a marked photo shows a yellow **✓** in the top-right corner and a yellow index in the hint under the photo. The **"Delete marked"** button in the header deletes marked photos after confirmation; in the VR gallery there is a **"Delete (N)"** plate — the first trigger press arms the confirmation, the second performs deletion (the confirmation expires after 5 seconds). Marks apply **only within the current directory**: moving to another folder or source clears them. Deletion goes to the trash by default (see `delete_to_trash`).

4. VR controls:

   **Photo mode**
   - **Right thumbstick left/right** — previous/next photo (with repeat delay when held);
   - **Thumbstick up/down** — zoom (0.6×–2.5×, current value is shown in the hint under the photo). The value is **saved separately for each source directory** and restored next time you enter VR;
   - **Trigger + thumbstick** — pan across the frame: the photo moves **in the same direction you push the stick** (up → up, right → right). The effect is visible at 1× and grows with zoom. Pan values are saved together with zoom and curvature;
   - **Grip/squeeze + thumbstick ↔** — stereo shift for the right eye (−10%…+10% of one eye's width), useful when the SBS views drift apart. **Grip + thumbstick ↑↓** still sets the bend from 0–100%. While grip is held, the stick does not browse photos;
   - **A button** — toggle a mark on the current photo. A marked photo shows a yellow **✓** in the top-right corner and a yellow index in the hint;
   - **Press the thumbstick** or the **B/Y** button — open the 3D gallery. Trigger and grip alone no longer browse photos in photo mode.

   **3D gallery**
   - 12 visible cards (4×3) with a **vertical scrollbar** on the right: cards slide continuously as the cursor moves, and the bar shows your position in the list;
   - **Right controller ray** works only here: pointing highlights a card and the trigger opens it. The ray is disabled in photo mode;
   - **Thumbstick left/right** — move the selection, **up/down** — move one row;
   - **Trigger** — open the selection: a folder is entered, the "Back" card goes up one level, a photo is displayed. If you press the trigger while the ray points at **empty space between the cards** (or at nothing), the item selected with the **thumbstick** is opened — its frame is highlighted brighter to show this;
   - **A button** — toggle a mark on the card under the ray (marked cards show a **✓** in the top-right corner);
   - **"Delete (N)" plate** — delete marked photos (press trigger twice: first to arm the confirmation, then to delete);
   - **"⏮ To start" / "To end ⏭" buttons** at the bottom of the gallery move the cursor to the first/last item of the directory (point and press trigger);
   - **"Exit VR" button** at the bottom of the gallery (point at it and press the trigger);
   - **Grip**, **thumbstick press** or **B/Y** — return to the photo.

   On a PC you can test with the arrow keys (left/right — photos, up/down — zoom or gallery rows), `Shift` + arrows (pan), `Shift` + `[` / `]` (stereo shift), `[` / `]` (screen curvature), `Home` / `End` (first/last gallery item), `Enter` (open), `G` (switch mode), `A` / `M` (toggle mark), `Delete` (delete marked) and `Escape` (exit VR).

   The hint panel under the photo and the gallery header show the current controls right in VR.

#### Control settings (`controls`)

All trigger + thumbstick pan parameters live in `config.json` — no code edits needed:

| Option | Default | Meaning |
|---|---|---|
| `panInvertX` | `true` | Stick right → photo right. `false` restores the old behavior (photo left). |
| `panInvertY` | `true` | Stick up → photo up. `false` restores the old behavior (photo down). |
| `shiftInvert` | `false` | Invert the stereo shift direction (grip + stick ↔). |
| `panStep` | `0.08` | Pan step per stick repeat (0.08 = 8% of the half-frame width). |
| `shiftStep` | `0.005` | Stereo shift step (0.5% of one eye's width). |
| `panBase` | `0.35` | Pan factor at 1× so the slider works without zoom. |
| `panGain` | `1.0` | Extra factor added as zoom increases. |

The inversion also applies to the PC `Shift` + arrow shortcuts, so keyboard and VR pan in the same direction. Values are range-checked on the server; invalid ones fall back to the defaults.

### 5. Interface language

Pick a language from the **Language** dropdown on the 2D page — it applies immediately both to the 2D interface and to the in-VR hints. The choice is saved.

You can also set a default in `config.json` (`"language": "en"`). A language stored in the saved state takes priority over the config.

Translations live in **separate JSON files** `web/i18n/<code>.json` — the optimal choice here: the server discovers every file automatically and exposes the list via `/api/i18n/list`, so adding a language takes **one new file, no code changes**.

Each file is a flat key → string map. `__name` is the language name shown in the list; the other keys match `data-i18n` attributes in `web/index.html` and the strings drawn in VR. Strings support placeholders like `{name}`, `{zoom}`, `{index}`:

```json
{
  "__name": "Deutsch",
  "title": "VR Stereo-Galerie · Quest 3",
  "vrLabelHint": "Stick ← → blättern · ↑ ↓ Zoom {zoom}× · Stick/B — Galerie"
}
```

Just translate the keys from `web/i18n/en.json` — the new language appears in the list after reloading the page (no server restart needed).

**Russian convention.** In all Russian texts in this project — docs, `web/i18n/ru.json`, UI strings and comments — write `е` instead of `ё`: `все`, `желтый`, `раздает`, `сохраненное`.

Saved settings (per-directory zoom, curvature and a `view` block with pan/stereo shift, language and last selected source) live in `state.json`, which is gitignored. The source is restored on the next page load; if it is no longer present in `config.json`, the first one is used.

## Roadmap

Not implemented yet.

### Near term

- [ ] **Hand tracking.** Controller-free input via WebXR `hand-tracking`: a pinch gesture instead of the trigger, hand movement for pan, spreading fingers for zoom. Everything is currently bound to the thumbstick and buttons — gesture equivalents are needed for browsing photos, opening a card, marking and deleting, plus hints that switch depending on the active input method.
- [ ] **MR (mixed reality).** An `immersive-ar` session with Quest 3 color passthrough: place the photo panel and the 3D gallery in the real room and adjust the panel position and size with your hands. This needs a separate WebXR session mode, spatial anchoring and UI adaptation (the current bar is designed for VR).

### Mid term

- [ ] **Multiple headsets.** Two or more Quest units connected to one server at the same time. The base mode is **free viewing**: each session has its own selected photo, zoom/curvature/pan and marks. State is currently stored per directory, so sessions overwrite each other — a sync channel (WebSocket/SSE) and per-session state are needed.

  On top of that, a **lead headset mode** ("watch together"):

  - the lead browses photos, picks a folder and changes view settings (zoom, curvature, pan, stereo shift) — all of it is broadcast to the others;
  - frame controls on followers are locked while this mode is active to prevent desync;
  - the lead is the first headset to connect or is picked manually; there is a dedicated button/gesture to hand over the role, and it passes to the next headset if the lead disconnects;
  - marks and deletion stay **local** to each headset by default so one person cannot delete photos for everyone; shared marks are an option.
- [ ] **Phone remote.** A companion page on the same LAN: photo list, selection, browsing, pan and slideshow control from a phone. Connect via a QR link to the headset session and share one command channel with the VR client.
- [ ] **Slideshow.** Auto-advance with a configurable interval, cross-fade between photos, play/pause and shuffle. Controlled from VR and from the phone remote; interval and order are saved with the other per-directory settings.

## Dependencies

The server runs on plain Python 3.10+: no external packages required.

`Pillow` is optional (`pip install -r requirements.txt`): without it, thumbnails and downscaling are disabled and the browser downloads full files, which is noticeably slower for a large collection.

`segno` is also optional: it is only needed to generate the QR image at startup. Without it the server works as before and just prints the URL.

## Structure

```
config.json        — directories and display settings
server.py          — HTTP(S) server and JSON API
tools/make_cert.py — self-signed certificate with IP SAN
web/index.html     — 2D file browser and Enter VR button
web/app.js         — SBS loading, WebGL rendering, WebXR session, input
web/style.css
web/i18n/*.json    — translation files (one file per language)
state.json         — saved zoom/curve/view per directory, language and source (do not commit)
cert/              — certificates and connect.png with the QR (do not commit)
thumbs/            — thumbnail cache (do not commit)
LICENSE            — MIT license
```

## Troubleshooting

- **"Enter VR" says WebXR is unavailable** — the page was opened over `http://<IP>` instead of HTTPS. You need `https://` with an accepted certificate.
- **No files shown** — check `path` in `config.json` (on Windows use forward slashes, e.g. `D:/Stereo`) and the extensions: `.jpg .jpeg .png .webp` are supported.
- **The image looks stretched** — wrong `sbs` mode: switch `full` ↔ `half` or set `eye_aspect` to a number.
- **The texture does not load on Quest 3** — reduce `max_texture_size` to 2048.
- **Network is slow** — connect the PC with a cable, use 5 GHz for the headset, and enable Pillow for thumbnails.

## Security

The server only serves files from the directories listed in `roots`. Paths containing `..` and symlinks that escape a root are rejected. Only bind to `0.0.0.0` on a trusted home network.

## License

[MIT](LICENSE) — free to use, modify and distribute, including in commercial projects. The only condition is to keep the copyright notice and the license text.
