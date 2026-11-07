# Verification of SECURITY.md invariants (adversarial pass)

Date: 2026-11-07, against `e60272b` (0.0.12). Node 26.13.0, Helium for `test:fill`. Scope: invariants 1, 2, 3 (origin
re-check only), 4, 7a, 8b and 11 (`checkRpId` only). The pass itself changed only tests. The fix for F1 came after it (see F1).

Method, per claim: find the code, find the test, then **mutate** the check (remove or invert it), run the suite
(`npm test`, or `npm run test:fill` for page code) and restore the file. A mutation that leaves every test green means
nothing would notice if the check were lost. For each such gap a test was written, and the mutation run again to show
that the new test fails on the mutant and passes on the real code. The runner is `tools/mutate.mjs`: it does a textual replace, runs the suite and restores the file.
`node tools/mutate.mjs` runs every mutation in this report, and `node tools/mutate.mjs <id>...` runs only the ones
named. A mutant that hangs the suite counts as KILLED: the suite does not pass.

Verdicts: **DOĞRULANDI** = in the code, a test catches its removal, and no bypass was found. **KISMEN** = in the code,
but a gap remains (a bypass, or a check whose removal no test notices). **KORUMASIZ** = no test notices its removal.
**KODDA YOK** = the document claims it but the code does not do it.

## Results

