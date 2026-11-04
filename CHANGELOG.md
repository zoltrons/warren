# Changelog

All notable changes to Warren. Versions match the `v*` release tags.

## 0.0.7 — 2026-11-04

### Changed

- **A calmer vault list.** Rows show the name and username; the website, copy and one-time code buttons
  appear on the row under the pointer or keyboard focus (always on touch screens), and an action a login
  has nothing for is left out instead of dimmed. Fill on the current site's logins is a tinted button.
- **Hairlines between rows** in the vault list, item view, settings and generator. They were meant to be
  there all along; a CSS rule erased them.
- **Item view:** the websites follow the credentials; Check for data breaches and the memory practice come
  after them.
- **Icons with one meaning each:** a fill arrow for Fill, history for the generator and password history,
  a calendar for card expiry, a magic wand for the generator, arrows for reordering, and the fingerprint
  for passkeys everywhere.
- **Type and color:** 20 px screen titles, item names in a medium weight, switches and the length slider
  in the brand color, and monogram tiles tinted from the page so none turn muddy in the dark theme.
- New item and New Send are square + buttons. The generator's type chips stay on one scrolling row.
- On the lock screen Log out sits apart from the unlock methods.
- Plainer setting names: "Compact row actions", "Offer cards / identities to fill on the current page",
  "Minimum of each character type", "Practice typing this password".

## 0.0.6 — 2026-11-03

### Fixed

- **Passkey sign-in on Google works.** Google's "Verify it's you" sends a challenge of about 14 000 characters;
  Warren refused anything over 1 024 and the browser's system dialog took over. Challenges up to 64 KiB are now
  accepted (WebAuthn sets no upper limit), so a passkey saved in the vault, by Warren or by the official
  clients, signs in.

### Changed

- The identity generator's name lists are rebuilt from Faker 10.6.0, the release that fixes GHSA-qxc2-j82w-r537
  (Faker is a build-time tool only and was never shipped).

## 0.0.5 — 2026-11-03

### Fixed

- **Passkey sign-ins no longer drop to the system dialog unasked.** When no passkey in the vault answers a
  site's request (Google's "Verify it's you", for example), Warren syncs once and, if there is still no match,
  its window says so, tells whether the vault holds other passkeys for that site, and offers "Use another device
  or browser". Requests for security keys only still go straight to the browser.
- **One-time code countdown:** the seconds sit in the middle of the ring, whatever the font.

### Added

- **Replace a login's passkey:** the passkey save window also lists the site's logins that already hold one
  ("has a passkey"); picking one asks before replacing it.
- **Identity generator by country:** first and family names and cities now come from one country (Türkiye,
  United States, Canada, Germany, Austria, Switzerland, France, Italy, Spain, Portugal or Poland), with a country
  picker. The lists are taken from Faker's locale data and load only when the identity generator opens.

### Changed

- **The next one-time code** is a small pill under the current one, tinted in its last seconds.
- **Identity generator:** the generated name shows in the regular font; the person and the options are separate
  groups.

## 0.0.4 — 2026-11-03

### Fixed

- **Two-step sign-ins get the inline menu.** A lone email or username box whose form says "Continue", "Next" or
  "Sign in" (claude.ai, Microsoft and the like) offers your logins instead of identities.
- **The inline menu no longer vanishes** when two fields are clicked in quick succession.
- **The save bar no longer asks about a login you already have.** The password step of a two-step sign-in (no
  username on the page) is compared with the site's logins, and signing in with the right password after a typo
  drops the save the typo had queued.
- **Passkeys on Google:** a sign-in page that asks for a passkey as it loads ("Verify it's you") gets Warren's
  window instead of the system dialog.
- **The vault list's "On this site" shows right away** instead of after the background sync.
- **Filter chips scroll sideways with a mouse wheel** and keep their place when one is picked.
- A field's generator opened before the saved options loaded no longer switches to a password.

### Added

- **Passkeys can join an existing login:** the save window lists the site's logins without a passkey, next to
  "Save as a new login". A login's passkey is never overwritten.
- **Quick actions on vault rows:** open the website, copy the username, the password and the one-time code (dimmed
  when there is none), with Fill on the right. Settings › "Quick actions as menus" gives a copy menu and a "⋮"
  menu (fill, favorite, website, edit, clone) instead.
- **Click to copy** in the item view: a field's label or value copies it.
- **Identity generator:** a made-up name, birth date in an age range, username, city and country; "Create an
  identity with this" saves it, with the birth date and age as custom fields.
- **Add a generated username as a custom field** from the item editor's generator, named "Email" or "Username",
  so it fills the page field of that name.
- Icons on the locked screen (lock or dial pad) and on "Show as QR code".

### Changed

- **Vault list order:** On this site, Favorites, Recently opened, Cards, Identities, then the rest. A filter keeps
  the site's matching logins on top.
- **Generator:** the length can be typed; minimum digits and symbols follow the length (about one in ten).
- **Dropdowns** open as the app's own menu instead of the browser's plain list.

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
