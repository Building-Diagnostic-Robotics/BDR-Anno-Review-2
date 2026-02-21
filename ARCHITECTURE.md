# ARCHITECTURE.md

## Purpose

`bdr-anno-review` converts 360° equirectangular COCO datasets into a lightweight “review dataset” of cube-face perspective images, provides a fast local UI to edit bounding boxes, and exports a normalized COCO output.

This document is the canonical reference for:
- architecture and component boundaries
- major design decisions and tradeoffs
- on-disk formats and determinism rules
- build + distribution strategy (Linux + Windows)

---

## Goals

### Product goals
- **Low friction**: open a dataset folder, review/edit, export.
- **Lightweight distribution**: small installers; minimal runtime dependencies.
- **Fast iteration**: rapid UI + workflow dev without over-engineering.
- **Deterministic outputs**: same inputs → same view manifest + export COCO (modulo explicit edits).
- **Local-first**: work offline for everything except optional LLM suggestions.

### Non-goals (initially)
- Multi-user collaboration / server mode
- Full COCO category taxonomy or segmentation/polygons
- Cloud-hosted datasets and identity/auth
- Video editing or timeline tooling

---

## Target platforms

- **Windows** (primary)
- **Linux** (primary)

macOS may be supported later, but is not a requirement for the initial architecture decisions.

---

## High-level architecture

The app is a **desktop application** with a **local backend** and **embedded web UI**.

- **Desktop shell**: Tauri (v2)
- **Backend**: Rust (local “engine” + APIs exposed to UI)
- **Frontend UI**: React + TypeScript + Vite

### Why this stack
- **Lightweight installers** compared to Electron (system WebView).
- **Simple distribution**: single downloadable app, no Python envs.
- **Performance**: Rust for image transforms / projection math.
- **Security**: LLM calls happen only in backend so API keys never touch the browser context.

---

## Key workflows

### 1) Import and “review dataset” generation

Inputs:
- COCO `instances_default.json`
- either:
  - a frames directory (preferred), or
  - an MP4 (optional convenience path)

Rules:
- Only frames referenced by COCO annotations are selected:
  - source frames = `annotations[].image_id` → resolve to `images[]` entries
- For each selected frame:
  - render cube faces: `front`, `right`, `back`, `left`
  - resolution: `1024x1024`
  - project legacy equirectangular bounding boxes onto faces to initialize review boxes
- Generate a `view_manifest.json` describing the rendered faces, stable IDs, and mapping back to source images and annotations.

