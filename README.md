# bdr-anno-review

Desktop-first annotation review tool for converting 360° equirectangular COCO datasets into cube-face review datasets, editing boxes quickly, and exporting deterministic normalized COCO.

## Project status

This repository is bootstrapped with a lightweight scaffold aligned with `ARCHITECTURE.md`.

## Architecture at a glance

- **Desktop shell:** Tauri v2
- **Backend:** Rust
- **Frontend:** React + TypeScript + Vite
- **Primary MVP input:** COCO `instances_default.json` + MP4
- **Secondary input convenience:** frames directory (optional)
- **Core manifest:** `annotations/view_manifest.json`
- **Export contract:** single-category deterministic COCO

See `ARCHITECTURE.md` for design decisions and invariants.

## Repository layout

- `frontend/` — React UI app
- `src-tauri/` — Tauri host and Rust command layer
- `crates/engine/` — deterministic dataset pipeline core
- `crates/providers/` — optional LLM provider adapters
- `schemas/` — JSON schemas for canonical artifacts
- `fixtures/` — small test fixtures
- `scripts/` — utility scripts for setup/lint/test

## Quick start

### Prerequisites

- Rust (stable)
- Node.js 20+
- pnpm 9+

### Install dependencies

```bash
./scripts/bootstrap.sh
```

### Run checks

```bash
./scripts/check.sh
```

### Run frontend (scaffold)

```bash
pnpm --dir frontend dev
```

### Run Rust tests (workspace)

```bash
cargo test --workspace
```

## Tester release builds

Tagged releases (for example stable `v0.2.0` or prerelease `v0.2.0-rc.1`) trigger the GitHub Actions workflow `.github/workflows/release.yml`, which runs validation checks, enforces tag/version parity, builds Tauri bundles, and publishes release artifacts. Tags that include a hyphen (such as `-alpha`/`-rc`) are published as GitHub prereleases; plain SemVer tags are published as normal releases. The canonical Tauri app identifier is `io.bdr.annoreview` for installer/update identity continuity.


### Release metadata checklist (before tagging)

1. Choose the release version (for example `0.2.0`) and intended tag (`v0.2.0`).
2. Update versions in this order:
   - `Cargo.toml` `[workspace.package].version`
   - `src-tauri/tauri.conf.json` `version`
   - `frontend/package.json` `version`
3. Move release-ready notes from `## [Unreleased]` into a dated version section in `CHANGELOG.md`.
4. Create and push the tag (for example `git tag v0.2.0 && git push origin v0.2.0`).

On tag builds, CI runs `./scripts/check-tag-version.sh ${{ github.ref_name }}` and fails if any version drifts from the tag value.

### Download artifacts

1. Open the repository's **Releases** page.
2. Select the matching release tag (stable release or prerelease).
3. Download your platform package:
   - **Windows:** `*.nsis.zip` (contains the NSIS installer)
   - **Linux:** `*.AppImage` and/or `*.deb`

### FFmpeg/FFprobe delivery strategy

The app now targets **sidecar binaries** for `ffmpeg` and `ffprobe` (not embedded shared libraries). Sidecars keep runtime integration simple (`Command`-based invocation), preserve explicit failure diagnostics, and avoid adding codec/linker complexity to the Rust build.

Release workflows fetch per-platform FFmpeg sidecar binaries and bundle them into installer artifacts. For local developer runs, the app falls back to `ffmpeg`/`ffprobe` on `PATH` when sidecars are not present.
Bundling is configured in checked-in release config (`src-tauri/tauri.release.conf.json` `bundle.externalBin`) and passed to Tauri in CI via `--config`, so sidecar packaging rules are versioned in-repo instead of workflow inline JSON.

### Platform prerequisites

- **Windows 10/11**
  - Microsoft Edge WebView2 Runtime installed (usually preinstalled on modern Windows, otherwise install from Microsoft).
  - `ffmpeg` + `ffprobe` available either from packaged sidecars or on `PATH` for developer/local runs.
- **Linux (Ubuntu/Debian family)**
  - GTK/WebKit runtime libraries required by Tauri, including `libgtk-3-0` and `libwebkit2gtk-4.1-0`.
  - `ffmpeg` + `ffprobe` available either from packaged sidecars or on `PATH` for developer/local runs.

### Install and run

- **Windows (`.nsis`)**
  1. Extract the downloaded `*.nsis.zip`.
  2. Run the contained installer `.exe`.
  3. Launch **bdr-anno-review** from the Start menu.
- **Linux (`.AppImage`)**
  1. Make executable: `chmod +x bdr-anno-review_*.AppImage`
  2. Run: `./bdr-anno-review_*.AppImage`
- **Linux (`.deb`)**
  1. Install: `sudo apt install ./bdr-anno-review_*_amd64.deb`
  2. Launch from your application menu or by running `bdr-anno-review`.

### Uninstall cleanup behavior

- **Windows (`.nsis`)** uninstall removes app-owned dropped-input staging folders under `%LOCALAPPDATA%\Temp\bdr-anno-review-drop-*`.
- **Linux (`.deb`)** package removal runs a post-remove script that deletes app-owned dropped-input staging folders under `/tmp/bdr-anno-review-drop-*`.
- **Linux (`.AppImage`)** has no package-level uninstall hook; startup/exit cleanup in the app still removes app-owned registered staging folders.

### Tester validation checklist

- Open a known dataset and confirm manifest + face list load successfully.
- Run **Validate import** and confirm reported image/annotation/category counts are sensible.
- Run **Generate review dataset** and verify diagnostics report an **auto-generated** `sourceFramesDir`.
- Edit at least one bbox (create/update/delete), save, switch faces, and return to confirm persistence.
- Export COCO JSON and spot-check deterministic structure (`images`, `annotations`, single `bbox` category).

## Notes

- Keep architecture-sensitive semantic edits consistent with `ARCHITECTURE.md`.
- Do not commit datasets, review sessions, media, or secrets.