| Invariant | Konum | Mevcut test | Mutasyon sonucu | Hüküm |
|---|---|---|---|---|
| 7a fixed minimum ("Anything below OWASP's Password Storage minimums … is refused outright, also on a first login") | `src/background/kdf.ts:18-21` (`PBKDF2_MIN`, `ARGON2_MIN`, `tooWeak`), `src/background/account.ts:77` | `account.test.ts` "a server that lowers the KDF gets no password hash"; `kdf.test.ts` | `kdf-floorMin`, `kdf-pbkdf2Min`: KILLED | DOĞRULANDI |
| 7a per-account floor ("the strongest KDF an account was seen with on this browser is kept per SHA-256 of `kdf\|<server>\|<email>` (also after logout), and a weaker one is refused unless it is still a safe setting") | `account.ts:82-86` (`rememberKey`, `kdfDowngrade`, `raiseFloor`); `kdf.ts:31-34` | before: only the pure `kdf.test.ts`. **Added:** `account.test.ts` "KDF floor: a server that lowers it below what this account used here gets no hash, also after a logout" | before: `kdf-downgrade`, `kdf-noPersist` SURVIVED. After: both KILLED | KISMEN at `e60272b` (F1); DOĞRULANDI after the F1 fix |
| 7a token response ("It chooses the account's KDF (prelogin and token response) … Every KDF from the server passes `guardKdf`") | `account.ts:121` (password, device and 2FA logins via `completeLogin`), `account.ts:790` (SSO), `account.ts:188` (prelogin) | before: none. **Added:** "KDF floor: a token response that lowers the KDF stores no account", "KDF floor: an SSO login whose server lowers the KDF stores no account" | before: `kdf-tokenUnguarded`, `kdf-ssoUnguarded` SURVIVED. After: both KILLED | DOĞRULANDI |
| 7a stored account ("before a hash made with it is sent", re-prompt) | `account.ts:544` | "an account stored with a too weak KDF sends no hash to confirm the master password" | `kdf-reverifyMin`: KILLED | DOĞRULANDI |
| 4 frame secret ("Both carry a per-document secret … without it the worker refuses") | `src/background/inline.ts:220` (menu nonce), `inline.ts:197` (bar token) | before: only the parser test "frame requests: inline actions need the nonce…" (shape, not value). **Added:** `src/background/inline-auth.test.ts` "frame secret: …" ×2 | before: `frame-nonce`, `frame-barToken` SURVIVED. After: both KILLED | DOĞRULANDI |
| 4 `guardClicks` ("A click counts only after the frame has been really visible for 300 ms, and the wait starts again whenever the menu moves") | `src/ui/dom.ts:49-71`; called by `src/ui/menu.ts:52`, `src/ui/bar.ts:10`; move signal `src/autofill/content.ts:51` | before: none. **Added:** `src/ui/dom.test.ts` (4 tests, with a stubbed IntersectionObserver v2) | before: `clicks-300to0`, `clicks-ignoreVisible`, `clicks-moveNoReset` SURVIVED. After: all KILLED | **KISMEN**: "whenever the menu moves" is narrower than stated (F2, not reproduced in a browser) |
| 8b `lockNow` ("`lockNow` bumps `lockEpoch` first") | `src/background/lock.ts:58` | before: none. **Added:** `fill-race.test.ts` "a lock counts from its first tick…" | before: `epoch-lockFirst` (bump moved after one `await`) SURVIVED. After: KILLED | DOĞRULANDI |
| 8b `assertEpoch` / `checkEpoch` ("checks it synchronously right before each write or send") | `lock.ts:46-48`, `account.ts:111-115` | `account.test.ts` races; `fill-race.test.ts` | `epoch-assertNoop`, `epoch-checkNoop`: KILLED | DOĞRULANDI |
| 8b `ownerEpoch` ("a refresh, the push hub and an SSO callback check it before they send or store") | `lock.ts:51-53` (`assertOwner`) | "a refresh answer for an account that was replaced meanwhile is dropped", "a server and a token are only handed out together…" | `epoch-ownerNoop`: KILLED | DOĞRULANDI |
| 8b per call site: login/unlock, re-prompt grant, fill, save bar, `putCipher` | `account.ts:364`, `account.ts:559`, `src/background/engine.ts:125`, `inline.ts:140`, `inline.ts:170`, `src/background/vault.ts:174` | account / fill-race / vault-race tests. **Added:** `inline-auth.test.ts` "epoch: a lock while a submitted login is matched…" | `epoch-afterUnlock`, `epoch-reprompt`, `epoch-engineGuard`, `epoch-saveBar`, `epoch-vaultPut`: KILLED. `epoch-loginSubmitted` SURVIVED before the added test, KILLED after | DOĞRULANDI |
| 8b per call site: field picker, passkey save, vault cache write ("every … field picker, passkey save and vault cache write takes the epoch…") | `src/background/picker.ts:43`, `picker.ts:56`, `src/background/passkey.ts:355`, `vault.ts:70` (`commit`), `vault.ts:56` (`load`) | before: none. **Added:** `src/background/picker-race.test.ts` ×2; `vault-race.test.ts` "a sync a lock overtook while the server answered writes no cache", "a vault load a lock overtook never reaches the new worker", "a passkey a lock overtook while the worker made it is never saved" | before: `epoch-pickerStart`, `epoch-pickerFinish`, `epoch-passkeySave`, `epoch-vaultCommit`, `epoch-vaultLoad` SURVIVED. After: all KILLED | DOĞRULANDI |
| 1 page/frame sender ("`handlePage`/`handleFrame` derive the URL from `sender.url` and the tab and frame from `sender.tab`/`sender.frameId`") | `inline.ts:82-84`, `inline.ts:93`; router `src/background/index.ts:385-413` (tabId from `sender.tab`) | before: none. **Added:** `inline-auth.test.ts` "sender: the inline menu belongs to the frame the browser reports, not to the page's claim or the tab" | before: `sender-frameUrlFromTab` (URL taken from `sender.tab` instead of the frame) SURVIVED. After: KILLED | DOĞRULANDI |
| 1 passkey port ("The passkey port uses `port.sender.origin`") | `src/background/passkey.ts:79-84` | before: none for the refusal path. **Added:** `vault-race.test.ts` "passkeys: only our content script in a web page's top frame gets a port served" | before: `sender-passkeyAnyFrame` (drop `frameId !== 0`) SURVIVED. After: KILLED | DOĞRULANDI |
| 2 `parseRequest` ("Unknown types are refused") | `src/shared/messages.ts:298-302` | "popup requests: unknown types, and new organization items without a collection, are refused" | `parse-unknownPopup`: KILLED | DOĞRULANDI |
| 2 `parsePageRequest` / `parseFrameRequest` | `messages.ts:851-860` (`parseBy`, `Object.hasOwn`) | before: shape tests only. **Added:** `messages.test.ts` "page and frame requests: unknown types are refused, also inherited names" (`toString`, `__proto__`, `constructor`) | before: `parse-unknownPage` SURVIVED. After: KILLED | DOĞRULANDI |
| 2 size caps ("form values, challenges, credential-id lists … capped at the boundary") | `messages.ts:602-610` (challenge 64 KiB, 64 ids), `messages.ts:730` (`pageString`) | "passkey calls: page-supplied options are bounded", "inlineFocus carries bounded page details", "page requests: a submitted login is size-capped" | `parse-credIds64`, `parse-challengeCap`, `parse-pageString`: KILLED | DOĞRULANDI |
| 2 `parsePasskeyCall` | `messages.ts:714-722` | "passkey calls: page-supplied options are bounded" | covered by `parse-credIds64`, `parse-challengeCap` | DOĞRULANDI |
| 3 origin re-check on collect ("`page.js` re-checks `location.origin` … when it collects") | `src/autofill/page.ts:45` | `tools/smoke-fill.mjs` "a frame on another origin is refused" | `origin-collect`: KILLED (`test:fill`) | DOĞRULANDI |
| 3 origin re-check on write ("… and when it writes") | `src/autofill/executor/fill.ts:105` | before: none (every smoke `execute` passed `location.origin`). **Added:** smoke scenario "a write for another origin is refused, even with a plan made in this frame" | before: `origin-execute` SURVIVED. After: KILLED (`test:fill`, 53 scenarios) | DOĞRULANDI |
| 11 `checkRpId` ("the origin's host or a registrable parent, on a secure origin, and never a public suffix — including when the page's own host *is* the public suffix") | `src/offscreen/fido2.ts:25-38` | `fido2.test.ts` "passkey RP ID: …" ×2. **Added:** `evilexample.com` vs `example.com` | `rp-noSuffix`, `rp-noSecure`, `rp-noLabelled`: KILLED. `rp-noDot` (`endsWith(id)` without the dot) SURVIVED before the added case, KILLED after | DOĞRULANDI |
| 11 `checkRpId` is applied by the worker ops | `src/offscreen/vault.ts:497-500`, `vault.ts:513`, `vault.ts:533`, `vault.ts:547` | before: none. **Added:** `vault.test.ts` "passkeys: the worker checks the RP ID against the origin before it signs or creates" | before: `rp-assertUnchecked`, `rp-createUnchecked` SURVIVED. After: both KILLED. `passkeyCandidates` is not covered (it needs a loaded vault) | DOĞRULANDI (assert/create), candidates untested |

