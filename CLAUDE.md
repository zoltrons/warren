# Warren — project map

MV3 extension (Chromium 156+), a Bitwarden-protocol client for self-hosted **Vaultwarden**. Vanilla TS + esbuild,
crypto and the autofill engine in Rust→WASM. Priorities: Vaultwarden compatibility > security > size/speed.
Code, comments, commits and docs in English. Browser is **Helium**, never Chrome.
`AGENTS.md` is a symlink to this file. Long form (where each concern lives, recipes, which proof to run, which docs a
change must update, commit/changelog/version rules): **`docs/AGENT_MAP.md`**, read the section for your area.

## Commands

Every check goes through **`node tools/verify.mjs`** (CI runs the same stages). It picks the rustup toolchain and
Helium itself, fetches the PSL once and the test vectors once per sdk-internal rev, skips a wasm build whose sources
are unchanged, times each task and stops at the first failure. CI on a push or PR runs only the jobs its changed files
need (`tools/scope.mjs`: docs need none, TypeScript skips the Rust job); the nightly run and a release run every job.

| Task | Command |
|---|---|
| After every change: types, unit tests (`src/**/*.test.ts`, `tools/*.test.mjs`), contrast (~10 s) | `npm run check` (= `node tools/verify.mjs`) |
| Before every push: what CI runs for this change but e2e (scope from the files that differ from origin/main) | `node tools/verify.mjs push` |
| Every check but e2e (wasm, rust, build, size, smoke tests, workflow/secret lint), before a version commit | `node tools/verify.mjs full` |
| e2e vs. Vaultwarden **testing** (main, the next release: development target) + mock IdP; `VW_TAG=latest` for the supported release, CI runs both | `bash dev/vaultwarden/up.sh` (docker or Apple `container`), then `node tools/verify.mjs e2e --only vault,inline` |
| One task | `node tools/verify.mjs <task>`: `fmt clippy vectors autofill wasm build size fill biometric passkeys lint e2e` |
| Release, once the `Version X.Y.Z` commit is on main | `bash tools/release.sh X.Y.Z` (starts a full ci run and waits for it, signs, pushes the tag) |
| UI screenshots, stubbed worker | `node dev/preview/build.mjs && node dev/preview/shot.mjs [dir] [--only list,menu]` |
| Icons from `brand/icon.svg` + `brand/wordmark.svg` | `node tools/icons.mjs [--sheet out.png]` |

Run the smallest proof for the change: the one task or `--only <group>` that covers it while iterating; `push` once
before pushing, not after every edit. The full e2e suite is CI's: locally `e2e` needs `--only` (it refuses without;
`--all` overrides), never a full run before a push or to double-check. Do not rerun a passing stage on unchanged code
or loop a flaky test in the foreground. A stage that can take over 2 min (`push`, `e2e`, `gh run watch`, `release.sh`) runs in the background
(`run_in_background`), never as a foreground `sleep`/`until` poll.

e2e groups (`tests/e2e/<group>.ts`, in order): `auth webauthn send vault autofill inline passkeys vectors sso`; a group
imports the groups it builds on, so `--only inline` also runs `vault` and `autofill`.

## Layout

```
ui (popup/sidepanel/menu/bar) --Request--> background/index.ts --coreCall--> offscreen/offscreen.ts → worker.ts → crates/core-wasm
content.ts (page)             --PageRequest--> (router)
menu.html/bar.html frames     --FrameRequest--> background/inline.ts
page.js/content.js --CollectedPageDetails--> background/engine.ts --> crates/autofill-core (wasm, no keys)
```

- `src/shared/messages.ts` — every message type + hand-written validator (`Request`, `PageRequest`, `FrameRequest`,
  `CoreRequest`), `State`, `VaultItem`, `ErrorCode`, size caps.
- `src/background/` — stateless service worker: `index.ts` router, `account.ts` login/2FA/SSO/unlock (all end in
  `afterUnlock`), `vault.ts` sync/save/import/export/attachments/clipboard, `autofill.ts` fill, context menu, badge,
  toolbar icon (`updateTabUi`), `inline.ts` inline menu + save bar, `passkey.ts`, `lock.ts`, `reprompt.ts`,
  `store.ts` typed `chrome.storage`, `core.ts` offscreen bridge.
