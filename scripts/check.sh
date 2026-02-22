#!/usr/bin/env bash
set -euo pipefail

# Tauri compile-time context validation requires `frontend/dist` to exist.
if [[ ! -d "frontend/dist" ]]; then
  pnpm --dir frontend build
fi

cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace
pnpm --dir frontend lint
pnpm --dir frontend test
