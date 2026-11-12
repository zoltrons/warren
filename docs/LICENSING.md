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
| faker-js/faker | MIT | Dev dependency only. `tools/identity-data.mjs` picks name and city lists from its locale data into `src/ui/identity-data.json` (committed, shipped); the MIT notice is in `NOTICE`. No faker code ships. |
| danielmiessler/SecLists | MIT | `tools/common-words.mjs` turns `10k-most-common.txt` (pinned commit) into the base-word list `src/shared/common-words.json` (committed, shipped) for the strength check; the MIT notice is in `NOTICE`. |
| 2factorauth/twofactorauth | MIT | `tools/totp-sites.mjs` reads the domains that offer TOTP from the 2fa.directory API (snapshot 2026-11-12) into `src/shared/totp-sites.json` (committed, shipped) for the security report; the extension never contacts that service. The MIT notice is in `NOTICE`. |
| dani-garcia/vaultwarden | AGPL-3.0-only | Protocol reference and a test server in Docker. No code linked or copied. |
| lucide-icons/lucide (`lucide-static` 1.68.0) | ISC (Feather-derived icons: MIT) | SVG path data vendored in `src/ui/icons.ts` (55 glyphs; `<circle>`, `<line>` and `<rect>` rewritten as equivalent paths, shapes unchanged). ISC and MIT are GPL-3.0-compatible; both notices are in `NOTICE`. |

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
* Icon path data comes from the upstream ISC Lucide package (`lucide-static` on npm), not from a
  redistributor's bundle; `src/ui/icons.ts` keeps the upstream icon name for each glyph.
