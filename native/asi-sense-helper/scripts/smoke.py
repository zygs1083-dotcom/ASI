#!/usr/bin/env python3
"""Real-machine smoke: spawns the release binary, opens TextEdit/Finder at
staged intervals, exercises snapshot + titles:false, quits. Prints only redacted
events ('title' -> '<redacted>'); raw output is never written to disk."""
import json
import subprocess
import sys
import threading
import time

OPEN_TARGETS = ["TextEdit", "Finder", "TextEdit", "Finder"]


def redact(value):
    if isinstance(value, dict):
        return {k: "<redacted>" if k == "title" else redact(v) for k, v in value.items()}
    if isinstance(value, list):
        return [redact(v) for v in value]
    return value


def has_title_key(value):
    if isinstance(value, dict):
        return any(k == "title" or has_title_key(v) for k, v in value.items())
    if isinstance(value, list):
        return any(has_title_key(v) for v in value)
    return False


def main():
    binary = sys.argv[1]
    proc = subprocess.Popen([binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, text=True, bufsize=1)
    events = []
    bad_lines = []

    def reader():
        for line in proc.stdout:
            try:
                events.append(json.loads(line))
            except ValueError:
                bad_lines.append("<unparsed line suppressed>")

    reader_thread = threading.Thread(target=reader, daemon=True)
    reader_thread.start()

    def send(obj):
        proc.stdin.write(json.dumps(obj) + "\n")
        proc.stdin.flush()

    open_failures = []
    def open_app(name):
        if subprocess.run(["open", "-a", name], capture_output=True).returncode != 0:
            open_failures.append(name)

    try:
        start = time.monotonic()
        schedule = [(2 + 4 * i, name, "open") for i, name in enumerate(OPEN_TARGETS)]
        schedule += [(15, {"cmd": "snapshot"}, "send"),
                     (16, {"cmd": "titles", "enabled": False}, "send"),
                     (17, {"cmd": "snapshot"}, "send"),
                     (20, {"cmd": "quit"}, "send")]
        for when, payload, kind in schedule:
            time.sleep(max(0, when - (time.monotonic() - start)))
            open_app(payload) if kind == "open" else send(payload)
        rc = proc.wait(timeout=10)
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
    reader_thread.join(timeout=5)
    counts = {}
    for e in events:
        counts[e.get("type")] = counts.get(e.get("type"), 0) + 1
    ax_perm = next((e.get("permissions", {}).get("accessibility") for e in events
                    if e.get("type") == "hello"), "unknown")
    unsupported = [e for e in events if e.get("type") == "ax.unsupported"]
    snapshots = [e for e in events if e.get("type") == "snapshot"]
    window_events = sum(v for k, v in counts.items() if str(k).startswith("window."))
    last_fw = (snapshots[-1].get("focusedWindow") or {}) if snapshots else {}

    failures = list(open_failures and [f"open -a failed: {', '.join(open_failures)}"] or [])
    if bad_lines:
        failures.append(f"{len(bad_lines)} unparsed output lines")
    bad_env = any(e.get("v") != 1 or not isinstance(e.get("type"), str)
                  or not isinstance(e.get("at"), int) for e in events)
    if bad_env or not events or events[0].get("type") != "hello":
        failures.append("bad envelope or first event is not hello")
    if len(events) < 2 or events[1].get("type") != "thermal":
        failures.append("second event is not thermal")
    if counts.get("app.activated", 0) < 2:
        failures.append(f"expected >=2 app.activated, got {counts.get('app.activated', 0)}")
    if len(snapshots) < 2 or has_title_key(snapshots[-1]):
        failures.append("missing snapshot or title key leaked post-privacy")
    if ax_perm == "denied":
        if window_events:
            failures.append(f"{window_events} window events emitted while accessibility denied")
        if last_fw and last_fw.get("status") != "denied":
            failures.append("denied host: final focusedWindow.status != denied")
    if rc != 0:
        failures.append(f"helper exit code {rc}")
    print(f"opened apps: {', '.join(OPEN_TARGETS)}; accessibility: {ax_perm}")
    if ax_perm == "denied":
        print("denied host: window events expected = 0, observed = "
              f"{window_events}; degradation snapshot = "
              f"{json.dumps(redact(snapshots[-1]), sort_keys=True) if snapshots else 'none'}")
    else:
        print("note: accessibility granted - denied degradation not exercised on this host")
    print(f"event counts: {json.dumps(counts, sort_keys=True)}")
    for u in unsupported:
        print(f"ax.unsupported: bundleId={u.get('bundleId')} "
              f"notification={u.get('notification')} error={u.get('error')}")
    if not unsupported:
        print("ax.unsupported: none")
    print("sample events (redacted):")
    for e in events[:2] + events[-4:]:
        print("  " + json.dumps(redact(e), sort_keys=True))
    print(("FAIL: " + "; ".join(failures)) if failures else "PASS")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
