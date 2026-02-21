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

## Determinism expectations

- Manifest ordering must be stable.
- Export ID assignment must be deterministic.
- Any change that impacts ordering or schema should be release-noted.
