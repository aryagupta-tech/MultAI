#!/usr/bin/env bash
# Local artifact preparation only. No push, account login or cloud provisioning.
set -euo pipefail
if [[ $# -ne 1 || ! "$1" =~ ^[a-f0-9]{40}$ ]]; then
  echo 'Usage: bash deploy/scripts/build-images.sh full-reviewed-source-commit' >&2
  exit 1
fi
script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd -- "$script_dir/../.." && pwd)"
commit="$1"
if [[ "$(git -C "$root" rev-parse HEAD)" != "$commit" || -n "$(git -C "$root" status --porcelain --untracked-files=normal)" ]]; then
  echo 'Build the reviewed commit from a clean checkout; this script never switches or changes Git state.' >&2
  exit 1
fi
docker buildx build --platform linux/amd64 --load -f "$root/deploy/backend.Dockerfile" --build-arg "SOURCE_COMMIT=$commit" --build-arg SOURCE_DIRTY=false -t "multai-backend:$commit" "$root"
docker buildx build --platform linux/amd64 --load -f "$root/deploy/database.Dockerfile" -t "multai-database:$commit" "$root"
docker buildx build --platform linux/amd64 --load -f "$root/deploy/proxy.Dockerfile" -t "multai-proxy:$commit" "$root"
echo 'Local Linux/amd64 images built. Nothing was pushed or deployed.'
