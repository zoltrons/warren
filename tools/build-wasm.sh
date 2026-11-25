#!/usr/bin/env bash
# Builds crates/core-wasm -> dist/wasm/{core_wasm.js,core_wasm_bg.wasm}
# and crates/autofill-core -> dist/wasm/{autofill_core.js,autofill_core_bg.wasm}.
#   tools/build-wasm.sh [--features register] [--simd]
# Needs: rustup target wasm32-unknown-unknown, wasm-bindgen-cli (exact version from upstream.lock),
# wasm-opt (binaryen). Override binaries with WASM_BINDGEN / WASM_OPT.
set -euo pipefail
cd "$(dirname "$0")/.."
ARGS="$*"
FEATURES=""
OUT="dist/wasm"
RUSTFLAGS_EXTRA=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --features) FEATURES="--features $2"; shift ;;
    --simd) RUSTFLAGS_EXTRA="-C target-feature=+simd128" ;;
    --out) OUT="$2"; shift ;;
  esac
  shift
done

# Nothing to do when $OUT holds a build of the same sources (every file the build reads, the pins included) and
# flags: CI restores one from its cache, and a local run after a TypeScript-only change reuses the last. Outside a git
# checkout the sources cannot be listed, so it always builds. Keep the file list equal to ci.yml's wasm cache key.
STAMP="$OUT/inputs.sha256"
stamp=""
if git rev-parse --git-dir >/dev/null 2>&1; then
  stamp=$({ echo "$ARGS"; git ls-files -z -co --exclude-standard -- crates Cargo.toml Cargo.lock rust-toolchain.toml upstream.lock .cargo/config.toml tools/build-wasm.sh package-lock.json | xargs -0 shasum -a 256 2>/dev/null || true; } | shasum -a 256 | cut -d' ' -f1)
fi
if [[ -n "$stamp" && -f "$STAMP" && "$(cat "$STAMP")" == "$stamp" && -f "$OUT/core_wasm_bg.wasm" && -f "$OUT/autofill_core_bg.wasm" ]]; then
  echo "$OUT is up to date"
  exit 0
fi
rm -f "$STAMP"

# A Homebrew cargo/rustc earlier on PATH has no wasm target: use the rustup toolchain rust-toolchain.toml names.
if command -v rustup >/dev/null; then PATH="$(dirname "$(rustup which cargo)"):${CARGO_HOME:-$HOME/.cargo}/bin:$PATH"; fi

WASM_BINDGEN="${WASM_BINDGEN:-wasm-bindgen}"
WASM_OPT="${WASM_OPT:-wasm-opt}"
want=$(sed -n 's/^wasm-bindgen = "\(.*\)".*/\1/p' upstream.lock)
have=$("$WASM_BINDGEN" --version | awk '{print $2}')
[[ "$want" == "$have" ]] || { echo "wasm-bindgen-cli $have != $want (upstream.lock)" >&2; exit 1; }

# Keep the cfg from .cargo/config.toml when adding flags. The remap keeps local paths (the user name) out of
# panic messages in the shipped wasm.
BASE_RUSTFLAGS="--cfg getrandom_backend=\"wasm_js\" --remap-path-prefix=$HOME=~"
RUSTFLAGS="$BASE_RUSTFLAGS $RUSTFLAGS_EXTRA" \
  cargo build --locked --release --target wasm32-unknown-unknown -p warren-core-wasm $FEATURES

mkdir -p "$OUT"
"$WASM_BINDGEN" target/wasm32-unknown-unknown/release/warren_core_wasm.wasm \
  --target web --out-dir "$OUT" --out-name core_wasm
"$WASM_OPT" -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
  --enable-mutable-globals ${RUSTFLAGS_EXTRA:+--enable-simd} \
  "$OUT/core_wasm_bg.wasm" -o "$OUT/core_wasm_bg.wasm"

# The autofill engine: separate from the module that holds the keys. No features and no SIMD to gain.
RUSTFLAGS="$BASE_RUSTFLAGS" cargo build --locked --release --target wasm32-unknown-unknown -p autofill-core
"$WASM_BINDGEN" target/wasm32-unknown-unknown/release/autofill_core.wasm \
  --target web --out-dir "$OUT" --out-name autofill_core
"$WASM_OPT" -Oz --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
  --enable-mutable-globals "$OUT/autofill_core_bg.wasm" -o "$OUT/autofill_core_bg.wasm"
[[ -z "$stamp" ]] || echo "$stamp" > "$STAMP"
ls -l "$OUT"
