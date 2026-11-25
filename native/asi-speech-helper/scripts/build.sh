#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HELPER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
REPO_ROOT="$(cd "$HELPER_DIR/../.." && pwd)"
TARGET_ARCH="${1:-arm64}"
INFO_PLIST="$HELPER_DIR/Sources/ASISpeechHelper/Info.plist"
OUT_BIN="${2:-$REPO_ROOT/apps/asi-presence/dist/main/asi-speech-helper}"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "asi-speech-helper can only be compiled on macOS (Apple Speech framework)." >&2
  exit 1
fi

case "$TARGET_ARCH" in
  arm64|x86_64) ;;
  *)
    echo "Unsupported target architecture '$TARGET_ARCH' (expected arm64 or x86_64)." >&2
    exit 1
    ;;
esac

if [[ ! -f "$INFO_PLIST" ]]; then
  echo "Expected Info.plist not found at $INFO_PLIST" >&2
  exit 1
fi

if ! command -v swift >/dev/null 2>&1; then
  echo "Swift toolchain not found. Install Xcode Command Line Tools (xcode-select --install)." >&2
  exit 1
fi

BASE_ARGS=(
  build
  --package-path "$HELPER_DIR"
  --configuration release
  --arch "$TARGET_ARCH"
)

BIN_PATH_OUT="$(swift "${BASE_ARGS[@]}" --show-bin-path)"
BIN_DIR="$(printf '%s\n' "$BIN_PATH_OUT" | awk '{ sub(/\r$/, "") } NF { line = $0 } END { print line }')"
BUILT_BIN="$BIN_DIR/asi-speech-helper"

# SwiftPM excludes Info.plist from target sources and does not track external -Xlinker inputs;
# remove a stale binary when Info.plist is newer so SwiftPM relinks with the updated plist.
if [[ -n "$BIN_DIR" && -f "$BUILT_BIN" && "$INFO_PLIST" -nt "$BUILT_BIN" ]]; then
  rm -f "$BUILT_BIN"
fi

BUILD_ARGS=(
  "${BASE_ARGS[@]}"
  --product asi-speech-helper
  -Xlinker -sectcreate
  -Xlinker __TEXT
  -Xlinker __info_plist
  -Xlinker "$INFO_PLIST"
)

swift "${BUILD_ARGS[@]}"

if [[ -z "$BIN_DIR" || ! -x "$BUILT_BIN" ]]; then
  echo "Expected compiled binary not found at $BUILT_BIN" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT_BIN")"
TMP_BIN="${OUT_BIN}.tmp.$$"
cleanup_tmp() {
  rm -f "$TMP_BIN"
}
trap cleanup_tmp EXIT
trap 'cleanup_tmp; exit 130' INT
trap 'cleanup_tmp; exit 143' TERM
cp -f "$BUILT_BIN" "$TMP_BIN"
chmod 755 "$TMP_BIN"
# Re-apply an ad-hoc signature so embedded __TEXT,__info_plist is bound into the CodeDirectory on Apple Silicon.
if command -v codesign >/dev/null 2>&1; then
  if ! CODESIGN_ERR="$(codesign --force --sign - "$TMP_BIN" 2>&1)"; then
    printf '%s\n' "$CODESIGN_ERR" >&2
    exit 1
  fi
fi
mv -f "$TMP_BIN" "$OUT_BIN"
trap - EXIT INT TERM

echo "Built macOS ($TARGET_ARCH) asi-speech-helper -> $OUT_BIN"
