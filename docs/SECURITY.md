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
   as well, once per document: a page's script could already have added it before load. "Submit after
   filling" is off by default, needs a fill the user asked for (never page load, never a lone code), goes to
   one frame at most, and clicks only a submit button or one that says it logs in. Per-site recipes are compiled
   in; nothing about autofill is downloaded. `data-warren-autofilled` tells a page that a field was filled, which it
   can see anyway from the value appearing.

4. **An iframe of ours is not an authority.** `menu.html`/`bar.html` are web-accessible, so any site can
   frame them. Both carry a per-document secret (menu: from `content.js` via the URL fragment, inside a
   closed shadow root; bar: issued by `showBar`): without it the worker refuses, so a copy the page
   frames itself cannot read the list or drive a fill/save.

5. **Only the service worker may talk to the offscreen document.** `sender.url === background.js`,
   `sender.tab` absent (`src/offscreen/offscreen.ts`). Conversely the worker answers only its parent.

6. **Vault secrets are never written unencrypted to disk.** `storage.local` holds the encrypted cache, the
   protected user key, the wrapped PIN, an encrypted generator history and encrypted alias settings. The refresh token and the 2FA
   remember tokens are the exception, see Known gaps. Access tokens, and a typed password waiting in the
   save bar until it expires or the vault locks, live in `storage.session` (memory only); the decrypted
   vault lives in the crypto worker. Both stores are set to `TRUSTED_CONTEXTS` on *every* worker start, so
   content scripts cannot read them.

6a. **What the user does is encrypted too.** Never-save hosts, last-fill and last-open stamps, generator options,
    the username generator's address and domain sit in one EncString (`storage.local` "private",
    `src/background/private.ts`); a custom passphrase list in another ("wordlist"), which never goes back to the
    popup. They are read and written only while unlocked, writes are serialized, a record that does not decrypt
    is never written over, and logout removes both. Everything we encrypt ourselves (these, generator history,
    alias settings, the stored PIN) is padded to fixed blocks first (`src/background/seal.ts`), like the
    official clients' padded packer, so a ciphertext's length does not give away a password's or PIN's length
    or a record's size; values from older builds are re-padded on the next unlock. Clear text left by older builds moves in on the next unlock
    and is deleted only after the encrypted copy is written. Clear text that stays, because it is needed while
    locked or before the first render and says nothing about the vault: `settings` (lock, autofill and UI
    switches), server URL, account email, device id, and in the extension's `localStorage` only the theme, the
    list's sort order, the notes formatting switch and whether "Recently opened" is shown.

7. **The server is not trusted with URLs.** `http://` is refused except for loopback
   (`src/shared/url.ts`), the API client sends `credentials: "omit"`, `redirect: "error"`, and an
   attachment download URL must be on the configured server (`src/transport/vault.ts`). Response bodies
   are bounded (`readBytes` in `src/transport/http.ts`).

7a. **The server cannot weaken the KDF.** It chooses the account's KDF (prelogin and token response) and receives the
    hash the KDF produces, so a hostile server could ask for PBKDF2 at 5000 iterations and crack the master password
    offline. Every KDF from the server passes `guardKdf` (`src/background/account.ts`, rules in `kdf.ts`) before a hash
    made with it is sent or stored: the strongest KDF an account was seen with on this browser is kept per
    SHA-256 of `kdf|<server>|<email>` (also after logout), and a weaker one is refused unless it is still a safe
    setting (PBKDF2 600 000, Argon2id 64 MiB x 3), which lets a user lower a very high KDF on purpose. PBKDF2 below
    100 000 iterations is refused outright, also on a first login with no floor yet (`PBKDF2_MIN`), and settings
    flag any KDF below the safe setting.

8. **2FA state is scoped and short-lived.** Remember-device tokens are keyed by a SHA-256 of `<server>|<email>` (no clear-text email left after logout) so
   they are never replayed to another server; a pending 2FA login holds a master-key handle, so an
   abandoned attempt is freed when it expires, by an alarm that needs no open popup (`PENDING_ALARM`).

8b. **Every unlock path ends in the same place.** Master password, PIN and biometrics all go through
    `afterUnlock` (`src/background/account.ts`), which sets `unlocked` and arms the auto-lock, so no path
    can unlock without the lock timer. A lock always wins over an unlock in flight: `lockNow` bumps `lockEpoch`
    first, and every login, unlock and re-prompt grant checks the epoch it started with right before it writes
    `unlocked` (or grants); one a lock overtook locks again instead. PIN and biometric material is stored only as a *wrapped* user key
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

10a. **A login's URIs are bound to it.** Field MACs do not stop a server from moving one ciphertext of an item into
    another field. For an item with its own key, a URI whose `uriChecksum` (SHA-256 of the URI, encrypted with the
    item) does not match is dropped on decrypt, as upstream does (`crates/core-wasm/src/cipher.rs`), so a server
    cannot point a login at another site.

11. **Passkeys are bound to the origin.** `checkRpId` requires the RP ID to be the origin's host or a
    registrable parent, on a secure origin, and never a public suffix — including when the page's own
    host *is* the public suffix. Signing happens in the worker, and the private key never leaves it: `getCipher`
    hands out items without `keyValue` and `prepareSave` restores it from the same item only
    (`src/offscreen/passkey-keys.ts`), so a clone does not copy a passkey.

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
    actually happened — never after a failed copy that would otherwise erase the user's clipboard.

