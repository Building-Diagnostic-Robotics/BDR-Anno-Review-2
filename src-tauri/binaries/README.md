# Sidecar binaries

Place release-time sidecar binaries for `ffmpeg` and `ffprobe` in this directory when producing bundles.

Tauri external sidecars are resolved from files named with target triples:
- Linux: `ffmpeg-x86_64-unknown-linux-gnu`, `ffprobe-x86_64-unknown-linux-gnu`
- Windows: `ffmpeg-x86_64-pc-windows-msvc.exe`, `ffprobe-x86_64-pc-windows-msvc.exe`

These files are intentionally not committed.
