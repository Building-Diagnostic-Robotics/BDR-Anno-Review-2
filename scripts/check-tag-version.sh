#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <tag-or-version>" >&2
  exit 2
fi

raw_ref="$1"
expected_version="${raw_ref#refs/tags/}"
expected_version="${expected_version#v}"

workspace_version="$(sed -n 's/^version = "\(.*\)"/\1/p' Cargo.toml | head -n 1)"
tauri_version="$(python3 - <<'PY'
import json
from pathlib import Path
print(json.loads(Path('src-tauri/tauri.conf.json').read_text())['version'])
PY
)"
frontend_version="$(python3 - <<'PY'
import json
from pathlib import Path
print(json.loads(Path('frontend/package.json').read_text())['version'])
PY
)"

errors=0
check_match() {
  local name="$1"
  local value="$2"
  if [[ "$value" != "$expected_version" ]]; then
    echo "error: ${name} version '${value}' does not match expected '${expected_version}'" >&2
    errors=1
  fi
}

check_match "workspace(Cargo.toml [workspace.package].version)" "$workspace_version"
check_match "tauri(src-tauri/tauri.conf.json version)" "$tauri_version"
check_match "frontend(frontend/package.json version)" "$frontend_version"

if [[ "$errors" -ne 0 ]]; then
  exit 1
fi

echo "version metadata matches tag/version ${expected_version}"
