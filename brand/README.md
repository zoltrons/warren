# Warren brand

**Name:** Warren in prose, `warren` in identifiers. **Tagline:** "Made for Vaultwarden." (tr: "Vaultwarden için yapıldı.")
**Voice:** warm, plain, a little playful; never corporate.
"Vaultwarden" appears only descriptively ("for Vaultwarden", "works with Vaultwarden"), never in the name or a logo.
No Bitwarden logo, shield or name in anything a user sees, except the attribution and the "Bitwarden JSON"
format name. Never put the rabbit inside a shield. No orange.

## Files

| File | What |
|---|---|
| `icon.svg` | **Master** icon: a padlock body that is also a rabbit head, ears as the shackle |
| `wordmark.svg` | **Master** wordmark `warren`: hand-drawn rounded strokes, no font, pink `w` |
| `icon-light.svg`, `icon-locked.svg`, `icon-loggedout.svg`, `logo-horizontal-{dark,light}.svg` | Generated |
| `../src/icons/*.png` | Generated: manifest sizes and the toolbar icon per lock state |

Edit only the two masters, then run `node tools/icons.mjs` (add `--sheet out.png` for a contact sheet of
16/32/48/128 on light and dark toolbars). At 19 px and below the inner ears are dropped so the silhouette stays clean.

## Palette

| Role | Name | Hex |
|---|---|---|
| Vivid | Ear pink | `#FF4F7B` |
| Deep accent | Raspberry | `#C2113F` |
| Dark ground | Night cherry | `#2A0A1A` |
| Light ground / rabbit | Snow | `#FFF7F8` |
| Soft | Blush | `#FFD3DC` |
| Sparkle (small badges only) | Gold | `#FFC83D` |

Text on a pink fill is night cherry (5.8:1). White text only on raspberry (6.1:1). Snow on pink (3.0:1) is for
large or decorative marks only; night cherry and raspberry are never paired. `tools/check-contrast.mjs` checks
these and every theme token pair; it runs in `npm run check`.

## Store listing

**Title:** Warren: Vaultwarden Client

**Short description:** Made for Vaultwarden. A small, quick password manager that lives in your browser and talks
only to your own server.

**Description:**

> Warren is a password manager for people who run their own Vaultwarden. Point it at your server, sign in, and
> your logins, cards, passkeys and one-time codes are a click away. It fills forms, offers to save new logins,
> generates passwords, and locks itself when you step away. Your vault is decrypted only in memory and Warren
> talks to nobody but your server.
>
> Works with the latest Vaultwarden release.
>
> Warren is in early testing and may not be ready for wide use. It is provided as is, without warranty; the
> authors accept no liability for lost data or any other damage. Warren is an unofficial client and is not
> affiliated with Bitwarden, Inc. or the Vaultwarden project. License: GPL-3.0.

**Cover image (direction only, not produced):** night-cherry field, the icon large on the left with a soft blush
glow behind it, the horizontal `warren` wordmark and the tagline in snow on the right. One small gold sparkle
near an ear tip at most. No screenshots of other products, no shield shapes, no orange.
