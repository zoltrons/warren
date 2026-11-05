#!/usr/bin/env bash
# Fails unless tag $1 is an annotated tag signed by a key in .github/allowed_signers (principal warren-release).
# Run by the release workflow before anything is built; run it locally before pushing a tag.
set -euo pipefail
tag="$1"
signers="${2:-.github/allowed_signers}"
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
test "$(git cat-file -t "refs/tags/$tag")" = tag || { echo "::error::$tag is not an annotated tag"; exit 1; }
git cat-file tag "refs/tags/$tag" > "$dir/tag"
# A signed tag object is the tag text, then the SSH signature block.
sed '/^-----BEGIN SSH SIGNATURE-----$/,$d' "$dir/tag" > "$dir/payload"
sed -n '/^-----BEGIN SSH SIGNATURE-----$/,$p' "$dir/tag" > "$dir/sig"
test -s "$dir/sig" || { echo "::error::$tag is not signed"; exit 1; }
ssh-keygen -Y verify -f "$signers" -I warren-release -n git -s "$dir/sig" < "$dir/payload"
