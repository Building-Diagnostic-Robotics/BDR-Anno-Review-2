# Fixtures

This directory stores tiny, non-sensitive test fixtures for deterministic integration tests.

Do not commit customer datasets, media, or session artifacts.

Frame-sourcing tests use `tiny_dataset/annotations/instances_frame_source_*.json` to validate deterministic COCO image-to-frame index resolution without storing any extracted media outputs in git.
