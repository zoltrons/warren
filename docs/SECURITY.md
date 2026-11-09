# Security model and invariants

What has to stay true for Warren to be safe, and where each rule is enforced. Read this before
changing the message bus, the autofill path or the transport: most of these rules are one small edit
away from being silently undone, and several are covered by unit tests.

## Trust boundaries

| Context | Trust | Holds |
| --- | --- | --- |
| Web page (any origin, http and https) | **untrusted** | nothing of ours; can read anything we inject into its DOM |
| Content scripts (`page.js`, `content.js`, `passkey-relay.js`) | semi-trusted, page-adjacent | the page URL the browser reports, a per-document nonce |
| MAIN-world shim (`passkey-page.js`) | **untrusted** — it *is* page code | nothing; it only forwards `navigator.credentials` calls |
| `menu.html` / `bar.html` frames | trusted extension page, but framed by a page | item names/usernames for the current origin only |
| Service worker | trusted | encrypted cache, tokens, policy |
| Offscreen document + crypto worker | trusted | master key handles, user key, org keys, decrypted vault |
| Popup / side panel | trusted | decrypted data while open |

The only place keys and plaintext live is the crypto worker (`src/offscreen/worker.ts` + `vault.ts`).
Locking terminates the worker, so the WASM memory that held Argon2id's 64+ MiB and the user key is
freed rather than zeroed in place.

## Invariants

1. **Origin, URL, tab and frame always come from `sender`, never from the message.**
   `handlePage`/`handleFrame` (`src/background/inline.ts`) derive the URL from `sender.url` and the tab
   and frame from `sender.tab`/`sender.frameId`. The passkey port uses `port.sender.origin`
   (`src/background/passkey.ts`). Never accept a URL/origin/id from the payload for a security decision.

2. **Every cross-context message is parsed, never cast.** `parseRequest`, `parseCoreRequest`,
   `parsePageRequest`, `parseFrameRequest`, `parsePasskeyCall` (`src/shared/messages.ts`) validate
   shape *and* size. Unknown types are refused; anything a page or a server can make arbitrarily large
   (form values, challenges, credential-id lists, imports) is capped at the boundary.

3. **Filling is triple-checked.** For a login the item must match the site's URL (the one exception: a login
   picked in the popup for another site fills only after the user accepts the "Fill anyway" dialog, as in the
   official client; `fill` with `anyway`, sent by extension pages only). A popup fill names the tab and origin
   the popup showed and is refused once either changed, dialog or not. `page.js` re-checks
   `location.origin` inside the frame both when it collects and when it writes (`src/autofill/page.ts`,
   `executor/fill.ts`), and the inline menu fills exactly the frame that asked (`frameIds: [ctx.frameId]`).
   A same-tab navigation or a tab switch between the click and the fill therefore cannot fill another
   site. Popup and gesture fills try the top frame first and, only when it has no form, every frame of the
   tab: the same origin check runs in each one, so a cross-origin iframe returns before it reads a single
   field. A write also re-checks that its field is still on screen, so a field hidden after collection
   gets nothing; a hidden password of a two-step form is only recognised, never filled.

   **The autofill engine is separate from the keys.** `crates/autofill-core` parses page-controlled text, so
   it is its own WebAssembly module in the service worker, never in the offscreen worker. It receives field
   details and the *names* of the values an item has (custom field names included, which also makes a
   `regex=` name a pattern the engine runs: `regex-lite` has no backtracking), and answers with field ids and
   those names; the worker substitutes the values afterwards. A frame's report contains no field value at all. Page details are
   capped at the boundary (`parsePageDetails`, `shared/page-limits.ts`), also when they come back from
   `chrome.scripting`, and a report the engine cannot use fills nothing.

   **"Pick from page" trusts nothing but a real click.** While it runs, content.js swallows the user's clicks in that
   tab, and only trusted events count; it ends on a pick, Escape, a lock, the popup opening again or after 2 minutes. The
   unsaved editor waits in the offscreen worker's memory, never in `storage.*`, and a lock drops it. What
   comes back from the page is a name and an input type, both capped; only a picker the worker started in
   that tab can receive one, and it lands in an editor the user still has to save.

   **Rules that change what a page can trigger.** A password field a page adds later offers the page-load fill
   as well, once per document: a page's script could already have added it before load. The page-load fill goes
   into the top frame or a frame of the tab's own origin only: any page can frame another site's login form and hide
   it from outside, where the frame's own visibility checks cannot see it. A blocked host is compared without a
   trailing dot (`example.com.` is `example.com`, as for the URI matcher). "Submit after
   filling" is off by default, needs a fill the user asked for (never page load, never a lone code), goes to
   one frame at most, and clicks only a submit button or one that says it logs in. Per-site recipes are compiled
   in; nothing about autofill is downloaded. `data-warren-autofilled` tells a page that a field was filled, which it
   can see anyway from the value appearing.

