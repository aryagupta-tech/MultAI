#!/usr/bin/env python3
"""Print only expired, exactly scoped MultAI backup object keys from S3 JSON."""
import datetime
import json
import re
import sys

if len(sys.argv) != 3:
    raise SystemExit('A resource prefix and daily/weekly kind are required.')
prefix, kind = sys.argv[1:]
if not re.fullmatch(r'multai-backups/[a-z0-9][a-z0-9-]{2,40}/', prefix) or kind not in ['daily','weekly']:
    raise SystemExit('Invalid backup retention scope.')
listing = json.load(sys.stdin)
if listing.get('IsTruncated'):
    raise SystemExit('Retention listing exceeded its bound; review before deleting anything.')
today = datetime.datetime.now(datetime.timezone.utc).date()
cutoff = today - datetime.timedelta(days=6 if kind == 'daily' else 27)
pattern = re.compile(re.escape(prefix + kind + '/') + (r'(\d{4}-\d{2}-\d{2})' if kind == 'daily' else r'(\d{4})-W(\d{2})') + r'\.dump\.age(?:\.sha256)?$')
expired = []
for entry in listing.get('Contents', []):
    key = entry.get('Key', '')
    match = pattern.fullmatch(key)
    if not match:
        continue
    try:
        date = datetime.date.fromisoformat(match[1]) if kind == 'daily' else datetime.date.fromisocalendar(int(match[1]), int(match[2]), 7)
    except ValueError:
        continue
    if date < cutoff:
        expired.append(key)
for key in sorted(expired):
    print(key)
