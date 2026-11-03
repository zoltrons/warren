# Changelog

All notable changes to Warren. Versions match the `v*` release tags.

## 0.0.2 — 2026-11-03

### Security

- **App URIs no longer match websites.** Domain and Host matching read every saved URI as a web address, so an
  Android app URI such as `androidapp://com.ebay.mobile` matched the website `ebay.mobile`. Anyone who registered
  such a domain could be offered the app's login in the inline menu, or have it filled with page-load autofill.
  Only `http(s)` URIs, and URIs without a scheme, take part in these match strategies now.

### Fixed

- **Save bar:** a login whose username differs only in letter case from a saved one, or that is saved only in a
  read-only (e.g. organization) item, is no longer offered as a new login. Saving it used to create a duplicate.
- **Passkeys:** an item holding a passkey with a malformed credential id no longer makes signing in with another
  passkey of the same item fail.

### Changed

- `docs/SECURITY.md` now states that passkey sign-ins from items flagged for master-password re-prompt are gated
  like every other use of the item, as the code already did.
- Internal clean-up: helpers used only in their own module are no longer exported; an unused constant was removed.
- The e2e suite covers the letter-case save bar case; it passes against Vaultwarden 1.37.5, the current `latest`.

## 0.0.1 — 2026-11-03

First release: a Bitwarden-protocol client for self-hosted Vaultwarden (latest release only), for Chromium 156+.
