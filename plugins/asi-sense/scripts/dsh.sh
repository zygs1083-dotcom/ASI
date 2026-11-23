#!/bin/sh
set -eu

supported="0.2.2-rc.3 0.2.2-rc.5"
export DSH_TELEMETRY_DISABLED=1
if [ -n "${DSH_ROOT:-}" ]; then
  export TSX_TSCONFIG_PATH="$DSH_ROOT/tsconfig.json"
fi

supported_version() {
  for expected in $supported; do
    if [ "$1" = "$expected" ]; then
      return 0
    fi
  done
  return 1
}

if command -v dsh >/dev/null 2>&1; then
  dsh=$(command -v dsh)
  if ! version=$("$dsh" --version); then
    echo "Cannot determine the version of $dsh; expected one of: $supported." >&2
    exit 1
  fi
  if ! supported_version "$version"; then
    echo "PATH dsh is $version; expected one of: $supported. Install a matching version or remove it from PATH." >&2
    exit 1
  fi
  exec "$dsh" "$@"
fi

if [ -z "${DSH_ROOT:-}" ] || [ ! -f "$DSH_ROOT/apps/cli/src/bin.ts" ] || [ ! -f "$DSH_ROOT/tsconfig.json" ]; then
  echo "No dsh in PATH. Set DSH_ROOT to a built DSH source checkout ($supported)." >&2
  exit 1
fi
DSH_ROOT=$(cd "$DSH_ROOT" && pwd -P)
export DSH_ROOT TSX_TSCONFIG_PATH="$DSH_ROOT/tsconfig.json"
if ! tsx=$(node -p "require.resolve('tsx/esm', { paths: [process.env.DSH_ROOT] })"); then
  echo "Cannot resolve tsx from DSH_ROOT; install and build the DSH checkout first." >&2
  exit 1
fi
if ! version=$(node --import "$tsx" "$DSH_ROOT/apps/cli/src/bin.ts" --version); then
  echo "Cannot determine the version of DSH_ROOT; expected one of: $supported." >&2
  exit 1
fi
if ! supported_version "$version"; then
  echo "DSH_ROOT is $version; expected one of: $supported." >&2
  exit 1
fi
exec node --import "$tsx" "$DSH_ROOT/apps/cli/src/bin.ts" "$@"
