#!/usr/bin/env bash
# Tags a release once ci is green on it: bash tools/release.sh X.Y.Z
# Expects the `Version X.Y.Z` commit (docs/AGENT_MAP.md section 6) pushed to main. Waits for that commit's ci run,
# then makes the signed, annotated tag whose message is the version's CHANGELOG section, checks it with
# verify-tag.sh and pushes it; the release workflow takes over from the tag.
set -euo pipefail
cd "$(dirname "$0")/.."
v="${1:?usage: tools/release.sh X.Y.Z}"
tag="v$v"
sha=$(git rev-parse HEAD)

test "$(git branch --show-current)" = main || { echo "not on main" >&2; exit 1; }
git fetch -q origin main
test "$(git rev-parse origin/main)" = "$sha" || { echo "HEAD is not origin/main: push first" >&2; exit 1; }
test "$(node -p "require('./src/manifest.json').version")" = "$v" || { echo "src/manifest.json is not at $v" >&2; exit 1; }
! git rev-parse -q --verify "refs/tags/$tag" >/dev/null || { echo "$tag exists" >&2; exit 1; }

notes=$(mktemp)
trap 'rm -f "$notes"' EXIT
# The section under "## X.Y.Z — date", without its heading, up to the next version.
awk -v v="$v" '$0 ~ "^## "v" " {f=1; next} /^## / {f=0} f' CHANGELOG.md | sed '1{/^$/d;}' > "$notes"
test -s "$notes" || { echo "CHANGELOG.md has no section for $v" >&2; exit 1; }

echo "waiting for ci on ${sha:0:7}…"
for _ in $(seq 60); do
  run=$(gh run list --workflow ci.yml --commit "$sha" --event push --json databaseId --jq '.[0].databaseId // empty')
  [[ -n "$run" ]] && break
  sleep 5
done
[[ -n "${run:-}" ]] || { echo "no ci run for $sha" >&2; exit 1; }
gh run watch "$run" --exit-status --interval 30 >/dev/null || { echo "ci failed: gh run view $run --log-failed" >&2; exit 1; }

git tag -s "$tag" --cleanup=verbatim -F "$notes"
bash tools/verify-tag.sh "$tag"
git push origin "$tag"
echo "$tag pushed; release workflow: gh run list --workflow release.yml -L 1"
