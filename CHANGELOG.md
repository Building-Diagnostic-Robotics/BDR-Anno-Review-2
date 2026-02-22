# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Added Tauri-host regression tests for drop staging to ensure dataset root selection prefers dropped directories over unsupported files and to verify recursive staging skips symlinked directories on Unix.

### Fixed
- Fixed dropped-input staging so `staged_dataset_root` is assigned only from dropped directories; unsupported non-JSON/non-MP4 files are now ignored and reported instead of being misclassified as dataset roots.
- Hardened recursive dropped-directory staging to skip only symlinked directories (preventing recursive traversal of symlink cycles) while preserving symlinked files by materializing their file contents in the staging workspace.

### Changed
- Drop-import diagnostics now report backend-provided ignored staged paths, and the staged-input response schema now includes `ignored_paths` / `ignoredPaths` for explicit UI messaging.

## [0.4.1] - 2026-02-22

### Changed
- Bumped workspace, Tauri app config, and frontend package versions from `0.4.0` to `0.4.1` for dropped-input staging correctness and symlink-safety hardening.

## [0.4.0] - 2026-02-22

### Added
- Added a discoverable **Drop input** workflow in the frontend with a dedicated button and modal popup so users can intentionally use drag-and-drop intake rather than relying on hidden window-drop behavior.
- Added backend staging support via a new Tauri `stage_dropped_inputs_command` that copies dropped files/directories into an app-managed temporary workspace and returns staged paths for dataset root, COCO JSON, and MP4.

### Changed
- Updated drop ingestion to use staged temp-workspace paths before import/generation and improved diagnostics to report the staging workspace and ignored paths.
- Bumped workspace, Tauri app config, and frontend package versions from `0.3.4` to `0.4.0` for the file-input schema and drop-staging UX release.

## [0.3.4] - 2026-02-22

### Fixed
- Fixed Tauri import-stage IPC decoding by introducing a camelCase request boundary for `run_import_stage_command` and mapping it into engine snake_case options, eliminating `missing field `dataset_root`` errors from frontend validation and generation preflight calls.
- Added a camelCase import-stage response boundary in the Tauri host so frontend diagnostics receive consistently-cased fields from `run_import_stage_command`.
- Improved `open_dataset_command` and `list_faces_command` preflight diagnostics to fail loudly with actionable messages when dataset root is missing/invalid or `annotations/view_manifest.json` is absent (including guidance to run Generate review dataset first), replacing opaque OS path errors.
- Added Tauri host regression tests for camelCase import-stage request decoding and manifest-preflight error messaging to prevent recurrence.

### Changed
- Bumped workspace, Tauri app config, and frontend package versions from `0.3.3` to `0.3.4` for the IPC boundary and diagnostics hardening release.

## [0.3.3] - 2026-02-22

### Fixed
- Added explicit Tauri capability permissions for dialog open/save in `src-tauri/capabilities/default.json` so Windows browse/save actions are allowed instead of failing with `plugin:dialog|open` ACL denial at runtime.
- Improved frontend dialog failure diagnostics to surface ACL-specific remediation hints for missing `plugin:dialog|open` and `plugin:dialog|save` permissions, while preserving fail-loud behavior for other picker errors.

### Changed
- Bumped workspace, Tauri app config, and frontend package versions from `0.3.2` to `0.3.3` for the Windows dialog ACL fix release.

## [0.3.2] - 2026-02-22

### Fixed
- Fixed review dataset generation to create the `annotations/` output directory before writing `annotations/view_manifest.json`, preventing Windows `os error 3` (and equivalent missing-parent failures on other OSes) when the directory is absent.
- Added regression coverage for missing `annotations/` directory creation so manifest writes remain fail-loud and cross-platform robust.

### Changed
- Bumped workspace, Tauri app config, and frontend package versions from `0.3.1` to `0.3.2` for the cross-platform manifest output-path fix release.

## [0.3.1] - 2026-02-22

### Fixed
- Added Linux release-bundle sidecar verification in `.github/workflows/release.yml` so CI now inspects generated `.AppImage` and `.deb` artifacts and fails loudly when `ffmpeg`/`ffprobe` sidecars are missing from payload contents.
- Added Linux bundle discovery diagnostics and strict single-artifact checks for AppImage/deb verification, including searched target roots and sidecar-name match diagnostics to make release failures actionable.

### Changed
- Bumped workspace, Tauri app config, and frontend package versions from `0.3.0` to `0.3.1` for the Linux sidecar verification release-hardening update.

## [0.3.0] - 2026-02-22

### Added
- Added drag-and-drop path intake in the desktop UI so dropped `.json` and `.mp4` files auto-fill COCO/MP4 fields and other dropped paths auto-fill dataset root with explicit diagnostics.
- Added in-flow generation progress UI messaging that reports step-by-step status (`validating`, `dependencies`, `extracting`, `generating`) and completion percentage for review dataset generation.