14. **Locking tears down in-page UI.** Auto-lock, logout and login call `lockNow`, which closes the
    inline menu and save bar in every tab: those frames show decrypted item names, so they must not
    survive the lock. The popup/side panel follow the session in `chrome.storage.session` and drop their
    decrypted state on the same event.

## Cryptography direction

Rules for every new or changed piece of cryptography. Within what Vaultwarden can read, they put
password hardness and post-quantum safety first. A change that breaks one of them needs a written reason here.

1. **Argon2id for every secret derived from something a person types.** Keys only Warren reads (today the PIN key,
   `PIN_KDF` in `src/shared/constants.ts`) use Argon2id with our own parameters, never the account's. No new PBKDF2,
   scrypt or bcrypt. Where the protocol fixes the KDF (the account master key, chosen on the server; Send access
   passwords, PBKDF2 by spec) we follow it and steer the user to Argon2id (the PBKDF2 notice in settings).
2. **Parameters are tuned for current hardware and only go up.** Use as much memory as an unlock in the WASM worker
   allows on a current mid-range laptop at about one second, and never less than RFC 9106's second recommended
   setting (64 MiB, 3 passes). Review them once a year against RFC 9106 and OWASP. The server-side range checks
   (`kdf_from_params`) follow upstream's floors and are never lowered.
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
   is used only for hashes that involve no key.

## Known gaps

- **The refresh token and 2FA remember tokens are on disk in clear text** (`storage.local`), because they must
  survive a browser restart without the master password. Anyone who can copy the browser profile can use them to
  fetch the still-encrypted vault and to change or delete items on the server, but not to read anything. Like the
  official clients, choosing "Log out" as the timeout action keeps the refresh token in `storage.session` only
  (`storeRefreshToken` in `src/background/account.ts`): nothing on disk, and the session ends with the browser
  or an extension update.
- **PIN-only unlock ("Lock with master password on restart" off) puts the vault behind the PIN on disk.** The user
  key wrapped with the PIN key stays in `storage.local` (`setPin` in `src/background/account.ts`). The 5-try cap only
  holds inside Warren: from a copied profile the PIN can be tried offline. Each try costs Argon2id at `PIN_KDF`
  (256 MiB, 3 passes, `src/shared/constants.ts`) whatever the account KDF is, so guessing is slow and memory-bound,
  but a short numeric PIN still falls and the whole vault with it. The setting's hint says so; the default keeps
  the cap real. Keys from builds before `PIN_KDF` are re-wrapped on the next unlock.
- **Plain text passes through the service worker and the popup in a few places.** The fill data, a TOTP code, the
  full item for the popup and for a save-bar update go through the service worker in transit; it does not keep
  them. The popup holds an opened item (never a passkey's private key, invariant 11) because editing sends the whole
  item back. Checks that need no secret use `cipherSummary`.
- **Updates are only as trustworthy as the release pipeline.** Installed copies follow
  `releases/latest/download/updates.xml` (`docs/UPDATES.md`). The browser verifies each `.crx` against the
  extension's key, so a build signed with another key is refused, but anyone who can push a `v*` tag and read
  `CRX_KEY` can ship code to every installed copy. Keep that secret and the repository's write access tight.
  What the pipeline can do about it: every action is pinned by commit SHA and linted by `zizmor`, build tools
  come from lockfiles, the job that holds `CRX_KEY` installs nothing and runs no package code or browser (the CRX is
  signed by `tools/pack-crx.mjs` on `node:crypto`) and refuses a key that does not give Warren's extension id, a release needs a green `ci` and a
  clean advisory check, and each released file carries signed build provenance (`docs/UPDATES.md`). Provenance
  shows which commit and run built a file; it cannot tell a malicious tag from a real one.

- **The push connection carries the access token in its URL.** Browsers cannot set headers on a WebSocket, so
  `/notifications/hub?access_token=…` (`src/background/push.ts`) is how the official clients connect too. A proxy that
  logs query strings records a token that is valid for up to two hours. It reaches only the configured server
  (invariant 7). While an account is logged in the connection, and with it the service worker, stays up.

- **The inline menu's "Sign in with passkey" signs in without a window.** Picking the entry is the
  decision: with exactly one matching passkey `openConditional` (`src/background/passkey.ts`) asserts
  right away. Several passkeys (a choice to make) or a `reprompt`-flagged item open the approval
  window instead, so the flag is never bypassed by this path. The request is still tied to the
  frame's per-document nonce and the browser-reported origin (invariants 1 and 4).

- **One request leaves for a third party, on an explicit click only.** "Check for data breaches" on a
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
- **The extension holds broad host permissions** (`https://*/*`, `http://*/*`) because autofill needs to
  inject into arbitrary sites. It is the largest standing privilege we have; do not add more without a
  written reason.
- **Attachment downloads never follow a redirect** and must stay on the configured server's origin
  (`src/transport/vault.ts`). The SSRF surface is the configured server only; the price is that an
  attachment store that redirects (e.g. S3) cannot be downloaded from.
- **Cards and identities are listed on every site** (parity with the official clients) and fill on an
  explicit click.
- **RUSTSEC-2023-0071 (Marvin timing attack on `rsa`) is ignored in `deny.toml`.** The crate arrives through
  `bitwarden-crypto`, has no patched release, and its RSA operations run only locally in the offscreen worker,
  where no remote party can observe their timing. Remove the ignore once `rsa` ships a fix.
