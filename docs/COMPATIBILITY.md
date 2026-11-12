# Compatibility notes

Warren supports **only the latest Vaultwarden release**; CI runs every e2e step against `vaultwarden/server:latest`.
Older releases are neither tested nor supported. The notes below record what was verified and on which release.

Facts verified against **Vaultwarden 1.37.4** (`vaultwarden/server@sha256:efb3cde9…`, local Docker)
on 2026-10-29, unless marked otherwise.

## Server identity / capability detection

* `GET /api/config` → `version: "2026.6.0"` (the Bitwarden-server level Vaultwarden claims),
  `server.name: "Vaultwarden"`, `settings.disableUserRegistration`, `featureStates{...}`.
  Use `version` for capability gating (e.g. cipher key encryption needs ≥ 2024.2.0).

## Headers

* `Device-Type: 2` (ChromeExtension). Vaultwarden reads the lowercase `device-type` header and
  falls back to UnknownBrowser.
* `Bitwarden-Client-Version` must parse as semver on routes that use the `ClientVersion` guard.
  We send `2026.10.1` (browser-v2026.10.1 pin). `Bitwarden-Client-Name: browser`.
  The official client (`libs/common/src/services/api.service.ts` at the `clients` pin) sends the same three, plus
  `Bitwarden-Package-Type` when it has a package type, and `Cache-Control: no-store` / `Pragma: no-cache` on GET;
  Warren gets the same effect on its requests to the server from `fetch(..., { cache: "no-store" })`
  (`src/transport/http.ts`, `src/transport/vault.ts`).

## Registration (test harness only)

* `POST /identity/accounts/register/send-verification-email {email, name}` returns the
  verification token directly (JSON string) when mail is disabled.
* `POST /identity/accounts/register/finish` accepts the "old" flat shape:
  `email, emailVerificationToken, masterPasswordHash, key, kdf, kdfIterations, kdfMemory,
  kdfParallelism, userAsymmetricKeys{publicKey, encryptedPrivateKey}`. The newer
  `masterPasswordAuthentication/masterPasswordUnlock` shape is also accepted (not tested yet).

## Prelogin

* `POST /identity/accounts/prelogin {email}` → camelCase:
  `kdf, kdfIterations, kdfMemory, kdfParallelism, kdfSettings, salt`.

## Token

* `POST /identity/connect/token` (form-encoded). Password grant fields used:
  `grant_type=password, username, password=<ServerAuthorization hash>, scope="api offline_access",
  client_id=browser, deviceType=2, deviceIdentifier=<uuid>, deviceName`.
* Response keys are **PascalCase** except the OAuth ones:
  `AccountKeys, ForcePasswordReset, Kdf, KdfIterations, KdfMemory, KdfParallelism, Key,
  MasterPasswordPolicy, PrivateKey, UserDecryptionOptions, access_token, expires_in,
  refresh_token, scope, token_type`.
* `UserDecryptionOptions.MasterPasswordUnlock` = `{Kdf{KdfType,Iterations,Memory,Parallelism},
  MasterKeyEncryptedUserKey, MasterKeyWrappedUserKey, Salt}` (PascalCase, nested).
* Refresh grant: `grant_type=refresh_token, client_id, refresh_token` → only
  `access_token, expires_in, refresh_token, scope, token_type`.
* JWT `sub` is the user id (needed for `encryptedFor`, below).

## Sync

* `GET /api/sync?excludeDomains=true` → camelCase: `ciphers, collections, domains, folders, object,
  policies, policiesNew, profile, sends, userDecryption`.
* `userDecryption.masterPasswordUnlock` is the camelCase twin of the token's
  `UserDecryptionOptions.MasterPasswordUnlock` (`kdf{kdfType,iterations,memory,parallelism}`).
  → Validators must be case-insensitive.

## Breach lookups

* `GET /api/hibp/breach?username=<email>` proxies Have I Been Pwned with the admin's `HIBP_API_KEY`. 404 means no
  breach. **Without a key it answers 200 with one stand-in entry** whose `dataClasses` is
  `["Error - No API key set!"]`; `emailBreaches` (`src/transport/vault.ts`) turns that into "unconfigured".
  Verified on 1.37.5 by reading `src/api/core/mod.rs` and by an e2e step against a server without a key (the found
  and 404 paths are unit tested with a stubbed fetch).

