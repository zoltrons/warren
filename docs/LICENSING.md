# Licensing

## Decision

Warren is licensed **GPL-3.0-only**: full text in `LICENSE`, third-party notices in `NOTICE`. The build copies both
into `dist/ext`, so every `.zip` and `.crx` carries them.

| Upstream | License | How we use it |
|---|---|---|
| bitwarden/sdk-internal (`bitwarden-crypto`) | GPL-3.0-only OR Bitwarden SDK License | Cargo **git dependency pinned to a rev**; we take it under the **GPL-3.0-only** option. Not vendored. |
| bitwarden/sdk-internal `test-vectors/` | same | Downloaded at test time by `tools/fetch-test-vectors.sh` into `target/` (gitignored). Not committed. |
| bitwarden/clients | GPL-3.0-only | Read as reference only. No source copied. |
| publicsuffix/list | MPL-2.0 | Data file fetched at build time (`tools/fetch-psl.mjs`, pinned in `upstream.lock`) and shipped as `psl.json`. MPL-2.0 is GPL-compatible; ship its notice with releases. |
| dani-garcia/vaultwarden | AGPL-3.0-only | Protocol reference and a test server in Docker. No code linked or copied. |
| google/material-design-icons (`round` theme, the "Material Rounded" glyphs) | Apache-2.0 | SVG path data vendored in `src/ui/icons.ts` (43 glyphs, unmodified paths). Apache-2.0 is one-way compatible with GPL-3.0: the combined work ships under GPL-3.0 and the Apache notice is kept with the release. |

Why GPL-3.0-only and not the Bitwarden SDK License: the SDK License only allows use in a
"Compatible Application" for Bitwarden's own services; Warren targets self-hosted Vaultwarden,
so relying on it would be at best ambiguous. The GPL option has no such restriction, and
GPL-3.0-only is compatible with bitwarden/clients.

Consequence: the distributed extension (including the WASM built from `bitwarden-crypto`) must ship
with GPL-3.0 terms and corresponding source (this repository at the released tag + `upstream.lock`).

Other password managers, open or source-available, are idea and UX references only. Some are "all rights
reserved": a feature may work the way theirs does, but no code, text, icons or other assets are taken from them.
No license choice here could make copying from such a project allowed.

## Rules

* Do not copy upstream source into this repo without asking first; prefer pinned dependencies.
* Never copy from a project whose license is not GPL-3.0-compatible; describe the behaviour and write it anew.
* Local modules that re-implement upstream behaviour (`cipher.rs`, `totp.rs`, `generator.rs`) are
  written from scratch against the behaviour and test vectors; `upstream-map.yaml` records what they track.
* Never enable sdk-internal's `bitwarden-license` feature or any `bitwarden_license/` crate.
* Icon path data comes from the upstream Apache-2.0 Material icons package, not from a
  redistributor's proprietary bundle; `src/ui/icons.ts` keeps the upstream icon name for each glyph.