### Changed
- Simplified import/generation UX by removing the confusing three-button split and keeping one primary `Generate review dataset` action plus a secondary `Validate inputs only` action.
- Updated generation orchestration so the primary generate action always runs validation first, then dependency checks, frame extraction, and review dataset generation in one guided sequence with explicit stage diagnostics.
- Added browse dialog failure handling in dataset input pickers so dialog failures are surfaced loudly instead of silently doing nothing.
- Bumped workspace, Tauri app config, and frontend package versions from `0.2.9` to `0.3.0` for the dataset generation UX overhaul release.

### Fixed
- Prevented Windows FFmpeg/FFprobe terminal popups by launching subprocesses with `CREATE_NO_WINDOW` for frame extraction, MP4 probing, and runtime dependency verification command checks.

## [0.2.9] - 2026-02-22

### Fixed
- Fixed the `publish-release` job in `.github/workflows/release.yml` to make GitHub CLI release publishing independent of local `.git` metadata by passing an explicit `--repo "${{ github.repository }}"` target.
- Added a pre-edit `gh release view` diagnostic in `publish-release` with explicit `--repo` scope so missing tag/repo context fails early with actionable output before toggling draft state.

### Changed
- Bumped workspace, Tauri app config, and frontend package versions from `0.2.8` to `0.2.9` for the release publishing context fix.

## [0.2.8] - 2026-02-22

### Fixed
- Fixed Windows NSIS sidecar verification in `.github/workflows/release.yml` to accept both target-suffixed sidecar filenames (`ffmpeg-x86_64-pc-windows-msvc.exe`, `ffprobe-x86_64-pc-windows-msvc.exe`) and normalized names (`ffmpeg.exe`, `ffprobe.exe`) when validating installer payload contents.
- Expanded embedded NSIS payload inspection beyond only `*.exe` files to also inspect `.7z`, `.zip`, and extensionless artifacts, while gracefully skipping unreadable candidates and preserving fail-loud behavior.
- Added richer diagnostics for NSIS verification failures, including selected setup path, allowed sidecar names, extracted sidecar-like file hits, embedded listing candidates, and sidecar-like listing lines to make CI triage actionable.

### Changed
- Bumped workspace, Tauri app config, and frontend package versions from `0.2.7` to `0.2.8` for the Windows sidecar verification reliability fix.

## [0.2.7] - 2026-02-22

### Fixed
- Hardened Windows NSIS sidecar verification in `.github/workflows/release.yml` by replacing the fixed `src-tauri/target` root assumption with dynamic target-root discovery across `$CARGO_TARGET_DIR`, `${{ github.workspace }}/target`, and `${{ github.workspace }}/src-tauri/target`, then recursively locating `bundle/nsis` setup executables from existing roots only.
- Added explicit discovery diagnostics listing searched roots, existing roots, and discovered setup candidates, with fail-loud errors that include probed paths when no target root or NSIS installer is found.

### Changed
- Bumped workspace, Tauri app config, and frontend package versions from `0.2.6` to `0.2.7` for the Windows release verification robustness fix.

## [0.2.6] - 2026-02-22

### Fixed
- Fixed Windows release-side NSIS installer verification in `.github/workflows/release.yml` by replacing the brittle hard-coded `src-tauri/target/release/bundle/nsis` lookup with recursive discovery under `src-tauri/target` filtered to `bundle/nsis` setup candidates.
- Added explicit NSIS setup discovery diagnostics and fail-loud checks for zero or multiple setup candidates so CI failures are actionable.

### Changed
- Bumped workspace, Tauri app config, and frontend package versions from `0.2.5` to `0.2.6` for the Windows NSIS verification-path fix release.

## [0.2.5] - 2026-02-22

### Fixed
- Hardened Windows release artifact verification in `.github/workflows/release.yml` by removing the brittle assumption of a fixed intermediate payload filename and instead checking both recursively extracted files and embedded executable payload listings for `ffmpeg-x86_64-pc-windows-msvc.exe` and `ffprobe-x86_64-pc-windows-msvc.exe`.

### Changed
- Bumped workspace, Tauri app config, and frontend package versions from `0.2.4` to `0.2.5` for the Windows sidecar verification hardening release.

## [0.2.4] - 2026-02-22

### Fixed
- Moved FFmpeg/FFprobe sidecar bundling to a checked-in Tauri release override config (`src-tauri/tauri.release.conf.json` `bundle.externalBin`) and switched CI to pass it with `--config`, so Windows/Linux bundles use versioned sidecar rules instead of workflow-inline JSON overrides.
- Added post-build Windows NSIS artifact inspection in release CI to assert that `ffmpeg-x86_64-pc-windows-msvc.exe` and `ffprobe-x86_64-pc-windows-msvc.exe` are present in the packaged app payload.
- Expanded runtime dependency diagnostics to include sidecar candidate paths checked before PATH fallback, making missing-sidecar packaging issues easier to debug from user reports.

