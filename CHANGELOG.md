# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Expanded view manifest schema and Rust engine manifest models to include structured `inputs`, `render`, and `projection` metadata with explicit required-field validation, including MP4 frame-source variant support and schema-version expectation checks in unit tests.
- Clarified the MVP input contract across architecture and contributor docs: COCO `instances_default.json` + MP4 is primary/preferred, with frames-directory support documented as secondary/optional convenience.
- Updated GitHub Actions CI to install required Linux GTK/GLib/WebKit system packages before Rust checks so Tauri-linked crates can compile on ubuntu runners.

### Added
- Added a new `frame_sourcing` engine module that resolves only COCO annotation-referenced images into deterministic frame-extraction plans, maps `images[].file_name` / optional `frame_index` conventions to `derived_frames/frame_sourcing/frame_######.png`, and raises explicit diagnostics when frame references are unresolved or out of MP4 bounds.
- Added fixture-driven frame-sourcing tests and tiny COCO fixtures under `fixtures/tiny_dataset/annotations/instances_frame_source_*.json` to validate deterministic mapping and failure diagnostics.
- Added an import-stage module in `crates/engine` that validates MVP inputs (`dataset_root`, COCO JSON, MP4), parses and validates required COCO sections (`images`, `annotations`, `categories`), builds image-id lookup for annotation reference resolution, and emits explicit user-facing errors for missing files, unsupported formats, empty sections, parse failures, and broken references.
- Added a Tauri command (`run_import_stage_command`) to expose import-stage validation results/errors to the frontend invoke layer.
- Initial architecture-aligned repository scaffold for frontend, Tauri host, Rust crates, schemas, fixtures, CI, and utility scripts.
- Core project documents (`README.md`, docs contribution guide, schema and fixture readmes).
- Safety-focused `.gitignore` rules for datasets, media, secrets, and session artifacts.
