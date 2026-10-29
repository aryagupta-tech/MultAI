#!/usr/bin/env python3
"""Copy a bounded binary stream without materializing a plaintext dump on disk."""
import sys

if len(sys.argv) != 2 or not sys.argv[1].isdigit():
    raise SystemExit('A positive byte limit is required.')
limit = int(sys.argv[1])
if limit < 1 or limit > 268435456:
    raise SystemExit('Backup streams are limited to 256 MiB in this cost plan.')
total = 0
try:
    while True:
        chunk = sys.stdin.buffer.read(65536)
        if not chunk:
            break
        total += len(chunk)
        if total > limit:
            raise SystemExit('Backup exceeds the reviewed size budget; no upload is permitted.')
        sys.stdout.buffer.write(chunk)
except BrokenPipeError:
    raise SystemExit(1)