### Changed
- Bumped workspace, Tauri app config, and frontend package versions from `0.2.3` to `0.2.4` for the sidecar packaging reliability fix release.

## [0.2.3] - 2026-02-22

### Fixed
- Fixed runtime FFmpeg/FFprobe sidecar discovery in the Tauri host by searching both top-level and `binaries/`-prefixed resource paths (plus adjacent executable fallbacks), so tagged-release installers can resolve bundled sidecars consistently at runtime.
- Kept release-time `bundle.externalBin` injection in `.github/workflows/release.yml` and added a filename guard so bundled sidecar expectations fail fast before Tauri packaging starts.

### Changed
- Bumped workspace, Tauri app config, and frontend package versions from `0.2.2` to `0.2.3` for the packaging fix release.

## [0.2.2] - 2026-02-22

### Fixed
- Added the missing `src-tauri/icons/512x512.ico` release icon asset and bumped workspace/Tauri/frontend versions to `0.2.2` so release tags can be cut with aligned metadata.

## [0.2.1] - 2026-02-22

### Changed
- Removed the Tauri build-script fallback that generated a 1x1 placeholder icon and now require repository-provided icon assets for bundling.
- Configured Tauri `bundle.icon` entries for standard Windows/macOS/Linux icon filenames so AppImage/deb/nsis packaging can resolve square icon assets from `src-tauri/icons/`.
- Bumped workspace/Tauri/frontend version metadata to `0.2.1` for the icon/bundling fix release.

- Switched the Tauri bundle identifier from placeholder `com.example.bdrannoreview` to canonical reverse-DNS `io.bdr.annoreview` to stabilize installer/update identity across tester and production channels.
- Updated the generation UI to treat source frame directory as MP4-extraction-managed output (read-only), and clarified diagnostics to label it as auto-generated.
- Added release tag/version parity checks in CI (`scripts/check-tag-version.sh`) and release docs guidance so Cargo/Tauri/frontend versions stay aligned before tagging.

## [0.2.0] - 2026-02-22

### Tester Summary
- **Supported platforms:** Windows (NSIS installer) and Linux (`.AppImage`, `.deb`).
- **MVP capabilities:** validate import inputs, extract MP4 frames, generate deterministic review faces/manifest, edit bounding boxes, and export deterministic COCO.
- **Known limitations / deferred scope:** MP4-first workflow (manual source-frame override disabled), optional provider integrations deferred, and external FFmpeg sidecar prerequisites remain explicit.

### Changed
- Expanded release workflow matrix jobs to fetch platform-specific FFmpeg sidecar binaries and pass Tauri `externalBin` configuration at bundle time so installers include working `ffmpeg`/`ffprobe` out of the box.
- Surfaced invalid bundled FFmpeg sidecars as explicit runtime errors instead of silently falling back to PATH resolution, making packaging failures deterministic and actionable.
- Decided FFmpeg delivery strategy for release builds: ship `ffmpeg`/`ffprobe` as sidecar binaries (with PATH fallback in local/dev), added runtime dependency preflight diagnostics in Tauri/frontend generation flows, and documented the rationale/prerequisites in architecture + README guides.
- Improved dataset onboarding UX by replacing fixture defaults with empty-state inputs, adding Tauri file/folder/save pickers for dataset/COCO/MP4/export selection, and surfacing client-side required-field/extension validation before import, generation, and export actions.
- Expanded quality gates to run frontend unit tests in local `scripts/check.sh`, CI, and release-check workflows in addition to existing type checks.
- Hardened `frame_sourcing` extraction tests to be cross-platform and deterministic by gating Unix-specific permission usage and by forcing missing-ffprobe failures through an explicit nonexistent binary path.
- Enabled Tauri bundling for distributable tester artifacts and set minimal Windows/Linux bundle targets (`nsis`, `appimage`, `deb`) for external delivery.
- Added a tag-driven GitHub Actions release workflow that runs frontend/Rust checks, builds platform bundles, and publishes Windows/Linux artifacts for both stable and prerelease tags.
- Fixed release bundling workflow to build `frontend/dist` in the tag-only bundle job before invoking `tauri-action`, preventing missing-web-assets failures on clean runners.
- Documented tester download, platform prerequisites, and install/run steps in the README release guide.
- Added reviewer-side bounding-box deletion controls (button + Delete/Backspace shortcut) with consistent active-selection/pointer-state updates, plus frontend roundtrip behavior checks covering delete → save → reload persistence through existing annotation APIs.
- Wired MP4-first review generation end-to-end: added backend frame extraction before generation, connected it through a new Tauri command and frontend generate/validate+generate flows, aligned generation to deterministic `frame_######.png` mapping for MP4 inputs, and expanded engine coverage for MP4 happy-path plus explicit extraction-failure diagnostics.
- Replaced review face generation's source-frame file copy placeholder with real equirectangular-to-perspective rendering per configured face (`front/right/back/left`), render size, and horizontal FOV so generated face images are distinct projections rather than duplicates.
- Upgraded the reviewer UI from text-only bbox editing to include selected-face image preview rendering, a canvas-based bbox interaction layer (draw/move/resize) synchronized with existing annotation get/set/save flows, keyboard-driven face navigation continuity, and explicit client-side invalid-edit feedback with non-negative size safeguards before save.
- Updated CI workflow ordering to build `frontend/dist` before Rust checks so Tauri `generate_context!()` can resolve the configured `frontendDist` path during `cargo test` and `cargo clippy`.
- Expanded view manifest schema and Rust engine manifest models to include structured `inputs`, `render`, and `projection` metadata with explicit required-field validation, including MP4 frame-source variant support and schema-version expectation checks in unit tests.
- Aligned `schemas/view_manifest.schema.json` face entries with engine output by allowing optional `initial_boxes` (with strict `source_annotation_id` + 4-number `bbox` shape) while preserving `additionalProperties: false`, and added engine tests that lock schema expectations to manifest model behavior.
- Clarified the MVP input contract across architecture and contributor docs: COCO `instances_default.json` + MP4 is primary/preferred, with frames-directory support documented as secondary/optional convenience.
- Updated GitHub Actions CI to install required Linux GTK/GLib/WebKit system packages before Rust checks so Tauri-linked crates can compile on ubuntu runners.

