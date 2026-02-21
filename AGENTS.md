# Repository Guidelines for Automation (AGENTS)

## Document purpose and boundaries
This document is the **canonical source for automation-only guardrails and agent workflow requirements**.

Out of scope for this document:
- System design and architecture invariants → see `ARCHITECTURE.md`.

## Agent scope
These instructions apply to automated agents working in this repository.

## Automation guardrails
- Do not silently change dataset semantics; treat architecture invariants as release-sensitive and consult `ARCHITECTURE.md` before semantic edits.
- Fail loudly on missing required inputs and preserve explicit diagnostics.
- Keep dependencies and implementation weight minimal unless a change clearly requires more.
- Never commit customer data, secrets, generated datasets, credentials, or session artifacts.
- Track changes in `CHANGELOG.md` using formatting from [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
- This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Security & privacy
- Maintain a safe `.gitignore` to prevent committing:
  - videos, images, datasets, derived frames
  - API keys, `.env`, credentials
  - `dataset_root/annotations/sessions/` (review work products)
- Never print secrets to logs.
