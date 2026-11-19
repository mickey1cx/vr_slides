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
- `statefile` — where to keep saved settings (per-directory zoom, chosen language and last selected source).

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

Available flags: `--config path`, `--http` (no TLS, for `localhost` only — WebXR still works there because `localhost` is a secure context).

### 4. On Quest 3

1. Open **Browser** and enter `https://<PC-IP>:8443`.
2. At the certificate warning choose **Advanced → Proceed** (required: without accepting the certificate WebXR will not start).
3. Pick a photo and press **Enter VR**.

   On the 2D page, only the **file grid scrolls** — the top menu and the selected-image panel stay in place. The **"⏮ To start" / "To end ⏭"** buttons in the header jump to the first/last card of the current directory, highlight it and open it.

4. VR controls:

   **Photo mode**
   - **Right thumbstick left/right** — previous/next photo (with repeat delay when held);
   - **Thumbstick up/down** — zoom (0.6×–2.5×, current value is shown in the hint under the photo). The value is **saved separately for each source directory** and restored next time you enter VR;
   - **Trigger** — next photo, **grip/squeeze** — previous photo;
   - **Press the thumbstick** or the **B/Y** button — open the 3D gallery.

   **3D gallery**
   - 12 visible cards (4×3) with a **vertical scrollbar** on the right: cards slide continuously as the cursor moves, and the bar shows your position in the list;
   - **Right controller ray** works only here: pointing highlights a card and the trigger opens it. The ray is disabled in photo mode;
   - **Thumbstick left/right** — move the selection, **up/down** — move one row;
   - **Trigger** — open the selection: a folder is entered, the "Back" card goes up one level, a photo is displayed. If you press the trigger while the ray points at **empty space between the cards** (or at nothing), the item selected with the **thumbstick** is opened — its frame is highlighted brighter to show this;
   - **"⏮ To start" / "To end ⏭" buttons** at the bottom of the gallery move the cursor to the first/last item of the directory (point and press trigger);
   - **"Exit VR" button** at the bottom of the gallery (point at it and press the trigger);
   - **Grip**, **thumbstick press** or **B/Y** — return to the photo.

   On a PC you can test with the arrow keys (left/right — photos, up/down — zoom or gallery rows), `Home` / `End` (first/last gallery item), `Enter` (open), `G` (switch mode) and `Escape` (exit VR).

   The hint panel under the photo and the gallery header show the current controls right in VR.

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

Saved settings (per-directory zoom, language and last selected source) live in `state.json`, which is gitignored. The source is restored on the next page load; if it is no longer present in `config.json`, the first one is used.

## Dependencies

The server runs on plain Python 3.10+: no external packages required.

`Pillow` is optional (`pip install -r requirements.txt`): without it, thumbnails and downscaling are disabled and the browser downloads full files, which is noticeably slower for a large collection.

## Structure

```
config.json        — directories and display settings
server.py          — HTTP(S) server and JSON API
tools/make_cert.py — self-signed certificate with IP SAN
web/index.html     — 2D file browser and Enter VR button
web/app.js         — SBS loading, WebGL rendering, WebXR session, input
web/style.css
web/i18n/*.json    — translation files (one file per language)
state.json         — saved per-directory zoom and language (do not commit)
cert/              — certificates (do not commit)
thumbs/            — thumbnail cache (do not commit)
```

## Troubleshooting

- **"Enter VR" says WebXR is unavailable** — the page was opened over `http://<IP>` instead of HTTPS. You need `https://` with an accepted certificate.
- **No files shown** — check `path` in `config.json` (on Windows use forward slashes, e.g. `D:/Stereo`) and the extensions: `.jpg .jpeg .png .webp` are supported.
- **The image looks stretched** — wrong `sbs` mode: switch `full` ↔ `half` or set `eye_aspect` to a number.
- **The texture does not load on Quest 3** — reduce `max_texture_size` to 2048.
- **Network is slow** — connect the PC with a cable, use 5 GHz for the headset, and enable Pillow for thumbnails.

## Security

The server only serves files from the directories listed in `roots`. Paths containing `..` and symlinks that escape a root are rejected. Only bind to `0.0.0.0` on a trusted home network.
