#!/bin/bash
# Detached launcher for the asi-dev spike runtime. Survives the calling shell
# (nohup + disown), logs to logs/asi-dev-web.log, records the node PID in
# logs/asi-dev-web.pid. Run from spikes/p0. Uses the supported `pnpm dsh`
# launcher from the fixed DSH checkout at /Users/wangying/orca/dsh.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs
DSH=/Users/wangying/orca/dsh
export DSH_HOME="$PWD/tmp/dsh-home"
export ASI_MAGPIE_PLACEHOLDER=magpie
if lsof -nP -iTCP:3186 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "port 3186 already in use; refusing to start" >&2
  exit 1
fi
nohup bash -c 'cd "'"$DSH"'" && exec pnpm dsh --profile asi-dev --no-open --host 127.0.0.1 --port 3186' \
  </dev/null >> logs/asi-dev-web.log 2>&1 &
disown
sleep 10
PID=$(lsof -nP -tiTCP:3186 -sTCP:LISTEN | head -1)
echo "${PID:-}" > logs/asi-dev-web.pid
tail -5 logs/asi-dev-web.log
[ -n "${PID:-}" ] && echo "server pid: ${PID} (logs/asi-dev-web.pid)"