4. **An iframe of ours is not an authority.** `menu.html`/`bar.html` are web-accessible, so any site can
   frame them. Both carry a per-document secret (menu: from `content.js` via the URL fragment, inside a
   closed shadow root; bar: issued by `showBar`): without it the worker refuses, so a copy the page
   frames itself cannot read the list or drive a fill/save.

   **Neither frame takes a click it was not seen for (clickjacking).** A page can lay its own element over the
   menu, or make the menu transparent, and have the user click "through" it into a fill. `guardClicks`
   (`src/ui/dom.ts`) watches each frame with IntersectionObserver v2 (`trackVisibility`): the browser itself reports
   whether the frame is covered, transparent or transformed, also from a cross-origin parent. A click counts only
   after the frame has been really visible for 300 ms, and the wait starts again whenever `content.js` moves the menu (a
   page that only translates an ancestor sends no such signal, and IntersectionObserver v2 counts a 2D translation as
   visible). This is
   what makes listing cards and identities on every site safe (Known gaps).

5. **Only the service worker may talk to the offscreen document.** `sender.url === background.js`,
   `sender.tab` absent (`src/offscreen/offscreen.ts`). Conversely the worker answers only its parent.

6. **Vault secrets are never written unencrypted to disk.** `storage.local` holds the encrypted cache, the
   protected user key, the wrapped PIN, an encrypted generator history, encrypted alias settings and the refresh token
   sealed with the user key (`storeRefreshToken`). The 2FA remember tokens are the exception, see Known gaps. Access tokens, and a typed password waiting in the
   save bar until it expires or the vault locks, live in `storage.session` (memory only); the decrypted
   vault lives in the crypto worker. Both stores are set to `TRUSTED_CONTEXTS` on *every* worker start, so
   content scripts cannot read them.

6a. **What the user does is encrypted too.** Never-save and blocked hosts, last-fill and last-open stamps, generator options,
    the username generator's address and domain sit in one EncString (`storage.local` "private",
    `src/background/private.ts`); a custom passphrase list in another ("wordlist"), which never goes back to the
    popup. They are read and written only while unlocked (so a locked vault cannot tell a blocked site and offers only an unlock there), writes are serialized, a record that does not decrypt
    is never written over, and logout removes both. Everything we encrypt ourselves (these, generator history,
    alias settings, the stored PIN) is padded to fixed blocks first (`src/background/seal.ts`), like the
    official clients' padded packer, so a ciphertext's length does not give away a password's or PIN's length
    or a record's size; values from older builds are re-padded on the next unlock. Clear text left by older builds moves in on the next unlock
    and is deleted only after the encrypted copy is written. Clear text that stays, because it is needed while
    locked or before the first render and says nothing about the vault: `settings` (lock, autofill and UI
    switches), server URL, account email, device id, and in the extension's `localStorage` only the theme, popup width, compact and animation switches, the
    list's sort order, the notes formatting switch and whether "Recently opened" is shown.

7. **The server is not trusted with URLs.** `http://` is refused except for loopback
   (`src/shared/url.ts`), the API client sends `credentials: "omit"`, `redirect: "error"`, and an
   attachment download URL must be on the configured server (`src/transport/vault.ts`). Response bodies
   are bounded (`readBytes` in `src/transport/http.ts`). The one server-supplied URL that leaves the server is Duo's
   authorize URL: it opens only if it is `https://api-<id>.duosecurity.com|duofederal.com/oauth/v1/authorize` (the
   clients' own check), and the result is read only from the tab Warren opened, on the configured server's
   `duo-redirect-connector.html` (`duoUrl`, `duoTabUpdated` in `src/background/account.ts`).

7a. **The server cannot weaken the KDF below what this browser has seen, nor below a fixed floor.** It chooses the
    account's KDF (prelogin and token response) and receives the hash the KDF produces, so a hostile server could ask for PBKDF2 at 5000 iterations and crack the master password
    offline. Every KDF from the server passes `guardKdf` (`src/background/account.ts`, rules in `kdf.ts`) before a hash
    made with it is sent or stored: the strongest KDF an account was seen with on this browser is kept per
    SHA-256 of `kdf|<server>|<email>` (also after logout), and a weaker one is refused unless it is still a safe
    setting (PBKDF2 600 000, Argon2id 64 MiB x 3), which lets a user lower a very high KDF on purpose. Anything below
    OWASP's Password Storage minimums (PBKDF2-SHA256 600 000 iterations, Argon2id 19 MiB x 2; `PBKDF2_MIN`,
    `ARGON2_MIN`) is refused outright, also on a first login with no floor yet, and settings flag any KDF below the
    safe setting. On a first login a hostile server can therefore pick nothing weaker than those minimums. The price:
    an account set below them in the web vault (PBKDF2 100 000 from before 2023, Argon2id 16 MiB x 2) cannot log in
    until its KDF is raised.

