#!/usr/bin/env bash
set -euo pipefail

if ! command -v pnpm >/dev/null 2>&1; then
  echo "error: pnpm is required (https://pnpm.io/installation)" >&2
  exit 1
fi

pnpm --dir frontend install
cargo fetch

echo "Bootstrap complete."