## Ciphers

* Cipher JSON is camelCase and already includes new item types:
  `bankAccount, driversLicense, passport, sshKey, archivedDate, permissions`.
* **No premium gate.** Vaultwarden returns `premium: true` for every user and `usersGetPremium: true` for every
  organization, so features that are premium upstream (archive, TOTP, attachments, reports) are all open.
  What Vaultwarden does not implement is listed in PARITY_REPORT.md, "Server support, verified against 1.37.5".
* **`POST /api/ciphers` and `PUT /api/ciphers/{id}` require `encryptedFor` (user id)**; without it
  the request fails with 422 (`missing field encryptedFor`). Added in the web-v2025.6.0 protocol.
* `DELETE /api/ciphers/{id}` hard-deletes; `PUT /api/ciphers/{id}/delete` moves to trash (sets
  `deletedDate`, verified). Warren only uses the trash.
* `PUT /api/ciphers/{id}` with `lastKnownRevisionDate` (ISO 8601) is refused with "The client copy of
  this cipher is out of date" when the server copy is more than 1 s newer (verified).
* Folders: `POST /api/folders {name: EncString}`; sync returns them encrypted under the user key.
* `GET /api/accounts/revision-date` → integer (ms since epoch).

## CORS and two-step login (verified in Phase 1)

* **CORS allows only `DOMAIN`, `file://` and the desktop origin**, never `chrome-extension://`
  (`src/util.rs` `Cors::get_allowed_origin`). The extension therefore needs a host permission for the
  server; since the parity work the `https://*/*` / `http://*/*` host permissions are required at
  install, which covers it.
* 2FA challenge: HTTP 400 `{"error":"invalid_grant","TwoFactorProviders":["0"],
  "TwoFactorProviders2":{"0":null,"1":{"Email":"a***@x"}}}`. Provider ids arrive as strings.
* Retry with form fields `twoFactorProvider`, `twoFactorToken`, `twoFactorRemember=1`; success adds
  `TwoFactorToken`, which later logins send as provider `5` (Remember) instead of a code.
* A wrong code returns Vaultwarden's generic error body: `error_description` is `""`, the text is in
  `message` / `ErrorModel.Message`.
* A TOTP code cannot be reused within its step (also across enable → login).
* Email 2FA code request: `POST /api/two-factor/send-email-login {email, masterPasswordHash,
  deviceIdentifier}` (no bearer). Implemented, **not covered by e2e** (needs SMTP).
* Unauthenticated endpoints (register, prelogin, send-email-login) share
  `UNAUTHENTICATED_RATELIMIT_*` (default burst 50 / 60 s); the test compose relaxes it.

## Phase 4 (verified against 1.37.4, web vault 2026.7.0)

* **WebAuthn 2FA** (provider `7`): the challenge is `TwoFactorProviders2["7"]` (webauthn-rs request
  options, base64url). Vaultwarden deletes it on every attempt, so a failed try needs a fresh password
  grant to get a new one. The assertion is produced by the server's own
  `webauthn-connector.html` in an iframe (v2 `data` param, `parent` = our page): `*connector.html`
  is served without CSP/X-Frame-Options, so an extension may frame it. The token is the connector's
  JSON (`clientDataJson` spelling). The legacy U2F `appid` extension must be https: on plain-http
  servers browsers reject the whole request ("invalid domain"), so we drop it there.
* **Send**: secret = 16 random bytes, wrapped with the user key in `key`; content key =
  `derive_shareable_key(secret, "send", Some("send"))`; link = `<server>/#/send/<accessId>/<base64url
  secret>`; password = base64 PBKDF2-SHA256(password, secret, 100000). File sends:
  `POST /api/sends/file/v2` (with `fileLength` of the ciphertext) then multipart
  `POST /api/sends/<id>/file/<fileId>`, field `data`, filename = the **encrypted** file name.
  Recipients use `grant_type=send_access` (`send_id` = accessId, `password_hash_b64`) and then
  `POST /api/sends/access` with that bearer token. The web vault refuses plain-http servers
  ("Insecure URL not allowed"), so it cannot open links on the http test server.