8. **2FA state is scoped and short-lived.** Remember-device tokens are keyed by a SHA-256 of `<server>|<email>` (no clear-text email left after logout) so
   they are never replayed to another server; a pending 2FA login holds a master-key handle, so an
   abandoned attempt is freed when it expires, by an alarm that needs no open popup (`PENDING_ALARM`).

8b. **Every unlock path ends in the same place.** Master password, PIN and biometrics all go through
    `afterUnlock` (`src/background/account.ts`), which sets `unlocked` and arms the auto-lock, so no path
    can unlock without the lock timer. A lock always wins over work in flight (`src/background/lock.ts`): `lockNow`
    bumps `lockEpoch` first, and every login, unlock, re-prompt grant, fill, save bar, field picker, passkey save and
    vault cache write takes the epoch before its first await and checks it synchronously right before each write or
    send (`assertEpoch`, `checkEpoch`), so no lock slips in between; an unlock a lock overtook locks again instead.
    Account changes (login, SSO, logout, server change) bump a second counter, `ownerEpoch`: server credentials and
    caches outlive a lock but not their account, so a refresh, the push hub and an SSO callback check it before they
    send or store. Every server call takes the server and the access token together from `auth()`, read under one
    owner, so a token never goes to a server or account it was not issued for. A logout or login also ends an SSO
    login still waiting for its callback. PIN and biometric material is stored only as a *wrapped* user key
    (`storage.local`, removed on logout); the PIN is additionally limited to 5 attempts per session.
    Biometric unlock uses WebAuthn's PRF extension with `userVerification: "required"`, an RP ID of the
    extension origin and a random salt, and refuses authenticators without PRF instead of degrading to
    "biometrics as a UI gate".

8c. **Device approvals show the phrase and use the server's key.** "Log in with device" sends the user key to
    whoever holds the request's private key, so approving needs the unlocked vault and an explicit click on a
    screen that shows the fingerprint phrase (account email over the requester's public key, the same phrase the
    requesting device shows). The key is wrapped for the public key fetched from the server for that request id,
    never one supplied by a message, and only if that key gives the phrase the popup showed (`answerLoginRequest`),
    so a server cannot display one key and swap in its own for the approval. A push notification only announces a
    request; it never approves one. The requesting side keeps its RSA private key in the WASM only (RustCrypto, not
    WebCrypto), single use, dropped by the lock and when the request is cancelled or expires (`cancelTwoFactor`).
    Hub messages are capped at 64 KiB.

9. **Origin keys are best effort, never fatal.** One undecryptable organization key must not make the
   personal vault unreadable (`crates/core-wasm/src/api.rs` `set_org_keys`, plus the `try/catch` in
   `loadVault`); affected items surface as undecryptable instead.

10. **Decryption failures are isolated per item.** `decrypt_list`/`decrypt_folders`/`decrypt_send_list`
    report per-item failures instead of failing the batch, and a failed item is never matched or filled. An export
    with an undecryptable personal item is refused rather than silently incomplete.