- `src/offscreen/` — holds keys + decrypted vault: `vault.ts`, `fido2.ts`, `worker.ts` (op switch), `offscreen.ts`.
- `src/transport/` — fetch client (`http.ts` bounded bodies, `auth.ts`, `vault.ts`); no keys.
- `src/autofill/` — `collector/`, `executor/fill.ts`, `page.ts` (isolated-world API `globalThis.warren`),
  `content.ts`, `passkey-*.ts`, `match.ts`.
- `crates/autofill-*` — field classification: `autofill-core` (wasm surface), `-resolver` (8 passes), `-clue`
  (rules), `-fill` (plan), `-autosubmit`, `-autocomplete-off`, `-cpd`/`-designation` (types).
- `crates/core-wasm/` — `api.rs`, `cipher.rs`, `send.rs`, `totp.rs`, `generator.rs`; `lib.rs` = wasm_bindgen surface;
  `bitwarden-crypto` at the rev in `upstream.lock`.
- `src/ui/` — `popup.ts` shell/auth, `settings.ts` settings tab (export/import); vault tab: `vault.ts` (router), `vault-list.ts`, `vault-item.ts`,
  `vault-edit.ts`, `vault-tools.ts` (folders/orgs/report), `vault-shared.ts` (state `st`, helpers); `generator.ts`,
  `send.ts`, `biometric.ts`, `dom.ts` (`h`, `send`, `t`), `icons.ts` (Lucide glyphs), `popup.css` (all theme tokens).
- `src/_locales/{en,tr}` — both carry every key (`locales.test.ts`); `uiLocale` sets dates and plurals. `src/icons/` — generated PNGs.
- `brand/` — logo masters, palette, store text. `docs/` — `ARCHITECTURE`, `SECURITY` (numbered invariants),
  `COMPATIBILITY` (server quirks), `UPDATES` (release/self-update), `UPSTREAM_SYNC`, `LICENSING`, `PARITY_REPORT`,
  `VERIFICATION` (adversarial invariant pass, `tools/mutate.mjs`), `AGENT_MAP` (agent guide).

## Recipes

- **UI→worker request:** `Request` + `requestValidators` → `case` in `handle()` (index.ts; vault ops in the unlocked
  branch) → `send()` from `ui/*`.
- **Crypto/vault op:** `CoreRequest` + `coreValidators` → `case` in `offscreen/worker.ts` → fn in `api.rs` + `lib.rs`.
- **Returns item secrets:** must pass `repromptPending` (reprompt.ts).
- **String:** `src/_locales/{en,tr}/messages.json` (same key in both), `t("key")` in the UI, `msg("key")` in the worker. **Color:** a token in `popup.css` (both dark blocks),
  then `npm run check`.
- **Permission:** `src/manifest.json` + a written reason in SECURITY.md.

## Rules that bite

- The service worker dies any time: no state in globals except rebuildable caches; lock state in `storage.session`.
- Keys and the decrypted vault live only in the offscreen worker; `storage.*` holds ciphertext (exceptions: SECURITY.md
  Known gaps). Secret-free checks use `cipherSummary`, not `getCipher`.
- Validate everything crossing a trust boundary (`messages.ts`); cap page-controlled sizes.
- Server-supplied URLs stay on the configured server; http only for loopback.
- Lock only through `lockNow()`. The autofill engine never sees a value or a key (`background/engine.ts`).
- Size budget (`tools/size-budget.json`, `verify size`); no new dependencies without cause.
- Vaultwarden mixes PascalCase/camelCase JSON: read with the `ci` helpers.
- Server-facing ids stay Bitwarden's: `Bitwarden-Client-*` headers, `CLIENT_NAME`, `DEVICE_TYPE` (constants.ts).
- The shell is zsh: quote globs (`grep --include='*.ts'`) or use `rg -g '*.ts'`. Edit files with the editor tool, not
  `sed -i` (BSD sed on macOS).
- A score or "until X" goal moves only with a proof: name the test, step or measurement behind each point.
- License GPL-3.0-only (`LICENSE`, `NOTICE`, docs/LICENSING.md). Other password managers are idea references only: never copy
  their code, text or assets.
