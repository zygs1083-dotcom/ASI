#!/usr/bin/env python3
"""Measure a synthetic source title; never record title content."""
import json
import queue
import subprocess
import sys
import threading
import time
def rss(pid):
    try:
        value = subprocess.check_output(
            ["ps", "-o", "rss=", "-p", str(pid)], text=True, stderr=subprocess.DEVNULL
        ).strip()
        return int(value) * 1024
    except (subprocess.CalledProcessError, ValueError):
        return None
def measure(binary, length):
    proc = subprocess.Popen(
        [binary, f"--title-len={length}"], stdin=subprocess.PIPE,
        stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1
    )
    events = queue.Queue()
    stop = threading.Event()
    samples = []

    def read_events():
        for line in proc.stdout:
            events.put(json.loads(line))

    def sample():
        while not stop.wait(0.005):
            value = rss(proc.pid)
            if value is not None:
                samples.append(value)

    def wait_for(kind, timeout=10):
        deadline = time.monotonic() + timeout
        while True:
            event = events.get(timeout=max(0, deadline - time.monotonic()))
            if event["type"] == kind:
                return event

    def send(cmd):
        proc.stdin.write(json.dumps(cmd) + "\n")
        proc.stdin.flush()

    reader = threading.Thread(target=read_events, daemon=True)
    reader.start()
    sampler = None
    try:
        initial = wait_for("window.focused")
        assert "title" not in initial
        baseline = rss(proc.pid)
        assert baseline is not None
        samples.append(baseline)
        sampler = threading.Thread(target=sample, daemon=True)
        sampler.start()
        send({"cmd": "titles", "enabled": True, "id": "budget"})
        ack = wait_for("titles.ack")
        assert ack["enabled"] and ack["id"] == "budget"
        assert "title" in wait_for("window.title")
        send({"cmd": "snapshot"})
        time.sleep(0.05)
        start = time.monotonic()
        send({"cmd": "quit"})
        assert proc.wait(timeout=1) == 0
        elapsed_ms = (time.monotonic() - start) * 1000
        return baseline, max(samples), elapsed_ms
    finally:
        stop.set()
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=1)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait()
        if sampler:
            sampler.join()
        reader.join(timeout=1)
if __name__ == "__main__":
    small = measure(sys.argv[1], 64)
    large = measure(sys.argv[1], 50 * 1024 * 1024)
    source_increment = max(0, large[0] - small[0])
    processing_increment = max(0, large[1] - large[0])
    print(f"source_rss_increment={source_increment} bytes, "
          f"processing_peak_increment={processing_increment} bytes, "
          f"quit={large[2]:.1f} ms")
    assert source_increment <= 128 * 1024 * 1024
    assert processing_increment <= 16 * 1024 * 1024
    assert large[2] <= 200
    print("PASS")