* **Passkeys**: always on (no setting), like the official extension. Stored in
  `login.fido2Credentials[]` with the SDK's `CipherFido2CredentialModel` field names (all fields
  EncStrings except `creationDate`; GUID credential ids; base64url PKCS#8 `keyValue`; base64url
  `userHandle`; counter `"0"`; an imported one with a higher counter is raised by one and saved before each assertion,
  as the official clients do). Saved through the normal cipher PUT/POST; Vaultwarden keeps them.
  WebAuthn calls are intercepted on every secure origin: a call a stored passkey can answer opens
  Warren's approval window, anything else goes straight to the browser. Conditional mediation
  (passkey autofill) is raced against the browser and additionally shows "Sign in with passkey" in
  the inline menu. `getClientCapabilities()` reports `conditionalGet`, `passkeyPlatformAuthenticator`,
  `userVerifyingPlatformAuthenticator` and `extension:credProps` on top of the browser's answer. A call whose RP ID fails Warren's check (not the host or a registrable parent; Related Origin
  Requests are not implemented) goes to the browser before any window opens. New passkeys carry Bitwarden's AAGUID (`d548826e-79b4-db40-a3d8-11116f7e8349`) with `none`
  attestation, as the official extension does.
* **SSO** (`SSO_ENABLED`): `GET /identity/sso/prevalidate` fails when off. `/identity/connect/authorize`
  with `client_id=browser` always redirects to `<DOMAIN>/sso-connector.html` (any `redirect_uri` is
  ignored) and needs the `VW_SSO_BINDING` cookie from the same browser. Code + PKCE verifier go to
  `grant_type=authorization_code`; the response matches the password grant (Key, KDF,
  `UserDecryptionOptions.HasMasterPassword`). An existing password user is linked by email on first
  SSO login (`SSO_SIGNUPS_MATCH_EMAIL` default). A `:clientId=browser` suffix on `state` keeps the
  connector page from starting a web vault login.

## Parity work (verified against 1.37.4 by the e2e suite unless marked otherwise)

* **YubiKey OTP 2FA** (provider `3`): a typed 44-character code sent as `twoFactorToken`. Vaultwarden
  checks it with Yubico's servers (`YUBICO_CLIENT_ID`/`YUBICO_SECRET_KEY`), so the e2e test stands in
  for the server's 2FA answer and only checks what we send. **Not verified with a real key.**
* **Send edit**: `PUT /api/sends/<id>` takes the full `SendData` again with the same `key` (the link
  stays valid). A missing `password` keeps the current one; removing it is
  `PUT /api/sends/<id>/remove-password` (read in 1.37.4 `sends.rs#put_remove_password`, used by the
  edit form; **not yet exercised by the e2e suite**). Text sends must carry `text` (so text and
  `hidden` are editable); a file send's `file` is ignored (immutable). `disabled: true` makes
  `send_access` fail.
* **Website icons**: `GET <server>/icons/<host>/icon.png` answers 200 `image/png` for any host,
  falling back to a generic icon (also for `localhost`).
* **Attachments**: `GET /api/ciphers/<id>/attachment/<attId>` → `{url}` (signed, absolute, no bearer
  needed); the body is an EncArrayBuffer under the attachment's own key (`attachments[].key`, wrapped
  with the cipher key, else the org/user key); `fileName` uses the cipher's field key. Upload:
  `POST /api/ciphers/<id>/attachment/v2 {key, fileName, fileSize}` → `{attachmentId, …}`, then
  multipart `POST /api/ciphers/<id>/attachment/<attachmentId>` with field `data`.
