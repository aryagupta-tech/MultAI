#!/bin/sh
# Creates the private release signing key for the MultAI Companion APK, outside the repository.
# Keep a backup of this folder: Android only installs updates signed with the same key.
set -eu
dir="${MULTAI_ANDROID_KEY_DIR:-$HOME/.multai/android}"
store="$dir/multai-companion-release.p12"
props="$dir/keystore.properties"
if [ -e "$store" ] || [ -e "$props" ]; then echo "A signing key already exists in $dir; refusing to replace it." >&2; exit 1; fi
umask 077
mkdir -p "$dir"
chmod 700 "$dir"
password="$(openssl rand -base64 33 | tr -d '/+=\n' | cut -c1-40)"
keytool -genkeypair -storetype PKCS12 -keystore "$store" -storepass "$password" -keypass "$password" \
  -alias multai-companion -keyalg RSA -keysize 4096 -validity 10000 -sigalg SHA256withRSA \
  -dname "CN=MultAI Companion, O=MultAI, C=SI" >/dev/null 2>&1
printf 'storeFile=%s\nstorePassword=%s\nkeyAlias=multai-companion\nkeyPassword=%s\n' "$store" "$password" "$password" > "$props"
chmod 600 "$store" "$props"
echo "Created $store (private, mode 600). Passwords are in $props."
keytool -list -v -keystore "$store" -storepass "$password" -alias multai-companion 2>/dev/null | grep -E 'SHA256:' | sed 's/^[[:space:]]*/Signing certificate /'