- Wired an end-to-end import-to-generation workflow into the app by adding a Tauri `generate_review_dataset_command`, frontend invoke wrapper, and import-section actions for generation-only or validate+generate flows with explicit diagnostics that distinguish validation failures vs generation failures and report manifest path + generated face counts.

### Added

- Added an end-to-end MVP reviewer UI + Tauri command bridge for dataset open/import, face listing, annotation get/set/save, and COCO export, including keyboard face navigation, progress indicator, and clear backend status/error diagnostics (with optional LLM suggestions explicitly deferred), and configured Tauri bundling to avoid checked-in binary icon assets.
- Added a deterministic `crates/engine` COCO export pipeline that builds output from manifest face order + persisted review edits, enforces a single `{id:1,name:"bbox"}` category contract, assigns incremental image/annotation IDs, validates export preconditions (manifest, edits readability, writable output path), and includes repeat-run stability tests.
- Added annotation-edit persistence in `crates/engine` via `annotations/review_edits.json`, including deterministic face-keyed serialization, atomic write/rename behavior, explicit payload validation, and backend APIs for `get_annotations(face_id)` / `set_annotations(face_id, edits)` with Tauri command bindings.
- Added a review-generation pipeline in `crates/engine` that deterministically processes referenced source frames into `front/right/back/left` 1024x1024 face artifacts, projects and clips source COCO boxes per face with minimum-area filtering, emits stable `face_id` values from source/render/projection inputs, writes manifest entries in deterministic order, and fails loudly with actionable required-input diagnostics.
- Added deterministic engine tests covering stable manifest ordering and `face_id` reproduction across repeated runs, plus required-input failure diagnostics for missing source frames.
- Added a new `frame_sourcing` engine module that resolves only COCO annotation-referenced images into deterministic frame-extraction plans, maps `images[].file_name` / optional `frame_index` conventions to `derived_frames/frame_sourcing/frame_######.png`, and raises explicit diagnostics when frame references are unresolved or out of MP4 bounds.
- Added fixture-driven frame-sourcing tests and tiny COCO fixtures under `fixtures/tiny_dataset/annotations/instances_frame_source_*.json` to validate deterministic mapping and failure diagnostics.
- Added an import-stage module in `crates/engine` that validates MVP inputs (`dataset_root`, COCO JSON, MP4), parses and validates required COCO sections (`images`, `annotations`, `categories`), builds image-id lookup for annotation reference resolution, and emits explicit user-facing errors for missing files, unsupported formats, empty sections, parse failures, and broken references.
- Added a Tauri command (`run_import_stage_command`) to expose import-stage validation results/errors to the frontend invoke layer.
- Initial architecture-aligned repository scaffold for frontend, Tauri host, Rust crates, schemas, fixtures, CI, and utility scripts.
- Core project documents (`README.md`, docs contribution guide, schema and fixture readmes).
- Safety-focused `.gitignore` rules for datasets, media, secrets, and session artifacts.
