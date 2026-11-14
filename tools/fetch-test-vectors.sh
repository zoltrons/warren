#!/usr/bin/env bash
# Downloads sdk-internal test-vectors/ at the rev pinned in upstream.lock into target/test-vectors
# (gitignored; upstream data is not copied into this repo). Then:
#   WARREN_TEST_VECTORS=target/test-vectors cargo test -p warren-core-wasm
set -euo pipefail
cd "$(dirname "$0")/.."
rev=$(awk '/^\[sdk-internal\]/{s=1} s&&/^rev/{gsub(/"/,"",$3); print $3; exit}' upstream.lock)
out=target/test-vectors
# Done once per rev: a cache (CI's rust-cache restores target/) may hold an older rev or an emptied folder.
if [[ "$(cat "$out/.rev" 2>/dev/null)" == "$rev" ]] && compgen -G "$out/users/*.json" >/dev/null; then
  echo "test vectors @ $rev already in $out"
  exit 0
fi
rm -rf "$out" && mkdir -p "$out"
gh api "repos/bitwarden/sdk-internal/tarball/$rev" > target/sdk-internal.tar.gz
# GNU tar (CI) needs --wildcards for the pattern; macOS bsdtar matches patterns by default and rejects the flag.
wild=$([[ "$(tar --version)" == *GNU* ]] && echo --wildcards || true)
tar -xzf target/sdk-internal.tar.gz -C "$out" --strip-components=2 $wild '*/test-vectors/*'
rm target/sdk-internal.tar.gz
echo "$rev" > "$out/.rev"
echo "test vectors @ $rev -> $out"; ls "$out"
