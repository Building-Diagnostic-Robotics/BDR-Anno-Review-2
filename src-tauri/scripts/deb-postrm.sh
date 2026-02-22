#!/bin/sh
set -eu

for candidate in /tmp/bdr-anno-review-drop-*; do
  [ -d "$candidate" ] || continue
  [ -f "$candidate/.bdr-anno-review-owned" ] || continue
  rm -rf -- "$candidate"
done
