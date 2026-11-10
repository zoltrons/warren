# Agent map

The working guide for an agent (or a person) changing Warren. `CLAUDE.md` is the one-page summary that is always
loaded; this file is the long form: where each concern lives, the steps for each kind of change, and which docs,
tests and budgets a change has to update. Read the section for the area you are touching, not the whole file.

Order of precedence when two things disagree: the code, then `docs/SECURITY.md`, then this file. If this file is
wrong, fix it in the same change (see [Keeping this map true](#keeping-this-map-true)).

## 1. Orientation in 60 seconds

| Question | Answer |
|---|---|
| What is it? | MV3 extension (Chromium 156+), a Bitwarden-protocol client for self-hosted Vaultwarden (latest release only). |
| Languages | TypeScript (no framework, esbuild) + Rust compiled to WASM (crypto core, autofill engine). |
| Where do keys live? | Only in the offscreen worker (`src/offscreen/worker.ts` → `crates/core-wasm`). Never in the service worker, the UI or `storage.*` as plaintext. |
| Where are messages defined? | `src/shared/messages.ts`: every type, its validator and its size caps. |
| Fast proof for most changes | `npm run check` (typecheck + unit tests + contrast). |
| What must never break? | The numbered invariants in `docs/SECURITY.md`, the size budget, Vaultwarden compatibility. |
| Browser | Helium, never Chrome (`~/Applications/Helium.app`). |

## 2. Where things are

### Runtime contexts (`src/`)

| Context | Entry (esbuild, `tools/build.mjs`) | Output | Format | Holds keys? | Talks to |
|---|---|---|---|---|---|
| Service worker | `src/background/index.ts` | `background.js` | esm | no | everyone; the only caller of offscreen |
| Offscreen document | `src/offscreen/offscreen.ts` | `offscreen.js` | esm | no (relay) | its worker |
| Crypto worker | `src/offscreen/worker.ts` | `worker.js` | esm | **yes** | `core-wasm` |
| Popup / side panel | `src/ui/popup.ts` | `popup.js`, `popup.css` | esm | no | background via `send()` |
| Inline menu frame | `src/ui/menu.ts` | `menu.js` | esm | no | background (`FrameRequest`) |
| Save bar frame | `src/ui/bar.ts` | `bar.js` | esm | no | background (`FrameRequest`) |
| Page collector/filler (isolated world) | `src/autofill/page.ts` | `page.js` | iife | no | injected by `chrome.scripting` |
| Content script | `src/autofill/content.ts` | `content.js` | iife | no | background (`PageRequest`) |
| Passkey hooks | `src/autofill/passkey-page.ts` (main world), `passkey-relay.ts` | `passkey-*.js` | iife | no | background (passkey port) |
| SSO callback | `src/autofill/sso-callback.ts` | `sso-callback.js` | iife | no | background |

A new bundle has to be added in two places: the `entryPoints` in `tools/build.mjs` and a budget in
`tools/size-budget.json` (`npm run size` checks every file listed there). Every shipped code or data file over 8 KiB has a budget
(LICENSE and NOTICE excepted).
Budgets catch accidents (a stray dependency, a module bundled twice, data inlined by mistake), not normal feature
growth: each is about twice the size at 0.0.14, so features fit without touching them. Released zip at 0.0.14:
686 KiB; for scale, Chrome Web Store listings in 2026 show Proton Pass at 7.7 MiB and Bitwarden at 15.9 MiB. Ceilings
by role, tightest where a cost is paid most often:

| Role | Files and ceilings | Why |
|---|---|---|
| Injected into every page | `page.js` 32, `content.js` 32 KiB | Parsed in every tab on every load. |
| Small page scripts | `passkey-page.js` 16, `passkey-relay.js` 8, `sso-callback.js` 8 KiB | Same, and they do one thing. |
| In-page frames | `menu.js` 48, `bar.js` 32 KiB | Open on field focus or after a login; must feel instant. |
| Popup | `popup.js` 256, `popup.css` 96 KiB | Also guarded by the e2e step "popup first render < 100 ms". |
| Service worker | `background.js` 192 KiB | Restarts often (MV3). |
| Offscreen | `offscreen.js` 32, `worker.js` 128 KiB | Loaded when the offscreen document starts. |
| WASM | `core_wasm_bg.wasm` 1.5 MiB, `autofill_core_bg.wasm` 512 KiB (their JS glue is bundled into `worker.js` / `background.js`) | Instantiated once; grows with sdk-internal. |
| Data | `psl.json` 256, `common-words.json` 160, `identity-data.json` 96, `messages.json` 96 KiB | Grow with upstream lists and strings. |

A change that goes over a ceiling raises it in the same commit and says why in the commit message. A new shipped
file over 8 KiB gets a ceiling from its role.

### Modules, by concern

| Concern | Go to | Notes |
|---|---|---|
| Message types, validation, caps | `src/shared/messages.ts`, `src/shared/validate.ts`, `src/shared/page-limits.ts` | Parse every message, never cast it (invariant 2). |
| Request routing | `src/background/index.ts` `handle()` | Vault ops go in the unlocked branch. |
| Login, 2FA, SSO, PIN/biometric unlock | `src/background/account.ts`, `kdf.ts` | Every path ends in `afterUnlock` (invariant 8b). |
| Lock, epochs, auto-lock | `src/background/lock.ts` | Lock only through `lockNow()`. |
| Sync, save, import/export, attachments, clipboard | `src/background/vault.ts` | |
| Fill from popup / shortcut / context menu, badge, toolbar icon | `src/background/autofill.ts` | `updateTabUi` for the icon and badge. |
| Inline menu and save bar logic | `src/background/inline.ts` | Frame nonces and tokens (invariant 4). |
| Autofill engine bridge (no values, no keys) | `src/background/engine.ts` → `crates/autofill-core` | The engine sees names, never values. |
| "Pick from page" | `src/background/picker.ts`, `src/autofill/picker.ts` | |
| Passkeys | `src/background/passkey.ts`, `src/offscreen/fido2.ts`, `passkey-keys.ts` | `checkRpId` (invariant 11). |
| Reprompt (master password re-ask) | `src/background/reprompt.ts` | Every secret-returning request passes `repromptPending`. |
| Push notifications, log in with device | `src/background/push.ts`, `src/transport/hub.ts` | |
| Email aliases | `src/background/alias.ts`, `src/shared/alias.ts` | |
| Typed storage | `src/background/store.ts`, `seal.ts`, `private.ts` | `storage.local` holds ciphertext only. |
| Offscreen bridge | `src/background/core.ts` (`coreCall`) | |
| HTTP, auth, server API | `src/transport/http.ts` (bounded bodies), `auth.ts`, `vault.ts`, `config.ts` | Read JSON through the `ci` helpers. |
| Decrypted vault in memory | `src/offscreen/vault.ts` | |
| Worker op switch | `src/offscreen/worker.ts` | |
| URL matching, PSL | `src/autofill/match.ts`, `src/shared/uri-tools.ts`, `url.ts` | PSL comes from `tools/fetch-psl.mjs`. |
| Field collection | `src/autofill/collector/*` | Shadow DOM, tree walker, field watcher. |
| Writing values into fields | `src/autofill/executor/fill.ts` | Re-checks origin and visibility (invariant 3). |
| Shared helpers | `src/shared/{csv,card,qr,search,strength,markdown,linked-fields,pageload,digest}.ts` | All unit-tested. |
| Constants, server-facing ids | `src/shared/constants.ts` | `CLIENT_NAME`, `DEVICE_TYPE` stay Bitwarden's. |
| UI shell, auth screens, settings | `src/ui/popup.ts` | |
| Vault list, item view, editor | `src/ui/vault.ts` | The largest file (~2400 lines): search it, do not read all of it. |
| Generator, Send, biometric setup | `src/ui/generator.ts`, `send.ts`, `biometric.ts` | |
| DOM helper, messaging, i18n | `src/ui/dom.ts` (`h`, `send`, `t`, `enter`/`leave` row motion) | No `innerHTML` (invariant 12). |
| Screen motion | `src/ui/motion.ts` (`navMotion`), `render` in `popup.ts` | View transitions; locks never animate (invariant 8b). |
| Icons | `src/ui/icons.ts` (Lucide glyphs) | |
| Theme tokens, all CSS | `src/ui/popup.css` | |
| Strings | `src/_locales/en/messages.json` | `tr` has only name, description and disclaimer. |
| Manifest, permissions, CSP | `src/manifest.json` | |

### Rust (`crates/`)

| Crate | Role | Tests |
|---|---|---|
| `core-wasm` (`warren-core-wasm`) | Crypto and vault: `api.rs` (ops), `cipher.rs`, `send.rs`, `totp.rs`, `generator.rs`; `lib.rs` is the wasm_bindgen surface. Uses `bitwarden-crypto` at the rev in `upstream.lock`. | `tests/vectors.rs` (sdk-internal test vectors) + unit tests |
| `autofill-core` | WASM surface of the engine: `analyze_page`, `plan`. | |
| `autofill-cpd` | Page details types (`CollectedPageDetails`). | yes |
| `autofill-designation` | `AutofillType`, `FormDesignation`. | yes |
| `autofill-clue` | Rules and weights that score fields. | yes |
| `autofill-resolver` | Pipeline of 8 passes (`src/pass/*`). | yes |
| `autofill-autocomplete-off` | Field groups outside or inside forms. | yes |
| `autofill-fill` | Fill plan, custom fields, card formats. | yes |
| `autofill-autosubmit` | Picks the submit button. | yes |

### Tooling, dev and tests

| Path | What |
|---|---|
| `tools/build.mjs` | Extension bundle → `dist/ext` (`--e2e` adds test hooks and grants optional permissions; `--watch`). |
| `tools/build-wasm.sh` | Both WASM modules → `dist/wasm` (`--simd`; `--features register --out dist/wasm-register` for the biometric smoke). |
| `tools/fetch-psl.mjs` | Downloads the Public Suffix List once (needed before typecheck and build). |
| `tools/fetch-test-vectors.sh` | sdk-internal test vectors → `target/test-vectors`. |
| `tools/size-report.mjs`, `size-budget.json` | Size report; fails over budget. |
| `tools/check-contrast.mjs` | WCAG contrast of every token pair, both themes. |
| `tools/smoke-fill.mjs`, `smoke-passkeys.mjs`, `smoke-biometric.mjs` | Browser smoke tests without a server (`HEADED=1` to watch). |
| `tools/mutate.mjs` | Mutation check for SECURITY.md invariants (docs/VERIFICATION.md). |
| `tools/icons.mjs` | PNG icons from `brand/*.svg`. |
| `tools/identity-data.mjs` | Builds `src/ui/identity-data.json` for the identity generator. |
| `tools/common-words.mjs` | Builds `src/shared/common-words.json` (base words of the 10 000 most common passwords) for the strength check. |
| `tools/sync-upstream.mjs` | Read-only diff report of upstream since the pins. |
| `tools/pack-crx.mjs`, `verify-tag.sh` | Release signing and tag verification. |
| `dev/vaultwarden/` | Local Vaultwarden (latest) + mock IdP + test users, for e2e. |
| `dev/preview/` | Renders popup/menu/bar against a stubbed worker (`stub.ts`) for screenshots and UI audits. |
| `tests/e2e/run.ts` | The e2e suite against Vaultwarden: one file of ~100 `await step("…", …)` blocks, run in order. |
| `src/**/*.test.ts` | Unit tests (`node --test`, type stripping, no `@types/node`). They sit next to the module they test. |

## 3. How to make a change

### 3.1 Loop for every change

1. **Find it.** Use the tables above, then `grep`. Read the function and its callers, not the whole file.
2. **Check the invariants.** If the change touches messages, storage, fill, frames, KDF, passkeys, lock, clipboard
   or URLs, read the matching invariant in `docs/SECURITY.md` first.
3. **Change it** in the layer that owns the concern (section 2). Do not copy a guard into a second place.
4. **Test it.** Add or extend a `*.test.ts` next to the module (or a Rust `#[test]`). A new security check also gets a
   mutant in `tools/mutate.mjs`.
5. **Prove it** with the smallest sufficient run (section 4).
6. **Reflect it** in the docs (section 5) and in `CHANGELOG.md` if a user would notice.
7. **Commit** in the house style (section 6).

### 3.2 Recipes

**New UI → background request**
1. Add the variant to `Request` and a validator to `requestValidators` in `src/shared/messages.ts`, with caps for any
   free-form or page-controlled field.
2. Add a `case` in `handle()` in `src/background/index.ts`. Vault operations go in the unlocked branch.
3. Call it with `send({ type: … })` from `src/ui/*`.
4. If it returns item secrets, it must pass `repromptPending` (`src/background/reprompt.ts`).
5. Add a test in `src/shared/messages.test.ts` (accepted and rejected shapes).
6. If the popup calls it on a screen that `dev/preview` renders, add a `case` to `dev/preview/stub.ts`.

**New crypto or vault operation**
1. Add the variant to `CoreRequest` and `coreValidators` (`src/shared/messages.ts`).
2. Add a `case` in `src/offscreen/worker.ts`.
3. Write the function in `crates/core-wasm/src/api.rs` and export it in `lib.rs`.
4. Call it from the service worker through `coreCall` (`src/background/core.ts`).
5. `npm run build:wasm`, then `cargo test -p warren-core-wasm` with the test vectors, then `npm run size`.
6. A check that needs no secrets uses `cipherSummary`, not `getCipher`.

**New page ↔ extension message**
`PageRequest` (content script) or `FrameRequest` (menu/bar frames) in `messages.ts`, handled in
`src/background/inline.ts`. Origin, URL, tab and frame come from `sender`, never from the payload (invariant 1).
Frame requests carry the nonce or token (invariant 4).

**Autofill detection change**
1. Rules and weights: `crates/autofill-clue`; pass order and decisions: `crates/autofill-resolver/src/pass/*`; the fill
   plan: `crates/autofill-fill`.
2. `cargo test -p autofill-…` for the crates you touched (the full list is in the CLAUDE.md commands table).
3. `npm run build:wasm && npm run build && npm run test:fill`. Add a fixture page to `tools/smoke-fill.mjs` for the
   site shape you fixed.
4. The engine never receives a value or a key. Page details are capped in `parsePageDetails`.

**UI change**
1. Build DOM with `h()` from `src/ui/dom.ts`; text goes in as text (invariant 12).
2. Strings: add a key to `src/_locales/en/messages.json` and use `t("key")`. Do not add keys to `tr`.
3. Colors: add or reuse a token in `src/ui/popup.css`, in the light block and in **both** dark blocks, then
   `npm run check` (contrast).
4. Icons: add a Lucide glyph to `src/ui/icons.ts` (ISC; keep the credit in NOTICE).
5. Look at it: `node dev/preview/build.mjs && node dev/preview/shot.mjs` (stubbed, no server), or load `dist/ext` in
   Helium.
6. If the screenshots in `docs/screenshots/` show the changed screen, regenerate them.

**New permission**
Add it to `src/manifest.json` and write the reason in `docs/SECURITY.md` (with the invariant it touches). If it is
optional, `--e2e` builds grant it: check that the e2e suite still covers the path where the permission is missing.

**Server API change or a new Vaultwarden quirk**
1. The code goes in `src/transport/*`. Read the JSON with the `ci` helpers (Vaultwarden mixes PascalCase and camelCase).
2. Server-supplied URLs stay on the configured server; `http` only for loopback (invariant 7).
3. Record the quirk in `docs/COMPATIBILITY.md` under the Vaultwarden version it was verified on, and say how
   (e2e, source reading).
4. Add or extend an e2e `step` in `tests/e2e/run.ts`.

**Dependency change**
No new dependency without a written reason (CLAUDE.md). Versions are pinned (`rangeStrategy: pin`); Renovate
waits 14 days. npm install scripts are off (`.npmrc`). A new Rust crate must pass `cargo deny`; a new git source
must go in `deny.toml` `allow-git`. A new license goes in `NOTICE` and `docs/LICENSING.md`.

**Upstream bump (sdk-internal, Vaultwarden, toolchain)**
- sdk-internal: Renovate moves the rev in `upstream.lock` and `crates/core-wasm/Cargo.toml` together; CI fails if they
  differ. wasm-bindgen-cli must equal the `wasm-bindgen` version in `upstream.lock`.
- Vaultwarden: `upstream.lock` `version` is the last release reviewed. Tests always run `latest`. Read the
  `node tools/sync-upstream.mjs` report and record what changed in `docs/COMPATIBILITY.md`.
- Rust toolchain: `rust-toolchain.toml` (Renovate). Node: `.nvmrc`.

**Container images in workflows**
Write `docker run … image:tag@sha256:<digest>`. Renovate's regex only updates images written that way.

### 3.3 Traps

- The service worker can die between any two awaits: no state in globals except caches you can rebuild; lock state
  lives in `storage.session`.
- `tools/mutate.mjs` finds its targets by exact text. Edit or move one of those lines and its mutant stops matching:
  update the search string in the same change, then run `node tools/mutate.mjs <id>`.
- `dev/preview/stub.ts` hard-codes the version and the request types the preview needs.
- `npm run test:biometric` leaves an `--e2e` build in `dist/ext`: run `npm run build` again before loading it by hand.
- A Homebrew `cargo` ahead of rustup on PATH breaks the wasm build: put `~/.cargo/bin` first.
- `src/ui/vault.ts`, `tests/e2e/run.ts` and `docs/SECURITY.md` are long: search them, read only the part you need.
- A screen change in the popup lands a frame later (view transition): code that reads the new screen's DOM right
  after `open()`/`goto()` must run in `ctx.afterRender()`.

## 4. Which proof to run

| Changed | Run |
|---|---|
| TS outside autofill/crypto, docs-adjacent code | `npm run check` |
| `src/ui/popup.css` tokens | `npm run check` (contrast is part of it) |
| `src/autofill/*`, `crates/autofill-*` | `cargo test -p <crate>`, `npm run build:wasm && npm run build && npm run test:fill` |
| `crates/core-wasm` | `bash tools/fetch-test-vectors.sh && WARREN_TEST_VECTORS=target/test-vectors cargo test -p warren-core-wasm`, `npm run size` |
| Passkeys | `npm run test:passkeys` (+ `fido2.test.ts`) |
| Biometric unlock | `npm run test:biometric` |
| Transport, account, sync, server behavior | e2e: start Vaultwarden, `node tools/build.mjs --e2e`, `npm run test:e2e` |
| A security check | its unit test + `node tools/mutate.mjs <id>` |
| Anything that grows a bundle | `npm run build && npm run size` |
| Rust style | `cargo fmt --check && cargo clippy --all-targets -- -D warnings` (CI runs both) |
| Workflows | CI runs actionlint and zizmor; keep `permissions: {}` at the top and per-job least privilege |

CI (`.github/workflows/ci.yml`) runs all of these on every PR. Only the `ci` fan-in job is required: a new job must be
added to its `needs`.

## 5. Reflecting code in the docs

A change is finished when the docs say what the code does. Update docs in the same commit as the code.

| If you changed… | Update |
|---|---|
| A security property, a trust boundary, a cap, a new guard | `docs/SECURITY.md`: the invariant's text and the file/function it names. A gap you leave goes to "Known gaps". |
| A check listed in `docs/VERIFICATION.md` or `tools/mutate.mjs` | Both, so the mutant still matches and the verdict still holds. |
| A permission | `src/manifest.json` + its reason in `docs/SECURITY.md`. |
| Process model, a new context, storage or lock model, push, aliases | `docs/ARCHITECTURE.md`, the matching section. |
| Server behavior or a quirk | `docs/COMPATIBILITY.md`, under the Vaultwarden version and with how it was verified. |
| A feature the official extension has | `docs/PARITY_REPORT.md` "Still missing" / "Done". |
| Release, signing, update flow | `docs/UPDATES.md` and `.github/workflows/release.yml` comments. |
| Pins, upstream mapping | `upstream.lock`, `upstream-map.yaml`, `docs/UPSTREAM_SYNC.md`. |
| Licenses, third-party code or assets | `NOTICE`, `docs/LICENSING.md`. |
| A command, a script, a tool | The `CLAUDE.md` commands table, `package.json` scripts, the README if users run it. |
| A file's role, a new module | `CLAUDE.md` Layout (one line) and section 2 of this file. |
| User-visible features | `README.md` feature list. |
| Brand, logo, palette | `brand/README.md`, then `node tools/icons.mjs`. |
| Anything a user notices | `CHANGELOG.md` (section 6). |

How to write docs here: plain English, present tense, describe what the code does, not what it used to do. Name the
file and function that enforces a claim. No marketing words. Do not invent claims: if it is not verified, say
"not yet verified" (as `docs/COMPATIBILITY.md` does).

## 6. Commits, changelog, versions, releases

**Commits.** One subject line in the form `Area: what changed, in user terms`, for example
`Passkeys: an abort before the request is registered cancels it` or `CSV export: defuse a formula in the username`.
Areas used so far: `Security`, `Core`, `Parity`, `Docs`, `CI`, `Release`, `README`, a feature name. Add `[skip ci]` only for
README-only commits. Commit only when the owner asks; end with the attribution lines the session gives.

**CHANGELOG.md.** Changes go in under the next version, with the headings `### Security`, `### Added`, `### Changed`,
`### Fixed` (in that order, only those that apply). One bullet per change, written for users, naming the visible
effect; mention a new permission or dependency explicitly.

**Version bump** (commit `Version X.Y.Z`): `src/manifest.json`, `package.json`, `package-lock.json` (the root
`version` fields), `dev/preview/stub.ts` (`getManifest`), and the dated `## X.Y.Z — YYYY-MM-DD` section in
`CHANGELOG.md`.

**Release.** Done by the owner, not by an agent: a signed, annotated tag whose message is the version's CHANGELOG
section (`git tag -s vX.Y.Z --cleanup=verbatim -F notes.md`, checked with `bash tools/verify-tag.sh vX.Y.Z`). The tag
has to be on `main` with a green `ci`. Never touch `CRX_KEY` or the extension id. Details in `docs/UPDATES.md`.

## 7. Never

- Put keys, decrypted items or values in the service worker, the autofill engine, `storage.*` or a log.
- Trust a URL, origin, tab or frame id from a message payload.
- Cast a message instead of parsing it, or let a page-controlled size through without a cap.
- Use `innerHTML`, or render server/page text as markup.
- Lock any way other than `lockNow()`.
- Follow a server-supplied URL off the configured server, or allow `http` other than loopback.
- Rename the server-facing ids (`Bitwarden-Client-*`, `CLIENT_NAME`, `DEVICE_TYPE`).
- Copy code, text or assets from another password manager.
- Install or point anything at Google Chrome.
- Regenerate the CRX signing key.

## Keeping this map true

This file describes the repository; it does not enforce anything. When a change moves a concern, adds a context,
a tool, a script or a doc, update section 2 here and the one-line Layout entry in `CLAUDE.md` in the same commit.
When a recipe was wrong or a trap cost you time, add it here.