10a. **A login's URIs are bound to it, when it has its own key.** Field MACs do not stop a server from moving one
    ciphertext into another field, or from one item into another: they all share the user key. For an item with its
    own key, a URI whose `uriChecksum` (SHA-256 of the URI, encrypted with the item) does not match is dropped on
    decrypt, as upstream does (`crates/core-wasm/src/cipher.rs`), so a server cannot point that login at another site.
    Every item Warren creates gets a fresh key of its own (`add_key`, used by `prepareSave` for new items, clones and a
    passkey's new login, and by imports). An item another client made without one keeps none when edited here:
    adding one would mean re-wrapping its attachment keys, so its URIs stay unbound.

11. **Passkeys are bound to the origin.** `checkRpId` requires the RP ID to be the origin's host or a
    registrable parent, on a secure origin, and never a public suffix — including when the page's own
    host *is* the public suffix. Signing happens in the worker, and the private key never leaves it: `getCipher`
    hands out items without `keyValue` and `prepareSave` restores it from the same item only
    (`src/offscreen/passkey-keys.ts`), so a clone does not copy a passkey. A new passkey is put into its item and
    encrypted in the worker (`passkeyCreate` answers with the ciphertext), so its key is never in the service worker.

11a. **The UV flag is honest.** The RP's `userVerification` is carried, and the authenticator data says "user
    verified" only when the user was verified for that request: the vault was unlocked for it, or the master
    password was confirmed in the approval window. A click in an already unlocked vault is presence only. When the
    RP requires verification and neither happened, the window asks for the master password, and the inline menu's
    one-click sign-in opens the window instead (`src/background/passkey.ts`).

12. **Rendered data is text, not markup.** No `innerHTML` anywhere; the `h()` helper sets properties
    from static keys and `textContent` for values, so vault, server and page strings cannot become
    markup. External links are restricted to http(s) (`webUrl`). The extension pages' CSP requires Trusted
    Types, so the browser itself refuses an HTML or script sink; the only policy (`warren`, `src/offscreen/offscreen.ts`)
    creates the crypto worker's URL and refuses any origin but the extension's.

13. **Clipboard copies are cleared on a timer** (1 minute by default), and the clear is armed only when the write
    actually happened — never after a failed copy that would otherwise erase the user's clipboard. The clear
    first reads the clipboard (`clipboardRead`, in the offscreen document, at that moment only) and leaves it
    alone when it holds something else than what Warren copied; the text read is hashed, compared and dropped.
    What is kept to compare is a SHA-256 of the copied value in `storage.session` (memory only), removed by the
    clear. If the clipboard cannot be read or the hash is gone, it is cleared as before.

14. **Locking tears down in-page UI.** Auto-lock, logout and login call `lockNow`, which closes the
    inline menu and save bar in every tab: those frames show decrypted item names, so they must not
    survive the lock. The popup/side panel follow the session in `chrome.storage.session` and drop their
    decrypted state on the same event.

## Cryptography direction

Rules for every new or changed piece of cryptography. Within what Vaultwarden can read, they aim to put
password hardness and post-quantum safety first. A change that breaks one of them needs a written reason here.
Post-quantum is a goal, not something Warren provides today: stored data is protected by AES-256 (rule 5), but
organization keys and log in with device rest on RSA-2048, and the only post-quantum protection in transit is
the TLS proxy the server admin runs (rule 8), which Warren cannot see or check.

1. **Argon2id for every secret derived from something a person types.** Keys only Warren reads (today the PIN key,
   `PIN_KDF` in `src/shared/constants.ts`) use Argon2id with our own parameters, never the account's. No new PBKDF2,
   scrypt or bcrypt. Where the protocol fixes the KDF (the account master key, chosen on the server; Send access
   passwords, PBKDF2 by spec) we follow it and steer the user to Argon2id (the PBKDF2 notice in settings).
2. **Parameters are tuned for current hardware and only go up.** Use as much memory as an unlock in the WASM worker
   allows on a current mid-range laptop at about one second, and never less than RFC 9106's second recommended
   setting (64 MiB, 3 passes). Review them once a year against RFC 9106 and OWASP. Set in 2026-11 (`PIN_KDF`
   256 MiB x 3; safe floor 64 MiB x 3 and PBKDF2 600 000, `kdf.ts`); next review due 2027-11. The server-side range
   checks (`kdf_from_params`) follow upstream's floors and are never lowered.
3. **High-entropy inputs need no slow KDF.** Random keys and WebAuthn PRF output go through HKDF. Argon2 adds nothing
   there.
4. **Every stored wrapped secret records how it was made**, for example the `EncString` type or `pinKdf`, so a stronger
   setting can re-wrap it on the next unlock (see `afterUnlock`). No new storage format without a version marker.
5. **Symmetric keys are 256 bits, authenticated** (AES-256 with HMAC-SHA256 or an AEAD). A quantum computer only
   halves them, so they stay safe. No new 128-bit keys.
6. **No new classical-only public-key cryptography.** New key exchange or encryption is hybrid (X25519 + ML-KEM-768,
   FIPS 203) or pure ML-KEM. New signatures are hybrid with ML-DSA (FIPS 204), or pure ML-DSA. RSA-2048 (organization
   and sharing keys, log in with device) and ES256 (passkeys) remain only because the protocol and relying parties
   require them.
7. **Post-quantum comes through `bitwarden-crypto`, never a scheme of our own.** A private format would cut Warren off
   from Vaultwarden and the other clients. When upstream ships post-quantum account keys (V2 accounts, COSE keys;
   the pinned crate already has ML-DSA-44 signing), adopt them in the first `UPSTREAM_SYNC` that Vaultwarden
   supports.
8. **Transport:** run the server behind a TLS 1.3 proxy that negotiates the hybrid X25519MLKEM768 group. Chromium
   offers it by default. Plain http is allowed only on loopback (invariant 7).
9. **No hand-rolled primitives.** Use `bitwarden-crypto` and RustCrypto crates inside `crates/core-wasm`. WebCrypto
   is used for hashes that involve no key, and for one thing more: passkeys' ES256 (P-256) keys are made, imported
   and used for signing with WebCrypto in the crypto worker (`src/offscreen/fido2.ts`), and never leave it
   (invariant 11).

## OWASP Cheat Sheet Series

Checked against the [OWASP Cheat Sheet Series](https://cheatsheetseries.owasp.org/) on 2026-11-07, every sheet that
applies to a client: from the connections Warren makes to how it stores settings. Review it together with the
KDF parameters (Cryptography direction rule 2), next due 2027-11. "Meets" means the rule in the right column is how
Warren meets it. "Partial" means part of the rule is met and the rest is out of Warren's reach. "Gap" means Warren falls
short on purpose. Either way the reason is given here or in Known gaps.

| Cheat sheet | Status | How Warren meets it, or why not |
| --- | --- | --- |
| Browser Extension Vulnerabilities: insecure message passing | Meets | Every listener checks `sender.id === chrome.runtime.id` and takes URL, tab and frame from `sender` (invariant 1). Every message type is allow-listed and validated (invariant 2). Content scripts count as less trusted than extension pages. |
| Browser Extension Vulnerabilities: permissions overreach | Gap | `https://*/*` and `http://*/*` are needed to autofill any site (Known gaps). `privacy` is optional. No `tabs`, no `externally_connectable`, `incognito: not_allowed`. |
| Browser Extension Vulnerabilities: XSS, code injection | Meets | No `innerHTML`, `eval` or remote code. The extension-page CSP is `script-src 'self' 'wasm-unsafe-eval'` with required Trusted Types (invariant 12). DOMPurify is not needed because no HTML is ever built from data. |
| Browser Extension Vulnerabilities: CSP | Meets | `content_security_policy.extension_pages` is `script-src 'self' 'wasm-unsafe-eval'; object-src 'none'` plus required Trusted Types. `'wasm-unsafe-eval'` allows compiling the bundled WASM only, never eval of JS. |
| Browser Extension Vulnerabilities: insecure storage | Meets | Secrets in `storage.local` are encrypted. Short-lived ones are in `storage.session`, restricted to `TRUSTED_CONTEXTS` (invariants 6, 6a). The exceptions are listed in Known gaps. |
| Browser Extension Vulnerabilities: DOM and prototype data skimming | Meets | Nothing secret goes into the page's DOM or main world. The inline menu and save bar are extension iframes, which the page cannot read. The secret in the menu's URL fragment travels inside a closed shadow root and only authenticates the frame (invariant 4). The main-world passkey shim only forwards calls; it holds no keys and makes no decisions. The page gets a fill or a signature, never the vault. |
| Browser Extension Vulnerabilities: malicious updates, dependencies | Meets | Self-update needs a signed CRX and a signed tag. Actions are pinned by SHA, and builds use lockfiles. `npm audit` and `cargo-deny` run on every CI run and release, and every release carries signed provenance (Known gaps, `docs/UPDATES.md`). |
| Password Storage, Cryptographic Storage: password KDFs | Meets | No hash of the master password is made below OWASP's minimums (PBKDF2-SHA256 600 000, Argon2id 19 MiB x 2), also on a first login (invariant 7a). Warren's own KDF (`PIN_KDF`, 256 MiB x 3) and the safe setting (Argon2id 64 MiB x 3) are well above them. The algorithm and parameters are stored with every wrapped secret (Cryptography direction rule 4), as OWASP asks. |
| Cryptographic Storage, Key Management: algorithms, keys, randomness | Meets | All symmetric encryption is AES-256 with encrypt-then-MAC, and every key is 256 bits. RSA uses OAEP and is used only where the protocol requires it. Keys are random from a CSPRNG (RustCrypto or WebCrypto) and never hardcoded; `Math.random` is not used. Each key encrypts only keys of equal or lower strength, and each item has a key of its own (invariant 10a). Keys never leave the crypto worker. A lock destroys them by ending the worker, because WASM memory cannot be reliably zeroed (Trust boundaries). |
| WebSocket Security | Gap | The connection uses `wss://` everywhere except loopback, and messages are size-capped at 64 KiB (invariant 8c). The access token is in the query string, against OWASP, because the Bitwarden hub protocol requires it (Known gaps). |
| Clickjacking Defense | Meets, by other means | `menu.html` and `bar.html` must be framable by any site, so `frame-ancestors 'none'` cannot apply. A click counts only after IntersectionObserver v2 has reported the frame as really visible for 300 ms (invariant 4). The two actions OWASP treats as high risk need more than a click: filling another site's login needs the "Fill anyway" dialog, and a re-prompt item needs the master password. |
| Multifactor Authentication | Partial | 2FA is enforced by the server. Warren keeps remember-device tokens per server and account (invariant 8), but they sit on disk in clear text (Known gaps). A passkey reports UV only when the user was actually verified (invariant 11a). |
| Software Supply Chain, CI/CD Security | Meets | Pinned actions, `zizmor`, lockfiles, signed tags, a signing job that runs no package code, and SLSA provenance via Sigstore (Known gaps, updates entry). Gitleaks scans the whole history on every CI run and blocks the `ci` gate (`.gitleaksignore` lists known test fixtures). Every release carries a CycloneDX SBOM made by syft (image pinned by digest, mounted read-only; the signing job takes the file from outside its checkout) from `Cargo.lock` and `package-lock.json`, attested like the other files. The npm packages are build tools only: nothing from npm is bundled into the extension. |
| Session Management | Partial | The access token is only in `storage.session` and the refresh token is on disk only sealed (invariant 6). Auto-lock is 15 minutes by default (1 minute to 4 hours, or on browser restart; `AUTO_LOCK_CHOICES`), and a late alarm cannot extend it. Lock drops the keys and the decrypted vault; logout also drops every token (invariants 8b, 14). The gap is on the server: Vaultwarden has no token revocation endpoint (`/identity/connect/revocation` answers 404), so logout cannot end the session there (Known gaps). |
| Authentication | Meets | The master password is sent as typed: not trimmed, not truncated, full Unicode, and only over TLS (invariant 7). Actions OWASP counts as sensitive ask for the master password again: export, re-prompt items, and a passkey that needs UV. Approving another device needs the unlocked vault and the fingerprint phrase (invariant 8c). The PIN allows 5 tries per session. Account lockout and generic login errors are the server's job. |
| Passkey Security | Meets | Secure origins only. The RP ID must be the origin's host or a registrable parent, never a public suffix (invariant 11), and comes from the browser-reported origin, never the page (invariant 1). UP and UV are kept apart (invariant 11a). Page-supplied options are capped (challenge 64 KiB, credential-id lists), and Warren keeps no logs of challenges or credentials. |
| HTML5 Security: postMessage, storage, workers, links | Meets | Every `message` listener that acts on data checks `ev.source`, and the popup's WebAuthn connector also checks the server's exact origin. The passkey shim posts with `"*"` only to its own window, and only what the page receives anyway. The menu's `"moved"` message only delays clicks. `localStorage` holds UI preferences only (invariant 6a). The crypto worker parses every request (`parseCoreRequest`) and runs no code it receives. Links get `rel="noopener noreferrer"` and open through `chrome.tabs.create`. |
| DOM Clobbering, Prototype Pollution | Meets | Extension pages build no HTML from data, so there is nothing to clobber there (invariant 12). Content scripts run in the isolated world, where the page's prototypes are not ours. A page that clobbers its own DOM can only break filling on itself, because every write re-checks origin and visibility (invariant 3). Server and page JSON goes through `JSON.parse` and validators that copy known keys only. The hub parser builds its objects with `Object.create(null)`. |
| Transport Layer Security, Pinning | Meets | The browser validates certificates and Warren offers no bypass. Plain http works only on loopback (invariant 7), and the hybrid post-quantum TLS group is recommended (Cryptography direction rule 8). No pinning, as OWASP advises for anything but native apps: Warren does not control the self-hosted server's certificate. |
| Secrets Management (in memory) | Partial | Keys and the decrypted vault live only in the crypto worker. Lock ends the worker, so its WASM memory is freed (Trust boundaries). JavaScript strings cannot be zeroed. A typed master password or an opened item stays in the popup's heap until garbage collection, but the popup drops it on lock (invariant 14). |
| Logging, Error Handling | Meets | No telemetry and no remote logging. `console` gets error objects only, never tokens, keys or vault values. Server error texts shown to the user are cut to 500 characters (`errorMessage`), and an HTML error page is never shown. |
| Input Validation | Meets | Allow-list validators at every boundary: unknown message types and choices are refused, and sizes and counts are capped (invariant 2, `page-limits.ts`). Response bodies are bounded (invariant 7). Regexes from page or vault data run on linear-time engines: `regex-lite` in the autofill engine, and `regexTest` in core-wasm for URI matching. |
| Transaction Authorization | Meets | What the user approves is what happens. A popup fill names the tab and origin it showed (invariant 3). A device approval shows the fingerprint phrase of the key it wraps for (invariant 8c). Filling another site's login needs the "Fill anyway" dialog. Every grant is checked in the service worker, not in the UI. |
| Third Party JavaScript, NPM Security | Meets | No remote scripts and no CDN. Nothing from npm is bundled: the npm packages are build tools only. `npm ci` with `ignore-scripts=true` (`.npmrc`), so no package's install script runs. Lockfiles, `npm audit`, and an SBOM with every release. |
| Cross-Site Request Forgery | Meets | Server calls use a bearer token in the `Authorization` header and `credentials: "omit"`, so no cookie or ambient session can be ridden. |
| Server Side Request Forgery | Meets | Warren only talks to the server the user configured. API calls and attachment downloads refuse redirects, and an attachment URL must be on that server (invariant 7). Alias services refuse redirects as well. Website icons follow the server's redirect on purpose (Known gaps). |

## Known gaps

- **The refresh token is on disk only sealed with the user key** (`storeRefreshToken` in
  `src/background/account.ts`), so a copied profile cannot reach the server with it. The price: after a browser
  restart a locked vault neither syncs nor receives push until the first unlock. A token that arrives while locked
  (SSO login, rotation) is kept in memory and sealed at the next unlock. With "Log out" as the timeout action it is
  never on disk, like the official clients.
- **The 2FA remember tokens are on disk in clear text**, because a login needs them before any key exists. With a
  copied profile *and* the master password, someone can skip the second factor once; the master password alone
  already opens the copied vault cache.
- **PIN-only unlock ("Lock with master password on restart" off) puts the vault behind the PIN on disk.** The user
  key wrapped with the PIN key stays in `storage.local` (`setPin` in `src/background/account.ts`). The 5-try cap only
  holds inside Warren: from a copied profile the PIN can be tried offline. Each try costs Argon2id at `PIN_KDF`
  (256 MiB, 3 passes, `src/shared/constants.ts`) whatever the account KDF is, so guessing is slow and memory-bound,
  but a short numeric PIN would fall and the whole vault with it. So PIN-only needs at least 8 characters and one
  that is not a digit (`pinOnlyStrong`, `src/background/kdf.ts`); a weaker PIN-only key from an older build is
  removed from disk on the next unlock (the PIN keeps working until the browser restarts). The default keeps the
  cap real. Keys from builds before `PIN_KDF` are re-wrapped on the next unlock.
- **Plain text passes through the service worker and the popup in a few places.** The fill data, a TOTP code and the
  full item for the popup go through the service worker in transit; it does not keep them. A password changed from
  the save bar, a new passkey and an attachment's name are handled in the worker (`preparePassword`,
  `passkeyCreate`, `decryptAttachment`), so the item does not pass. The popup holds an opened item (never a passkey's private key, invariant 11) because editing sends the whole
  item back. Checks that need no secret use `cipherSummary`.
- **Updates are only as trustworthy as the release pipeline.** Installed copies follow
  `releases/latest/download/updates.xml` (`docs/UPDATES.md`). The browser verifies each `.crx` against the
  extension's key, so a build signed with another key is refused, but anyone who can push a `v*` tag and read
  `CRX_KEY` could ship code to every installed copy, so a release also needs a tag signed by a key in
  `.github/allowed_signers` (`tools/verify-tag.sh`, the `tag-signed` job). That file is read from the tagged commit
  only after `ci-passed` showed the commit is in `main`'s history and the `ci` workflow's run for its push to `main`
  passed (a check merely named `ci` would not do: a pull request's run posts one on its own commits): whoever can
  change `main` can still add a key, but not without a visible commit. Keep that secret and the repository's write access tight.
  What the pipeline can do about it: every action is pinned by commit SHA and linted by `zizmor`, build tools
  come from lockfiles, the job that holds `CRX_KEY` installs nothing and runs no package code or browser (the CRX is
  signed by `tools/pack-crx.mjs` on `node:crypto`) and refuses a key that does not give Warren's extension id, a release needs a green `ci` and a
  clean advisory check, and each released file, the SBOM included, carries signed build provenance (`docs/UPDATES.md`). CI scans the history for committed secrets (gitleaks). Provenance
  shows which commit and run built a file; it cannot tell a malicious tag from a real one.

- **Logout cannot end the session on the server.** Vaultwarden has no token revocation endpoint, so a refresh
  token copied before logout stays valid until the device is removed or "Deauthorize sessions" is used in the web
  vault. Warren drops every token it holds on logout.

- **The push connection carries the access token in its URL.** Browsers cannot set headers on a WebSocket, so
  `/notifications/hub?access_token=…` (`src/background/push.ts`) is how the official clients connect too. A proxy that
  logs query strings records a token that is valid for up to two hours. It reaches only the configured server
  (invariant 7). While an account is logged in the connection, and with it the service worker, stays up.

- **The inline menu's "Sign in with passkey" signs in without a window.** Picking the entry is the
  decision: with exactly one matching passkey `openConditional` (`src/background/passkey.ts`) asserts
  right away. Several passkeys (a choice to make) or a `reprompt`-flagged item open the approval
  window instead, so the flag is never bypassed by this path. The request is still tied to the
  frame's per-document nonce and the browser-reported origin (invariants 1 and 4).

- **Third parties are reached only on an explicit click or an opt-in setting.** There are four: the data breach
  check and OpenStreetMap (this entry), the icon service the server may redirect to (website icons, off by default)
  and the selected email forwarding service (aliases), the two entries below. "Check for data breaches" on a
  login sends the first 5 hex digits of the password's SHA-1 to `api.pwnedpasswords.com` (k-anonymity,
  padded responses, no cookies, no referrer; `src/ui/pwned.ts`). It needs no new permission (the broad
  host permission already covers it) and nothing runs automatically. Maps links go to OpenStreetMap
  only when the user opens them.
- **Website icons tell the server which sites the vault holds.** Off by default. When on, the popup asks
  `<server>/icons/<host>/icon.png` for every login, so the server (and a proxy in front of it) sees those hosts in
  clear text, which the encrypted URIs otherwise hide. Redirects are followed (`src/ui/favicon.ts`): when the
  server's icon service redirects (Vaultwarden's `ICON_SERVICE=google`, `duckduckgo`, ...), that third party sees
  the hosts too, as the server admin configured. Requests carry no cookies and no referrer.
- **Forwarded email aliases call a third-party service, on an explicit click only.** The generator sends
  the service's API token plus the current page's origin (no path, query or fragment) to the selected forwarding service
  (`src/background/alias.ts`); nothing runs automatically and no vault data is included. Tokens are kept
  per service in `storage.local`, encrypted with the user key (readable only while unlocked), so switching the
  selected service cannot send one service's token to another, and they are removed on logout. A self-hosted base URL must be https, or
  plain http on loopback; unlike the official client there is no "trust this unsafe URL" override, so a
  LAN forwarding service over http is refused.
- **The list carries two derived flags, not secrets.** `reused` (how many items share a password) and
  `weak` are computed in the worker (`listVault`) and shipped on list entries so the popup can filter
  by them without ever receiving a password. They are not part of what the inline menu / save bar get.
- **Values the user reveals can be re-shown.** Large Type, QR code and "Share as a Send" take the
  value the item view already holds; they sit behind the same re-prompt gate as viewing the item.

- **Master password re-prompt (`reprompt`) is enforced, with one exception.** Items flagged in the web
  vault are gated in the service worker for the item view (and therefore editing), copy, TOTP, filling
  (popup, inline menu and "fill the first match"), passkey assertions (`passkeyDecision` in
  `src/background/passkey.ts`) and attachment downloads — see `src/background/reprompt.ts`. Page-load
  autofill skips flagged items entirely. **Not** covered: an org policy that forces the flag is only
  honored as far as Vaultwarden reports it on each cipher.
- **`clipboardRead` and `unlimitedStorage`.** The clipboard is read only by the timed clear (invariant 13), to
  avoid erasing something the user copied after a secret; nothing read is stored or sent. `unlimitedStorage`
  lifts the 10 MB `storage.local` quota for the encrypted vault cache, which is a single value: over the quota
  a sync could not store it and the vault would not load. It grants no access to anything.
- **The extension holds broad host permissions** (`https://*/*`, `http://*/*`) because autofill needs to
  inject into arbitrary sites. It is the largest standing privilege we have; do not add more without a
  written reason.
- **Attachment downloads never follow a redirect** and must stay on the configured server's origin
  (`src/transport/vault.ts`). The SSRF surface is the configured server only; the price is that an
  attachment store that redirects (e.g. S3) cannot be downloaded from.
- **Cards and identities are listed on every site**, as in the official clients, and fill only on a click in the
  inline menu or the popup. A page cannot get that click by covering or hiding the menu (`guardClicks`, invariant 4).
- **RUSTSEC-2023-0071 (Marvin timing attack on `rsa`) is ignored in `deny.toml`.** The crate arrives through
  `bitwarden-crypto` and still had no patched release when checked on 2026-11-06. Its RSA decryptions run only in
  the offscreen worker, but the ciphertexts come from the server, which is the attacker this file assumes:
  organization keys on every sync and the wrapped key of a "log in with device" answer. The attack needs a very
  large number of decryptions timed precisely. Warren decrypts each of those once per sync or request, and the
  server sees at most when the next request arrives, with network jitter in the way, so it gets nowhere near enough.
  Check again at every `UPSTREAM_SYNC`, and remove the ignore once `rsa` ships a fix.
