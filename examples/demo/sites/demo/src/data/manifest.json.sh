#!/usr/bin/env bash
# The warehouse's manifest: when it was refreshed, and each table's row count.
set -euo pipefail
cat "${DATA:?run with observatory dev or observatory build, which set DATA}/manifest.json"
