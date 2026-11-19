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
4. VR controls:

   **Photo mode**
   - **Right thumbstick left/right** — previous/next photo (with repeat delay when held);
   - **Thumbstick up/down** — zoom (0.6×–2.5×, current value is shown in the hint under the photo);
   - **Trigger** — next photo, **grip/squeeze** — previous photo;
   - **Press the thumbstick** or the **B/Y** button — open the 3D gallery.

   **3D gallery**
   - 12 visible cards (4×3) with a **vertical scrollbar** on the right: cards slide continuously as the cursor moves, and the bar shows your position in the list;
   - **Right controller ray** works only here: pointing highlights a card and the trigger opens it. The ray is disabled in photo mode;
   - **Thumbstick left/right** — move the selection, **up/down** — move one row;
   - **Trigger** — open the selection: a folder is entered, `↑ Назад` goes up one level, a photo is displayed;
   - **"Exit VR" button** at the bottom of the gallery (point at it and press the trigger);
   - **Grip**, **thumbstick press** or **B/Y** — return to the photo.

   On a PC you can test with the arrow keys (left/right — photos, up/down — zoom or gallery rows), `Enter` (open), `G` (switch mode) and `Escape` (exit VR).

   The hint panel under the photo and the gallery header show the current controls right in VR.

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
