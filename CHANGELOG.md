# Changelog

All notable changes to Warren. Versions match the `v*` release tags.

## 0.0.3 — 2026-11-03

### Security and privacy

- **Usage data is encrypted.** Sites you chose "Never save" for, which items you fill and open, the generator's
  options and the username generator's address and domain used to sit in clear text on disk. They are now
  encrypted with your account key, readable only while the vault is unlocked, and removed on logout. A custom
  passphrase word list is encrypted too and never goes back to the popup. Clear text from older versions moves in
  on the first unlock after the update and is then deleted.
- **"Log out" as the timeout action keeps the refresh token in memory only**, like the official clients: nothing
  on disk for a copied browser profile to use, and the session ends when the browser closes.
- **Encrypted values are padded before encryption**, so their size no longer gives away a password's or PIN's
  length (generator history, the stored PIN, alias settings, usage data). Older values are re-padded on the next
  unlock.
- **Secure notes no longer show their first line** in the vault list; a note's content leaves the crypto worker
  only when the note is opened.
- **Settings changes no longer overwrite each other** when two are made in quick succession.

### Added

- **Next one-time code:** a login's item view shows the code that comes next, highlighted in the last 10 seconds,
  and its menu can copy it.
- **Pure black theme** for OLED screens (Settings › Theme).
- **Card network marks:** cards show a Visa, Mastercard, Amex, Discover, Diners Club, JCB, Maestro, UnionPay or
  RuPay mark, from the brand field or the number's first digits, worked out on the device. Maestro and RuPay are
  also recognised when filling in a new card's brand.
- **Passkey creation date:** a login with a passkey shows "Passkey — Created <date>", like the official clients,
  instead of "Passkey available".
- **"Recently opened"** can be hidden and cleared in Settings › Vault, or cleared from the list itself.

### Changed

- **Generator:** a new icon; length has −/+ buttons next to the slider; character sets are one row of chips;
  minimum counts are in a collapsible section with steppers; the passphrase separator is picked from a list
  (hyphen, space, period, comma, underscore, none), with typing a custom one as the last option.
- **Website icons** that would be invisible on the current theme (a black logo on a dark theme, a white one on the
  light theme) get a contrasting backdrop.
- **PIN setup:** turning "Unlock with PIN" back off before saving a PIN works again; the option to ask for the
  master password after a browser restart sits under the PIN switch and explains itself.
- **Item view:** field icons line up with their label and value; every website row has its "more" menu.

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
