#!/usr/bin/env python3
"""Kernel fence; execute protected submissions before releasing after owner EOF."""
import fcntl
import json
import os
import select
import signal
import subprocess
import sys
import time

path, timeout = sys.argv[1], float(sys.argv[2]) / 1000
fd = os.open(path, os.O_CREAT | os.O_RDWR, 0o600)
deadline = time.monotonic() + timeout
while True:
    if select.select([sys.stdin], [], [], 0)[0] and not os.read(0, 1):
        sys.exit(76)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        break
    except BlockingIOError:
        if time.monotonic() >= deadline:
            sys.exit(75)
        time.sleep(0.01)
print("locked", flush=True)
for line in sys.stdin:
    request = json.loads(line)
    argv, limit = request["argv"], min(30, max(0.01, request["timeoutMs"] / 1000))
    # The helper retains the lock even if Bun dies after submission starts.
    # Output is intentionally discarded: diagnostics must not capture secrets.
    child = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, pass_fds=(fd,))
    try:
        code = child.wait(timeout=limit)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
        code = 124
    print(json.dumps({"code": code}), flush=True)
os.close(fd)