Outputs (review dataset root):
```

dataset_root/
├── annotations/
│   ├── instances_default.json         # original or imported COCO (read-only baseline)
│   └── view_manifest.json             # canonical mapping for review dataset
└── raw_frames/
└── *.png                          # rendered cube-face images

````

### 2) Optional suggestion generation (LLM)

- UI requests suggestions per face
- Backend calls OpenAI (or other providers later) to return candidate boxes
- UI shows suggestions as “proposed” boxes the reviewer can accept/edit/reject

### 3) Review UI edit loop

- User edits boxes: add/move/resize/delete
- Changes are persisted locally (see Persistence section)

### 4) Export normalized COCO

Export rules:
- Output COCO uses a **single dummy category**:
  - `categories = [{ "id": 1, "name": "bbox" }]`
  - every `annotation.category_id == 1`
- Export images correspond to rendered faces (not original equirectangular frames).
- Deterministic, manifest-ordered incremental IDs are used for `images[].id` and `annotations[].id`.

---

## Components and responsibilities

### Frontend (React/TS)
Responsibilities:
- dataset selection UX
- face browsing (grid / filmstrip / keyboard navigation)
- annotation editing (bbox)
- suggestion review (accept/edit/reject)
- status/progress, error reporting
- export orchestration

Non-responsibilities:
- reading/writing COCO directly on disk
- projection math
- LLM API calls

Key UI modules:
- `DatasetOpen`: pick dataset folder / import
- `FaceBrowser`: face list / filters / navigation
- `AnnotatorCanvas`: draw/edit bboxes on canvas
- `SuggestionsPanel`: view/compare suggestions vs current boxes
- `ExportWizard`: validate + export

### Backend (Rust “engine”)
Responsibilities:
- reading/writing dataset artifacts on disk
- cube-face rendering from equirectangular frames
- bbox projection between coordinate spaces
- deterministic ID generation
- optional MP4 frame extraction (sidecar)
- LLM provider calls and response normalization
- export COCO generation

Non-responsibilities:
- rich UI state management
- user account/session management

Backend exposes commands/APIs via Tauri:
- `open_dataset(path)`
- `generate_review_dataset(options)`
- `list_faces(manifest_filters)`
- `read_face_image(face_id)` (or static file serving)
- `get_annotations(face_id)`
- `set_annotations(face_id, edits)`
- `get_suggestions(face_id, provider_config)`
- `export_coco(export_path, options)`

---

## Data model

### Coordinate spaces

1) **Equirectangular source space**  
- origin: top-left of the equirectangular image
- units: pixels
- bbox: `[x, y, w, h]`

2) **Cube-face pixel space (per face)**  
- 1024x1024
- origin: top-left of the face image
- bbox: `[x, y, w, h]`

Projection rules:
- legacy equirectangular bbox → face bbox via:
  - sampling bbox corners (and optionally edges) in spherical coordinates
  - projecting onto the cube face plane
  - taking the axis-aligned bounding rectangle in face pixel space
- clip to face bounds
- discard boxes with too-small area after projection (configurable threshold)

### `view_manifest.json` (canonical mapping)

`view_manifest.json` is the primary “index” for the review dataset and must be treated as source-of-truth for:
- which faces exist
- stable identity across runs
- mapping between:
  - original COCO `images[]` and `annotations[]`
  - rendered face images
  - review annotations state

Conceptual structure (illustrative):
```jsonc
{
  "schema_version": 1,
  "generated_at": "2026-02-21T00:00:00Z",
  "inputs": {
    "coco_path": "annotations/instances_default.json",
    "frames_source": { "type": "dir", "path": "..." } // or { "type": "mp4", ... }
  },
  "render": {
    "faces": ["front", "right", "back", "left"],
    "size": 1024
  },
  "items": [
    {
      "source_image_id": 123,
      "source_file_name": "frame_000123.png",
      "faces": [
        {
          "face_id": "…stable…",
          "face": "front",
          "file": "raw_frames/<face_id>.png",
          "initial_boxes": [ /* projected legacy boxes */ ]
        }
      ]
    }
  ]
}
````

#### Stable IDs

* `face_id` is stable across runs for the same input dataset and render options.
* Use a deterministic hash of:

  * source image file name or source image id
  * face name (`front/right/back/left`)
  * render size
  * projection parameters (if those impact output)
* Never use random UUIDs for canonical artifacts.

### Edit persistence

Edits must survive restarts and be easy to merge/inspect.

Decision:

* Store edits in a separate file (or files) rather than mutating `instances_default.json`.

Preferred:

* `annotations/review_edits.json` (or sharded per face if needed later)
* `view_manifest.json` remains immutable after generation except for schema migrations.

Edits format:

* For each `face_id`, store the current authoritative list of bboxes.
* Include metadata fields for provenance (manual vs suggestion).

---

## Determinism and ID policy

### Manifest-ordered incremental IDs

Export COCO uses deterministic incremental IDs:

* `images[].id`: 1..N in the order faces appear in the manifest
* `annotations[].id`: 1..M in a deterministic order (by image order then bbox order)

Why:

* avoids churn when re-exporting
* makes diffs reviewable
* helps downstream tooling and testing

### Sorting rules

* Stable face ordering:

  1. sort by source image (stable by COCO `images[].id` or file name)
  2. face order fixed: `front, right, back, left`
* Bbox ordering in an image:

  * sort by `(x, y, w, h)` after rounding to a consistent precision

---

## MP4 support and “lightweight” constraint

Default/primary ingestion path is **frames directory**.

MP4 ingestion is optional and should not compromise lightweight distribution:

* Use an **ffmpeg sidecar** invoked by the backend.
* If bundling ffmpeg bloats the installer too much, provide:

  * “MP4 Support” as an optional download/install step, or
  * detect system ffmpeg first, then fall back to bundled sidecar if present.

Rationale:

* keeps the core app small
* avoids Linux dependency surprises
* reduces build complexity

---

## LLM suggestions design

### Backend-only provider calls

