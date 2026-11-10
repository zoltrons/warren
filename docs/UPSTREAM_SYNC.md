# Upstream sync

Status: pins, map, report tool and weekly report job exist; pin bumps come as Renovate PRs.

## Pieces

1. **`upstream.lock`** — exact sdk-internal rev, clients commit, Vaultwarden version + image digest,
   wasm-bindgen version. `crates/core-wasm/Cargo.toml` uses the same rev; CI fails if they differ.
2. **`upstream-map.yaml`** — upstream path → local module, with what to watch.
3. **`tools/sync-upstream.mjs`** — for every mapped path, `gh api repos/<repo>/compare/<pin>...main`
   filtered to that path; outputs Markdown grouped by local module. Flags: new/removed serde fields,
   changed enums (cipher types, KDF types, EncString types), new key formats (COSE, type 7+), KDF
   default changes, new required request fields (Vaultwarden `CipherData`, `ConnectData`). Read-only.
4. **`.github/workflows/upstream.yml`** — weekly, read-only: runs the report into the job summary. A bump PR runs
   `ci.yml`: test vectors + `cargo test`, the Vaultwarden contract tests on `:latest` (the only supported release)
   and the size report.
5. **Renovate** (`renovate.json`) — JS devDependencies, the last-reviewed Vaultwarden version, and the sdk-internal rev
   (regex manager over `upstream.lock` + `Cargo.toml`).

## Contract tests

* (a) `crates/core-wasm/tests/vectors.rs` against sdk-internal `test-vectors/` — implemented.
* (b) Vaultwarden end-to-end (`tests/e2e/run.ts`) plus the
  official `bw` CLI decrypting what we wrote and vice versa — to do.
