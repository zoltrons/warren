<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="brand/logo-horizontal-dark.svg">
    <img src="brand/logo-horizontal-light.svg" alt="warren" width="320">
  </picture>
</p>

<p align="center"><b>Made for Vaultwarden.</b></p>

Warren is a small, quick password manager for Chromium browsers that talks to one server: your own
[Vaultwarden](https://github.com/dani-garcia/vaultwarden). No account elsewhere, no telemetry, no UI framework.
Your vault is decrypted only in memory and locks itself when you walk away.

> [!WARNING]
> **Warren is in early testing and may not be ready for wide use.** It is provided as is, without warranty of any
> kind, and the authors accept no liability for lost data or any other damage (GPL-3.0 sections 15 and 16). Keep an
> export of your vault and another client at hand.
>
> Warren is an unofficial client and is not affiliated with Bitwarden, Inc. or the Vaultwarden project.

**Server:** the latest Vaultwarden release only. Older releases are neither tested nor supported.

## What it does

- Logins, cards, identities, secure notes and SSH keys: view, edit, search, folders, favorites, trash.
- Autofill from the popup, `Ctrl+Shift+L` (`⌘⇧L` on macOS), the context menu or an inline menu on the field;
  offers to save or update a login after you sign in.
- Passkeys: creates and uses passkeys stored in your vault.
- TOTP codes, password and username generator, email aliases, Send, attachments.
- Unlock with the master password, a PIN or biometrics (WebAuthn PRF); two-step login (authenticator, email,
  YubiKey, WebAuthn) and SSO.
- Import and export in Bitwarden JSON (unencrypted).

## Install

Chromium 156 or newer. Download `warren-vX.Y.Z.crx` from the
[latest release](https://github.com/zoltrons/warren/releases/latest). Stock Chrome refuses hand-installed `.crx`
files; [docs/UPDATES.md](docs/UPDATES.md) shows how to install through browser policy so it also keeps itself up
to date. For a quick look, unzip `warren-vX.Y.Z.zip` and use **Load unpacked** on `chrome://extensions`.

## Build

Needs Node 24, rustup, `wasm-bindgen-cli` at the version in `upstream.lock` and binaryen (`wasm-opt`, installed by `npm ci`).

```sh
npm ci
npm run build:wasm          # Rust crypto + autofill engine → dist/wasm
node tools/fetch-psl.mjs    # public suffix list, once
npm run build               # → dist/ext, load it unpacked
npm run check               # types + unit tests
```

More commands (Rust tests, e2e against a real Vaultwarden, UI preview) are in [AGENTS.md](AGENTS.md).
How it is put together: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). What has to stay true:
[docs/SECURITY.md](docs/SECURITY.md).

## Credits and license

Warren speaks the Bitwarden client protocol and uses Bitwarden's
[`bitwarden-crypto`](https://github.com/bitwarden/sdk-internal) crate under its GPL-3.0 option. Icons in the
interface come from Lucide (ISC). Details: [docs/LICENSING.md](docs/LICENSING.md).

Warren is free software under the [GNU GPL v3](LICENSE) (GPL-3.0-only); third-party notices are in
[NOTICE](NOTICE). It is not a fork: it is written from scratch, and other password managers are idea references
only. Their code is never copied.
