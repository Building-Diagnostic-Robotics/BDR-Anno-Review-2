# Development Guide

## Core principles

- Keep dataset semantics aligned with `ARCHITECTURE.md`.
- Treat COCO `instances_default.json` + MP4 as the preferred/primary MVP input; keep frames-directory support secondary/optional convenience.
- Prefer explicit validation errors on missing required inputs.
- Keep implementation lightweight until complexity is proven necessary.

## Workflow

1. `./scripts/bootstrap.sh`
2. `./scripts/check.sh`
3. Implement feature with tests
4. Update `CHANGELOG.md` under `[Unreleased]`

## Release versioning workflow

Before creating a release tag:

1. Choose release version `X.Y.Z` and target tag `vX.Y.Z`.
2. Update versions in this order:
   - `Cargo.toml` (`[workspace.package].version`)
   - `src-tauri/tauri.conf.json` (`version`)
   - `frontend/package.json` (`version`)
3. Move release-ready notes from `## [Unreleased]` into a dated section in `CHANGELOG.md`.
4. Run `./scripts/check-tag-version.sh vX.Y.Z` locally.
5. Create and push the tag.

Tag builds in `.github/workflows/release.yml` enforce this alignment and fail if any version-bearing file drifts from the tag.

## Determinism expectations

- Manifest ordering must be stable.
- Export ID assignment must be deterministic.
- Any change that impacts ordering or schema should be release-noted.
