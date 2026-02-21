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

## Notes

- Keep architecture-sensitive semantic edits consistent with `ARCHITECTURE.md`.
- Do not commit datasets, review sessions, media, or secrets.