Final state: `npm run check` passes (typecheck, 136/136 tests), `npm run test:fill` passes 53/53.

## Findings

### F1: the KDF floor key was not normalized on SSO (invariant 7a), FIXED

`login()` lowercases and trims the email before `guardKdf` (`account.ts:184`). `finishSso` passes the email claim of the
server-issued token as it is (`account.ts:787`, `jwtClaim`). The floor key is `SHA-256(kdf|<server>|<email>)`
(`account.ts:54-56`), so `Floor@b.test` gets a different floor from `floor@b.test`. The master-key salt is the
same, because bitwarden-crypto lowercases it (`crates/bitwarden-crypto/src/keys/kdf.rs:97` at `d7ab996`:
`email.trim().to_lowercase()`). A hostile server can therefore have an account with an Argon2id 64 MiB x 3 floor
accept and store Argon2id 19 MiB x 2. That is above the fixed minimum and below the floor.

Evidence before the fix: the test in `src/background/account.test.ts`, then marked `todo` ("KDF floor: kept per account whatever case the server
writes the email in"):

```
$ node --test --experimental-strip-types src/background/account.test.ts
⚠ KDF floor: kept per account whatever case the server writes the email in # docs/VERIFICATION.md: …
  AssertionError [ERR_ASSERTION]: an Argon2id 19 MiB x 2 KDF was stored for an account seen with 64 MiB x 3
  + { email: 'Floor@b.test', kdf: { iterations: 2, memory: 19, parallelism: 4, type: 1 }, … }
```

Control: the same test with `floor@b.test` passes (the floor refuses it).

Fix: `finishSso` trims and lowercases the claim like `login()` does (`account.ts:787-788`). The test is now a regular
test, and it uses `" Floor@b.test"`, with a leading space and a capital. It fails with the old line and passes with
the new one.

Limits of the finding: an SSO login sends no master-password hash. The weaker KDF is only stored in `account.kdf`,
and a later hash with it would come from `verifyMasterPassword` (`account.ts:546`), which runs only after an unlock.
The unlock derives with the stored (wrong) KDF and should fail to decrypt the real user key. No path that sends a
hash was found, but none was ruled out by a test either. The window only exists for Argon2id between 19 MiB x 2 and
64 MiB x 3: for PBKDF2 the minimum (600 000) is also the safe setting, so the floor adds nothing there. This is by
design and documented, but worth knowing.

After the fix, an account that only ever used SSO, on a server that writes its email with capitals, had its floor
stored under the mixed-case hash. Its first SSO login after the update finds no floor, so only the fixed minimum
applies, and that login stores the floor under the new key. That one login sends no password hash, so nothing leaks.
No migration was added for it.

### F2: guardClicks restarts only on moves made by content.js (invariant 4), not reproduced, documented

The 300 ms wait restarts on any `message` event in the frame (`dom.ts:59-61`). The only sender is `place()` in
`content.ts:51`, and only when it changes `top`/`left` itself. A page that moves the menu some other way, for
example by translating or scrolling an ancestor of the host, sends no message. IntersectionObserver v2 counts a 2D
translation as visible (W3C IntersectionObserver v2: only transforms other than 2D translation or proportional
upscaling make a target not visible). So "the wait starts again whenever the menu moves" holds for moves by Warren,
not for every move. This was **not reproduced in a browser**. The evidence is the code above. The impact is limited:
the fill still goes only to the frame and site that opened the menu. Not changed in code: the frame cannot see its
own position in the parent, and polling the host position from `content.js` costs more than the risk is worth.
SECURITY.md invariant 4 now states the narrower claim.

## Bypass attempts that failed (the claim held)

- Prelogin with PBKDF2 5000: refused before `prepareKey` (existing test).
- A token response with a lower KDF than prelogin: refused, no account stored (added tests, password and SSO).
- Floor reset on a second login: the floor survives `logout()` (`account.ts:628` does not remove `kdfFloors`, and no
  `storage.local.clear` exists in `src/`). Covered by the added test.
- Device login (`account.ts:443`) passes the prelogin KDF to `passwordLogin` without `guardKdf`. It sends the access
  code, not a password hash, and `completeLogin` guards the token's KDF before anything is stored. No bypass.
- A lock between awaits: with `lockNow` called mid-login, mid-unlock, mid-re-prompt, mid-fill, mid-save-bar and
  mid-`loginSubmitted`, the existing and added tests show no unlock, grant, value or pending save survives.
  `updateSession` is serialized (`store.ts:174-184`), so a late `unlocked: true` cannot land after the lock's `false`.
- Page claims: `details.origin` in `inlineFocus` is ignored, and the context takes `sender.url` (added test).
  Popup `fill` / `readPageLogin` carry `tabId`/`origin` in the payload, but `fillShownTab` (`autofill.ts:147-150`)
  only uses them to refuse a changed tab. The decision is made on `chrome.tabs.get`.
- Message type `__proto__` / `toString` / `constructor`: refused by `Object.hasOwn` (added test).
- RP ID `example.com` on `evilexample.com`: refused (added case).

## Belgede yazıp kodda olmayanlar

- **7a** "a weaker one is refused … per SHA-256 of `kdf|<server>|<email>`": true for password login, but on SSO the
  email was not normalized, so the same account could have two floors (F1, fixed).
- **4** "the wait starts again whenever the menu moves": only moves made by `content.ts` `place()` restart it (F2).
  The wording in SECURITY.md is now narrowed to match.
- Nothing in scope was found to be entirely missing (no KODDA YOK).

## Testsiz kalan invariantlar

- **8b** the remaining call sites that were not mutated one by one: `sync`'s other `commit`, `thenSync`, attachments,
  import/export and the clipboard (`vault.ts:193-388`), and `autofill.ts:48`, `autofill.ts:101`, `autofill.ts:136`.
  Their checks exist, but no test was confirmed to fail without each one.
- **11** `passkeyCandidates` calls `checkRp` (`vault.ts:513`), but testing it needs a loaded vault.
- **4** the real IntersectionObserver v2 behaviour (covering, opacity, transforms) is not exercised in a browser.
  `dom.test.ts` stubs the observer and tests only `guardClicks`' own logic.
- Out of this pass's scope and not checked: 5, 6, 6a, 7, 8, 8c, 9, 10, 10a, 11a, 12, 13, 14, and invariant 3's
  matching, "Fill anyway" and visibility rules.

## Tests added

`src/ui/dom.test.ts`, `src/background/inline-auth.test.ts` and `src/background/picker-race.test.ts` (new), plus cases in `src/background/account.test.ts`,
`fill-race.test.ts`, `vault-race.test.ts`, `src/shared/messages.test.ts`, `src/offscreen/fido2.test.ts`,
`src/offscreen/vault.test.ts` and `tools/smoke-fill.mjs`.