* **Organizations**: `profile.organizations[]` carries `key` (type 4, RSA-OAEP-SHA1 to the user's
  public key) and the plain `name`; `collections[]` names are EncStrings under the org key. The test
  harness creates an org with `POST /api/organizations {name, billingEmail, planType: 0,
  collectionName, key, keys{publicKey, encryptedPrivateKey}}` and an org item with
  `POST /api/ciphers/create {cipher (with encryptedFor), collectionIds}`; the extension decrypts both.
* **Import**: `POST /api/ciphers/import {ciphers[] (each with encryptedFor), folders[{name}],
  folderRelationships[{key: cipherIndex, value: folderIndex}]}`; folder ids the user does not own
  become new folders. **Export** re-checks the master password with
  `POST /api/accounts/verify-password {masterPasswordHash}` (400 when wrong).
* **PIN**: client-only (bitwarden-crypto `PinKey`: the PIN through the account KDF with the email as
  salt, stretched; wraps the user key). Nothing goes to the server.

## 1.37.5 (verified by the full e2e suite on 2026-11-03, SSO steps excepted)

* Enabling two-step methods needs a verification token: `POST /api/two-factor/get-authenticator` (or
  `get-webauthn`, `get-email`) with `masterPasswordHash` returns `userVerificationToken`, which the enable call
  (and `get-webauthn-challenge`) must send instead of the hash. The authenticator token is bound to the key the
  server picked, so the client cannot choose its own key. Warren never enables 2FA; only the e2e setup does.
* `get-webauthn-challenge` wraps the creation options: `{ "options": { …, "status": "ok" } }`.
* `send-email-login` without an auth request now needs a pending login (`TwoFactorIncomplete`) for the sent
  `deviceIdentifier`: request it only after the password step answered "two-step required", with the same device id
  (Warren already does).
* Updating a cipher whose organization differs from the server's copy fails with "Organization mismatch. Please
  resync the client": sync before retrying.

## Push and auth requests (read from the 1.37.5 source, not yet covered by e2e)

* `/notifications/hub?access_token=<jwt>`: SignalR MessagePack only (`{"protocol":"messagepack","version":1}\x1e`,
  answered with `{}\x1e`). Updates are `[1, {}, nil, "ReceiveMessage", [{ContextId, Type, Payload}]]`, length-prefixed.
  The server pings every 15 s and drops a client silent for 30 s; it echoes any binary frame we send (our SignalR ping).
* `POST /api/auth-requests` answers 400 unless the `deviceIdentifier` is already a device of that account with the
  same `Device-Type`: log in with device works only in a browser that logged in with the master password before.
* `GET /api/auth-requests/<id>/response?code=` must come from the requesting IP and device type. A denied request is
  deleted (400 afterwards). The token grant must happen within 5 minutes of the request and runs 2FA;
  `send-email-login` takes `authRequestId` + `authRequestAccessCode` instead of `masterPasswordHash`.
* `PUT /api/auth-requests/<id>` needs `key` even to deny (we send `""`).

## Not yet verified

* Organization items: edit/trash/restore follow the server's per-item `edit` flag (`PUT /api/ciphers/<id>`), covered by e2e for an org owner only; members with limited permissions, `viewPassword: false` and creating org items (`/api/ciphers/create` + `collectionIds`) are untested/unsupported.
* V2 "blob" ciphers (`data` = `{"format_version":1,"wrapped_cek":...}`): present in sdk-internal test vectors;
  whether Vaultwarden stores and returns them is unknown. (Cipher key encryption, a `key` on new, cloned and imported
  items, is covered by the e2e suite.)
* Round-trip with the official `bw` CLI (contract test b): not done.

## Chromium 156 (verified in Playwright Chromium 156.0.8078.4)

* MV3 extension with `minimum_chrome_version: "156"`, module service worker, CSP
  `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'` loads and instantiates WASM in an
  offscreen document. The shipped CSP is stricter (`object-src 'none'` plus Trusted Types, `src/manifest.json`).
* `chrome.offscreen.hasDocument()` exists (docs: Chrome 150+), used by `src/background/core.ts`.
* Offscreen reasons: no reason fits "hold secrets in memory"; Warren opens the document with `WORKERS` (the crypto
  worker) and `CLIPBOARD` (the timed clear), `src/background/core.ts`.
