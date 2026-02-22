#!/bin/sh
set -eu

find /tmp -maxdepth 1 -type d -name 'bdr-anno-review-drop-*' -exec rm -rf {} + 2>/dev/null || true

exit 0