* The frontend never calls OpenAI directly.
* API keys are stored in OS credential storage where possible.
* Requests include:

  * face image (as bytes or local file reference)
  * existing boxes (optional)
  * desired output format: list of `[x, y, w, h]` in face pixel space

### Response normalization

Backend converts provider response into:

* `suggestions[]` with:

  * `bbox`
  * `confidence` (if available)
  * `source` (provider/model)
  * `generated_at`
  * optional `rationale` (kept out of export; UI-only)

### Failure modes

* If LLM fails, UI remains fully functional.
* Suggestions are treated as non-authoritative until accepted.

---

## Performance strategy

### Rendering

* Render faces in parallel (thread pool).
* Use streaming IO (avoid holding full dataset in memory).
* Cache derived values (projection matrices, camera model parameters).

### UI responsiveness

* UI loads images via file URLs or backend streaming endpoints.
* Annotation operations are client-side (no roundtrip for drag/resize).
* Persist edits with debounced writes to avoid excessive disk churn.

### Large datasets

* Manifest enables paging; UI should not load everything at once.
* Progressive rendering: generate and index faces incrementally and update manifest safely.

---

## Error handling philosophy

* Fail early on invalid dataset structure:

  * missing COCO `images[]`
  * invalid `image_id` references
  * missing source frames for selected images
* Provide actionable error messages (“missing frame file: …”).
* Never partially overwrite canonical artifacts without a safe temp + atomic rename.

---

## Repository layout (proposed)

```
/
├── frontend/                 # React/TS app (Vite)
│   ├── src/
│   └── package.json
├── src-tauri/                # Tauri + Rust backend
│   ├── src/
│   ├── Cargo.toml
│   └── tauri.conf.json
├── crates/
│   ├── engine/               # pure Rust library: COCO, rendering, projection, export
│   └── providers/            # LLM provider clients (OpenAI first)
├── schemas/                  # JSON schema for manifest + edits
├── fixtures/                 # tiny datasets for tests
├── docs/
│   └── ARCHITECTURE.md
└── .github/workflows/
    └── release.yml
```

Guideline:

* Keep the core logic in `crates/engine` to make it testable without Tauri.

---

## Build, packaging, and release

### Local dev

* `pnpm dev` (frontend)
* `cargo tauri dev` (full app)

### CI

* On tag push `v*`:

  * build Windows + Linux
  * create GitHub Release
  * upload artifacts (MSI/EXE and AppImage, optionally deb/rpm)

### Artifact policy

* Prefer **one “just works” artifact** per OS:

  * Windows: MSI
  * Linux: AppImage

Optional extras:

* `.deb` for Debian/Ubuntu fleets
* zipped portable build for advanced users

---

## Testing strategy

### Unit tests (Rust)

* COCO parsing/validation
* projection math (known cases)
* determinism tests:

  * same input → same face_id values
  * same manifest → same export IDs/order

### Integration tests

* Fixture dataset end-to-end:

  * generate manifest
  * render faces
  * apply edits
  * export COCO
  * verify schema + counts

### UI tests (minimal initially)

* Smoke tests for:

  * dataset open
  * image load
  * bbox edit persists

---

## Security and privacy

* All data stays local by default.
* LLM calls are opt-in; only the needed inputs are sent.
* API keys stored securely (OS keychain) when supported.
* Never log secrets; redact in error paths.

---

## Extensibility roadmap (architecture-friendly)

Planned future upgrades that this architecture supports cleanly:

* additional cube faces (top/bottom) via manifest schema version bump
* provider abstraction for LLM (OpenAI / others)
* non-LLM suggestion sources (classic CV model, heuristic proposals)
* dataset sharding for huge datasets
* multi-category support (if desired) while still exporting single category for compatibility

---

## Design decisions summary

* Desktop app via **Tauri** for lightweight installers and low friction distribution.
* **Rust engine** owns IO, rendering, projection, export, and LLM calls.
* **React/TS UI** for fast development of a high-velocity annotation UX.
* **Frames directory is the primary input**; MP4 support uses optional ffmpeg sidecar to avoid bloat.
* `view_manifest.json` is canonical, stable, versioned, and drives determinism.
* Export COCO normalized to a **single dummy category** with deterministic IDs.

---
