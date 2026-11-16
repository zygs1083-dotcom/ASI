#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
swift build -c release
exec /usr/bin/python3 scripts/smoke.py .build/release/asi-sense-helper
