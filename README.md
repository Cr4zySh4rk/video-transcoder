# VideoForge

Hardware-accelerated video transcoder — converts any format to x264 web-optimized MP4, with precise dialogue/background audio controls.

**[🌐 Open Web App](https://cr4zysh4rk.github.io/video-transcoder/)**

---

## Features

- **Any input format** — MKV, MOV, AVI, TS, MTS, M2TS, WMV, FLV, WebM, MP4, and more
- **Web-optimized x264 MP4** — `-movflags +faststart` for immediate browser playback
- **Hardware acceleration** — NVIDIA NVENC, AMD AMF, Intel Quick Sync, Apple VideoToolbox (auto-detected)
- **Audio controls**
  - Dialogue/speech boost (300 Hz–4 kHz EQ)
  - Background music/score reduction (bass & air-band attenuation)
  - Speech enhancement (multi-band compression + clarity)
  - EBU R128 loudness normalization
  - Multi-track audio stream selection
- **Real-time progress** via WebSocket (speed, FPS, time remaining)

---

## Downloads

Grab the latest pre-built binary from [Releases](https://github.com/Cr4zySh4rk/video-transcoder/releases). FFmpeg is **bundled** — no separate install required.

| Platform | File |
|----------|------|
| macOS (Intel + Apple Silicon) | `VideoForge-*-universal.dmg` |
| Windows (installer) | `VideoForge-Setup-*.exe` |
| Windows (portable) | `VideoForge-*-Portable.exe` |
| Linux (AppImage) | `VideoForge-*.AppImage` |
| Linux (tar.gz) | `VideoForge-*.tar.gz` |

**macOS first launch:** right-click → Open → Open (Gatekeeper, one time only)

---

## Run from Source

```bash
# Prerequisites: Node.js 18+ and FFmpeg
git clone https://github.com/Cr4zySh4rk/video-transcoder.git
cd video-transcoder
npm install
node server.js
# Open http://localhost:3000
```

Or use the launcher scripts in the repo root:
- **Windows:** `launch-windows.bat`
- **macOS:** `chmod +x launch-mac.sh && ./launch-mac.sh`
- **Linux:** `chmod +x launch-linux.sh && ./launch-linux.sh`

---

## Build Desktop Apps

```bash
npm install
npm run dist
# Release artifacts appear in ./release/
```

Automated builds run on GitHub Actions and publish to [Releases](https://github.com/Cr4zySh4rk/video-transcoder/releases) when you push a `v*` tag.

---

## Architecture

```
+----------------------------------+
|  GitHub Pages                    |
|  https://cr4zysh4rk.github.io/  |  <- Static frontend
|  video-transcoder/               |     (connects to local server)
+----------+-----------------------+
           | http://localhost:3000
           v
+----------------------------------+
|  Local Node.js Server            |
|  (Electron app or node server.js)|  <- Runs on YOUR machine
|                                  |     Uses YOUR CPU/GPU
|  Bundled FFmpeg (no install)     |
+----------------------------------+
```

---

## License

MIT
