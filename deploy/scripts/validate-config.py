#!/usr/bin/env python3
"""Read-only deployment preflight. Never evaluates shell or creates cloud resources."""
import re
import stat
import sys
from pathlib import Path

def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)

if len(sys.argv) != 2:
    fail('Usage: python3 deploy/scripts/validate-config.py deploy/.env')
values = {}
for line in Path(sys.argv[1]).read_text().splitlines():
    line = line.strip()
    if not line or line.startswith('#'):
        continue
    if '=' not in line:
        fail('Invalid deployment configuration line.')
    name, value = line.split('=', 1)
    if name in values or not re.fullmatch(r'[A-Z_]+', name):
        fail('Duplicate or invalid deployment field.')
    if not value or '<' in value or '>' in value or '\x00' in value:
        fail('Replace all deployment placeholders before validation.')
    values[name] = value
required = ['RESOURCE_ID','COLLABORATION_DOMAIN','ACME_EMAIL','SECRETS_DIRECTORY','BACKEND_IMAGE','PROXY_IMAGE','DATABASE_IMAGE','SOURCE_COMMIT','SOURCE_DIRTY','AWS_REGION']
if any(name not in values for name in required):
    fail('Required deployment fields are missing.')
if not re.fullmatch(r'[a-z0-9][a-z0-9-]{2,40}', values['RESOURCE_ID']):
    fail('Use a fresh lowercase resource identifier, 3 to 41 characters.')
domain = values['COLLABORATION_DOMAIN']
if not re.fullmatch(r'(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}', domain) or domain.endswith(('.invalid','.example')) or domain == 'example.com':
    fail('Use the new owner-controlled DNS hostname.')
if not re.fullmatch(r'[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+', values['ACME_EMAIL']) or values['ACME_EMAIL'].endswith('@example.com'):
    fail('Use an owner-selected certificate contact address.')
if not re.fullmatch(r'[a-f0-9]{40}', values['SOURCE_COMMIT']) or values['SOURCE_DIRTY'] != 'false':
    fail('Deployment requires a reviewed clean source commit.')
for name in ['BACKEND_IMAGE','PROXY_IMAGE','DATABASE_IMAGE']:
    if not re.fullmatch(r'[a-z0-9][a-z0-9./_-]*:' + values['SOURCE_COMMIT'], values[name]):
        fail('Container tags must identify the reviewed full source commit.')
if values['AWS_REGION'] != 'ap-south-1':
    fail('This reviewed cost plan selects ap-south-1; review region changes separately.')
directory = Path(values['SECRETS_DIRECTORY'])
if not directory.is_absolute() or directory.is_symlink() or not directory.is_dir() or stat.S_IMODE(directory.stat().st_mode) & 0o077:
    fail('Secret mounts require an existing private 0700 host directory.')
for name in ['db-admin-password','db-app-password','google-client-id','google-client-secret']:
    file = directory / name
    if file.is_symlink() or not file.is_file() or file.stat().st_size > 4096 or stat.S_IMODE(file.stat().st_mode) & 0o022:
        fail('A deployment secret is missing, oversized or writable by another account.')
    value = file.read_text().strip()
    if not value or '<' in value or any(ord(character) < 32 for character in value):
        fail('A deployment secret is empty or invalid.')
    if name.startswith('db-') and not re.fullmatch(r'[a-f0-9]{64}', value):
        fail('Database passwords must be independent 32-byte generated hex secrets.')
print('Local configuration preflight passed. This does not provision resources, verify DNS/TLS/OAuth, or approve costs.')
