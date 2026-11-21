# Changelog

All notable changes to Warren. Versions match the `v*` release tags.

## 0.0.22 — 2026-11-21

### Security

- Requests to the server and to alias services send no Referer, like the favicon and breach lookups already did. ([9eb243f](https://github.com/zoltrons/warren/commit/9eb243ff400a688ac5bb432c1d320b8de1198bd0))

### Added

- On a login focused in the list, `Ctrl+C` (`⌘C`) copies its password, `Ctrl+Shift+C` the username and `Ctrl+Alt+C`
  the code, without opening it. ([dd2ca09](https://github.com/zoltrons/warren/commit/dd2ca09a568e7704df41a4118ab0d0d2cccc1d23))
- "Use a strong password" in the inline menu follows the site's rules: the password field's `passwordrules`
  (required and allowed characters, maximum run of the same character, length) and its minlength/maxlength, so the
  password it fills is one the site accepts and is not cut short by the field. ([810d0c4](https://github.com/zoltrons/warren/commit/810d0c4588b09e4f5a35252260574bfdc82caf5a))

### Changed

- Passwords, codes and card numbers are set in Atkinson Hyperlegible Mono, a face drawn so l, 1 and I or O and 0 can't be
  mistaken. It ships inside the extension (18 KB, never downloaded), so it looks the same on every system; before, the
  browser picked Menlo, Consolas or DejaVu depending on the OS. ([69022dc](https://github.com/zoltrons/warren/commit/69022dc011b8d0e7619711f4e73788cd7db3a346))
- A shown password in an item is set larger and a little open (it was smaller than the username), its strength sits
  in a small tinted capsule, and under the pointer it lights its group of four and shows each character's position,
  as the generator does. ([37c0e3e](https://github.com/zoltrons/warren/commit/37c0e3e209577b3050ca88a66ac71edfb8fe36a6))
- A one-time code reads in halves split by a faint dot (123 · 456) instead of a gap that looked like a space; the dot
  is not part of the code, so a selection copies the digits only. ([c763dde](https://github.com/zoltrons/warren/commit/c763ddeb7a6208f34ada2f353ee1caa636d22485))
- An item's websites lead with the host (github.com) and keep the scheme and path quiet, so which site it is reads at a
  glance. ([a886660](https://github.com/zoltrons/warren/commit/a8866604352cd4a6fad930de8607f8ba1f80ced8))
- The generator's "Avoid ambiguous characters" shows the characters it leaves out (l I O 0 1). ([8787510](https://github.com/zoltrons/warren/commit/8787510ba668dcb4bed32b4425668e4f364447e2))
- In an item, a click on the "Next" code copies the next code; it used to copy the current one. ([78d8873](https://github.com/zoltrons/warren/commit/78d8873e8fd75e2e2594648a8af634718362d91b))
- In the generator, a click on the generated value, a suggestion, a history entry or an identity field copies it,
  as a click on an item's field does; only the copy icon did before. ([f34ecf3](https://github.com/zoltrons/warren/commit/f34ecf3e356294ace17061dc341c210d057967eb))
- A wider, brighter palette: six inks (red, green, blue, violet, cyan, yellow) halfway between Dracula's and
  Catppuccin's, each tuned to stay readable on every surface. Status colors, monogram tiles and passwords now draw
  from it instead of saturated one-off hues. ([dad0e19](https://github.com/zoltrons/warren/commit/dad0e198f0ec0055d9c0ae5546378090fede8c1d))
- A shown password is easier to read: digits are blue and symbols red, so look-alikes such as O/0, l/1 and S/$ part
  by hue as well as shape. The generator's line under the value names its digits and symbols in the same colors. ([7c83ceb](https://github.com/zoltrons/warren/commit/7c83ceb69367a731785b9074c323696426892c88))
- The generator's value sits on one line, as large as fits, and is itself the copy button (a click, or Enter and
  Space); one quiet line under it gives the strength, the length and the digits and symbols, and says "Copied" in
  place. Dragging the length makes the value grow or shrink from its end as you go, and a new value settles in left
  to right (not with animations turned off). Regenerate is a small button beside the value. With the pointer on the
  value, the group of four under it is lit and the character shows its position, for typing it in elsewhere. ([8ece044](https://github.com/zoltrons/warren/commit/8ece044095374d1105ebf5045471477803e8ef93))
- In Settings, a click anywhere on a row with a switch flips it, not only a click on the switch itself. ([a86371a](https://github.com/zoltrons/warren/commit/a86371af71d3d46bfdaf3d3780119405d1a61811))
- In an item, a click on an attachment downloads it, and a click on its folder lists that folder's items (the folder
  row carries a › to say it leads somewhere). ([f098799](https://github.com/zoltrons/warren/commit/f098799252a94b2db2fb8db760367a6a449e6164))
- ArrowDown in a field opens its inline menu when it is closed (after Escape or typing), as it does Chrome's own
  dropdown; a second ArrowDown moves into it. ([1578547](https://github.com/zoltrons/warren/commit/15785471b3511ea60c287cc4c1c1a8260b55083d))
- The inline menu steps aside once you type in its field, so it no longer covers the rest of the form, and comes back
  when the field is emptied. ([735334b](https://github.com/zoltrons/warren/commit/735334ba3bbeacc5dbc0eb804fa848a570c6e5d9))

### Fixed

- The keyboard now reaches an item's fields: Tab stops on each one and Enter or Space copies it, as a click does.
  The fields were meant to be focusable but never were. ([c9763ad](https://github.com/zoltrons/warren/commit/c9763adf26d3d8dd16bb9a64ebf732900962f435))
- Live updates resume within a minute after the computer wakes from sleep or changes networks: a connection that
  went silent is noticed (its pings stop coming back) and replaced, and a dropped one reconnects at once instead of
  at the next minute's check. ([dc7c73d](https://github.com/zoltrons/warren/commit/dc7c73dbf961af9e593d1aa0ff588c55741ee4dc))
- A large vault or attachment on a slow connection no longer fails to sync or download after 30 seconds (or 2
  minutes): a request now gives up only once the server has sent nothing for 30 seconds. A connection lost halfway
  through an answer is reported as a network problem instead of an unknown error. ([9eb243f](https://github.com/zoltrons/warren/commit/9eb243ff400a688ac5bb432c1d320b8de1198bd0))
- "Pick from page" no longer names a custom field after an id the site makes up on every load (React's newer ids,
  Angular Material and Headless UI counters), which would not fill next time; it uses the field's name or label. ([984c59c](https://github.com/zoltrons/warren/commit/984c59cda7423aec4202de3ce00fcef90ce193b1))
- Moving to the next field with Tab opens its inline menu; the field left behind used to cancel it on the way. ([4dc5070](https://github.com/zoltrons/warren/commit/4dc50704b7c9faa79c5f8682c646b852e17c4e95))
- An inline menu closed with Escape opens again when you come back to its field with Tab; it used to stay closed
  there until the field was clicked. ([e482a0b](https://github.com/zoltrons/warren/commit/e482a0b91a2f0368ebf56d37d239bdf94ceff1ed))
- The inline menu opens on sign-in forms whose floating label takes the click and focuses the field itself, as many
  Material-style forms do; it used to stay closed there. ([9e06750](https://github.com/zoltrons/warren/commit/9e06750ef6e6cff14b734fc5d4e4bbe883c3e875))
- "Pick from page" picks the field under a floating label, an icon or any box a site draws over it, where it used to
  ignore the click, and so does the context menu's "Copy custom field name". A field inside a frame (a payment
  form's) is lit like any other instead of sitting under the dark layer, and the picker also darkens and outlines fields inside a modal dialog instead of hiding under it. ([3be68bb](https://github.com/zoltrons/warren/commit/3be68bbc7be06b63932a5cf41c99071f4f69ed64))
- While "Pick from page" runs, the page no longer reacts to the pointer: hovering opens no menu over the fields and a
  middle click, right click or tap does nothing on the page. ([3a78cdb](https://github.com/zoltrons/warren/commit/3a78cdb89d7bcbba4d87b31bd9fb31377def1a60))

## 0.0.21 — 2026-11-20

### Security

- Accounts with the new encryption (V2) open only when their signed account state verifies, as in the Bitwarden apps:
  a server cannot leave it out, swap in another account's, or lower its security version. The WebAssembly core grows
  by about 100 KiB for the signature checks. ([ce939a7](https://github.com/zoltrons/warren/commit/ce939a7b359cbfc4272ee067c83873804a99b8f8))
- After "Fill anyway" puts a login into another site, that site can no longer add a passkey to the login through
  the automatic passkey upgrade. ([7b4e5ee](https://github.com/zoltrons/warren/commit/7b4e5ee5cc972d513c431c9b04de5e307038cf02))
- A login matched on a page only through a regular-expression URI is no longer filled on page load or by the
  shortcut, not offered in the inline menu, and never updated from the save bar: the match type is not encrypted, so
  a compromised server could turn a bank's URI into a pattern that matches any site. It is still offered in the popup
  and the context menu. ([aacf04d](https://github.com/zoltrons/warren/commit/aacf04dfd9b4392068572898fad4917c0a49da6f))
- With PIN-only unlock, restarting the browser no longer resets the count of wrong PINs: the fifth wrong PIN logs
  out however many restarts happened in between. ([c3a38a4](https://github.com/zoltrons/warren/commit/c3a38a44b962d8b1dfdba53d3cc2404ce24fcb21))
- An open popup or side panel no longer keeps the vault from auto-locking when it refreshes because of a pushed
  login request: anyone who knows the account's email can send those. At most 20 pending requests are kept. ([90c683d](https://github.com/zoltrons/warren/commit/90c683d502de9ca91ae738e097b21f51037f1b3a))
- A passkey request that fails inside Warren tells the site only "not allowed", never why (vault locked, offline, the
  server's error text). ([7b4e5ee](https://github.com/zoltrons/warren/commit/7b4e5ee5cc972d513c431c9b04de5e307038cf02))

### Added

- Two-step sign-ins (the account name on one page, the password on the next, as on Google, Microsoft or Okta) save the
  new login with its username: Warren remembers the name the first page took, for that site and tab, for 5 minutes. ([f7c8c49](https://github.com/zoltrons/warren/commit/f7c8c49b8bac2a9fc6f030e5e77ef62caa258402))
- On sign-up forms the inline menu offers "Use a strong password": Warren generates one with your generator settings,
  fills the new and confirm password fields, keeps it in the generator history, and offers to save the login when the
  form is sent. ([8d52eb4](https://github.com/zoltrons/warren/commit/8d52eb4f0a76cb583165de7f9b5915eb4d619fb7))
- A new password on a site with several saved logins (none with that password) is offered for update with a choice
  of which login it belongs to, instead of nothing happening. ([541c81a](https://github.com/zoltrons/warren/commit/541c81a994b985ca5fb57fa1e41bb83f7c73985a))
- The inline menu has a "Don't show on this site" button next to "Manage passwords"; Settings → Blocked websites
  undoes it. ([9a9d2d5](https://github.com/zoltrons/warren/commit/9a9d2d5cc00de7905c81ed427a16825005e1df51))
- Keyboard shortcuts: Ctrl+Shift+Y (Command+Shift+Y on a Mac) opens Warren, and a "Lock Warren" command can be given a
  key in the browser's extension shortcut settings. ([3b4fb06](https://github.com/zoltrons/warren/commit/3b4fb0626d7e2ed9462e71469976a92de8b246cc))
- Screen readers announce the inline menu when it opens on a field, and how to reach it (Down arrow). ([11a1eb9](https://github.com/zoltrons/warren/commit/11a1eb98c67e532b02fac89f6ddf910bf53ef8b5))
- The save bar's username can be corrected before a new login is saved. ([f7c8c49](https://github.com/zoltrons/warren/commit/f7c8c49b8bac2a9fc6f030e5e77ef62caa258402))
- Signing in to a site while Warren is locked shows "Unlock Warren to save this login?"; after the unlock the usual
  save or update prompt follows. The typed password waits in memory only, for 5 minutes at most. ([1b804a3](https://github.com/zoltrons/warren/commit/1b804a3d66bc60d036ca6e061826875f3f47a802))
- A fill asked for while locked (shortcut, context menu, the inline menu's "Unlock to fill") happens right after the
  unlock, if it comes within 2 minutes and the tab still shows that site. ([1b804a3](https://github.com/zoltrons/warren/commit/1b804a3d66bc60d036ca6e061826875f3f47a802))

### Changed

- Passkeys no longer ask for the master password, Touch ID or Windows Hello in an unlocked vault, even when the site
  requires verification: unlocking the vault is the verification, as in Bitwarden's own apps and extension. An item
  with master password reprompt still asks for it. ([3e447ae](https://github.com/zoltrons/warren/commit/3e447aef4bdc081141f4de6a64d68ffa6b137a8d))

### Fixed

- Menus in the popup (More actions, copy and row options) open above their button when there is no room below,
  instead of being cut off at the bottom of the popup. ([1c01920](https://github.com/zoltrons/warren/commit/1c01920b0ab915a3efaf8bef7c80f5f4d5946449))
- Menus in the popup follow the keyboard: the arrow keys move between items (wrapping), Home and End jump. ([1c01920](https://github.com/zoltrons/warren/commit/1c01920b0ab915a3efaf8bef7c80f5f4d5946449))
- The notes field grows with its text up to 40 % of the popup's height, instead of a fixed two-line box. ([1c01920](https://github.com/zoltrons/warren/commit/1c01920b0ab915a3efaf8bef7c80f5f4d5946449))
- Screen readers announce on/off settings as switches, not checkboxes. ([1c01920](https://github.com/zoltrons/warren/commit/1c01920b0ab915a3efaf8bef7c80f5f4d5946449))
- Accounts with the new encryption (V2, from the next Vaultwarden release) work like any other: their items, which the
  Bitwarden apps save in a newer "blob" format, are shown, filled and edited, and Warren saves them in that format too.
  Before, they appeared empty and an edit would have overwritten them. ([5b3c82e](https://github.com/zoltrons/warren/commit/5b3c82edb8584aa3f3e586f93dd25ce6f8648511))
- New items, attachments and moves to an organization wrap their keys the way the Bitwarden apps read them on V2
  accounts. ([5b3c82e](https://github.com/zoltrons/warren/commit/5b3c82edb8584aa3f3e586f93dd25ce6f8648511))
- "Log out" on the lock screen asks for a second click like the one in Settings, since it removes the local vault,
  PIN and biometric unlock. ([efb74fe](https://github.com/zoltrons/warren/commit/efb74feaac2fd8c29ef40b624c7eee1bfd22ac08))
- A proxy or login gateway in front of the server that answers a token refresh with its own 401 page no longer logs
  Warren out (which removed the PIN, biometric unlock and local settings); only the server's own refusal does. ([d439402](https://github.com/zoltrons/warren/commit/d4394026d2394aebcbcb992d8790b08188f2eda3))
- Changes made on other devices while the push connection was down (network drop, browser restart, a server or
  proxy without WebSockets) now reach an unlocked vault: Warren syncs after every reconnect and at least every 30
  minutes, instead of only when the popup is opened. ([b50315c](https://github.com/zoltrons/warren/commit/b50315c3fd83f65732ebb04872e54c26856d154b))
- Clearer errors while setting up a server: an address that redirects (http to https, another host or path) says so
  instead of "Cannot reach the server", and a proxy's error page reads "The server answered with an error (HTTP 502)…"
  instead of a bare "HTTP 502". ([8f902ed](https://github.com/zoltrons/warren/commit/8f902edf6a74418506e9f6ff558e1276f6f90a7f))
- Saving an item that was changed on another device while it was open no longer fails over and over: Warren
  fetches the newer copy and says so, and saving again replaces that change with yours (or cancel to keep it). ([e762045](https://github.com/zoltrons/warren/commit/e7620450f39df08060e11c6964855735b9ac57cb))
- Searching a vault of thousands of items stays quick: the list sorts with one shared collator, waits for a pause in
  the typing in vaults over 1,000 items, and draws the first 200 results with a "Show all" button for the rest. ([c325b28](https://github.com/zoltrons/warren/commit/c325b28ce895a4e2b679a1c9fdf2c247967bd446))
- The "Fill with Warren" context menu lists at most 20 logins and a "more in Warren…" entry that opens the popup,
  instead of one entry per login on sites that match hundreds. ([dee8155](https://github.com/zoltrons/warren/commit/dee81554a955aad36edf7e6a1244ed2e2ded07b8))
- Autofill on page load waits until a prerendered page is actually shown, instead of filling a page the user may
  never open. ([4138cb3](https://github.com/zoltrons/warren/commit/4138cb3d1b7cca11a09753bf51a72ed3a6cc9689))
- The inline menu and save bar are removed when a page goes into the back/forward cache, so a page restored after
  the vault locked no longer shows item names. ([4138cb3](https://github.com/zoltrons/warren/commit/4138cb3d1b7cca11a09753bf51a72ed3a6cc9689))
- Saving a new organization item without picking a collection shows the error and keeps the Save button usable,
  instead of leaving it disabled until the popup is reopened. ([ec7ee93](https://github.com/zoltrons/warren/commit/ec7ee934e3301ee3c7c0efd1c3ef7ba1afb81bf8))

## 0.0.20 — 2026-11-12

### Added

- The weak and reused password banner has "Don't show again"; Settings → "Weak and reused password banner" brings it
  back. The security report stays under its chip. ([b775c7b](https://github.com/zoltrons/warren/commit/b775c7b0460f3ea69b97505ab1b4f4b9ee7d14ab))

### Changed

- Passkey sign-ins no longer ask for Touch ID / Windows Hello every time: biometric verification is used only when a
  site requires verification (in place of the master password), not when it merely prefers it, which nearly every
  site does. ([c517928](https://github.com/zoltrons/warren/commit/c5179283e8b97a2a552086840962781203ac03ed))

All commits: [v0.0.19...v0.0.20](https://github.com/zoltrons/warren/compare/v0.0.19...v0.0.20)

## 0.0.19 — 2026-11-12

### Added

- Passkeys work in sign-in forms a site embeds from another domain, when the site allows that frame to use passkeys. ([1398219](https://github.com/zoltrons/warren/commit/1398219c8681c186cab67b7421a8ee4af8674350))
- When a site tells the browser you renamed your account there (WebAuthn's signal API), the passkey in Warren takes
  the new name. ([6711d6f](https://github.com/zoltrons/warren/commit/6711d6fa2b3648b3c45a132b47a1cf89a00c16ee))
- Automatic passkey upgrades: right after Warren fills a site's password, a site that offers to switch you to a
  passkey saves it into that same login, without a prompt (a notification says so). Nothing else can save a passkey
  silently. ([f75b317](https://github.com/zoltrons/warren/commit/f75b31792c90af7735e8ced68cfa5d0a33212f2c), [d64d130](https://github.com/zoltrons/warren/commit/d64d130df969e4ae05b8654b3aa89d3daa122e4e))
- Registration forms: the inline menu offers "New e-mail alias" once an alias service is set up (Settings →
  Generator). It asks that service for the site and writes the address into the focused field only. ([a851f33](https://github.com/zoltrons/warren/commit/a851f33331adfdd167cf20b866b7746ff3b20964))
- Security report: logins on a site that offers authenticator-app codes, with none set up, are listed. The list of
  sites (24 KB, from 2fa.directory, MIT) ships with the extension; nothing is asked from that service. ([025bf6b](https://github.com/zoltrons/warren/commit/025bf6b7322f36545abb09dbdbfdb54eb95abd53), [299045e](https://github.com/zoltrons/warren/commit/299045e9db205a3288afacd7c353f243f782cb5e))
- A banner on the vault list says how many logins have reused or weak passwords and opens the security report. ([6b098f6](https://github.com/zoltrons/warren/commit/6b098f682a0ccd4f91939c479219c58596a6ddef))
- Security report: "Check e-mail addresses through your server" asks your Vaultwarden, which asks Have I Been
  Pwned, about the e-mail addresses used as login usernames. It works only when the server admin set an HIBP API key,
  and the report says so when not. ([b618d35](https://github.com/zoltrons/warren/commit/b618d35e1f6fe5ab17977ed2c896f1846df7d2d2), [8045746](https://github.com/zoltrons/warren/commit/804574660d8d8f2ff734bd96c166ef1eaa0242ea))
- A one-time banner in the vault list offers the "default password manager" setting; "Not now" hides it for good. ([1be21a6](https://github.com/zoltrons/warren/commit/1be21a648ccb746067965a03d7b5c3dd18070ea8))
- Optional setting (off by default): a new login password is checked against known breaches when you save it, and a
  toast warns when it was found. Only the first 5 characters of its SHA-1 hash leave the device. ([1be21a6](https://github.com/zoltrons/warren/commit/1be21a648ccb746067965a03d7b5c3dd18070ea8))
- Import reads the CSV exports of other managers (Chrome, Edge, Brave, Firefox, LastPass, 1Password, Keeper,
  KeePassXC, Proton Pass, NordPass, RoboForm) as logins and secure notes, picked by their column names. ([c75e477](https://github.com/zoltrons/warren/commit/c75e4778db88871ac8f46848d525214400a422b1))
- Bank account, driver's license and passport items can be created, viewed and edited (Vaultwarden already stored
  them; they showed in the list without fields). Their numbers are hidden like card numbers. ([a04ccd5](https://github.com/zoltrons/warren/commit/a04ccd51361b9348bdd7e806db8a5fe74a2e63ae), [2f31f56](https://github.com/zoltrons/warren/commit/2f31f56876833dba300f111568bdb386f2150416))
- Security report (a chip in the vault list): reused passwords, weak passwords and sites without https, plus an
  on-demand check of every password against known breaches. Only the first 5 characters of each SHA-1 hash leave
  the device; the worker matches the answers, so the popup never holds a password or a full hash. ([b5f06ba](https://github.com/zoltrons/warren/commit/b5f06ba6d2d8ec4f04a4077066065467f7d063e4))
- Archive: an item can be archived and unarchived. Archived items leave the list, search, autofill and passkey
  sign-in, wait under an "Archive" chip, and are part of an export. Needs Vaultwarden 1.36.0 or newer. ([f16110b](https://github.com/zoltrons/warren/commit/f16110b129eac161027af8c2e87b2875f21374b5))
- Card rows get hover shortcuts like logins: copy the number and the security code. ([08b73db](https://github.com/zoltrons/warren/commit/08b73db8e0ddaab662e4eaf5f5ba7ff11fa6829d))

### Changed

- With biometric unlock set up, a site that asks to verify you for a passkey gets Touch ID / Windows Hello in the
  passkey window instead of the master password, and sites that only prefer verification now get it too. ([179bc1d](https://github.com/zoltrons/warren/commit/179bc1d5aea2712c50f32f8aed79e9563f91a48c))
- New passkeys carry Bitwarden's authenticator id (AAGUID), so sites that list passkeys by provider show
  "Bitwarden" instead of an unknown authenticator. ([9b693bb](https://github.com/zoltrons/warren/commit/9b693bb9fa60fb644fdfa06e7f7a07cb7bb430d2), [ddb1cad](https://github.com/zoltrons/warren/commit/ddb1cad115a52f5dfecb23f416bfb31c5eb872e4))

### Fixed

- A page that rebuilds itself and drops the inline menu no longer leaves the field without one: a click brings it back. ([d8998f4](https://github.com/zoltrons/warren/commit/d8998f4b34a78e6e72d3dd5c71ddd275de931842))
- Logins inside web components that close their shadow root get the inline menu and are filled. ([685bd9b](https://github.com/zoltrons/warren/commit/685bd9b47bbd24a18c3103a2a10bc7650c61f464))
- The inline menu opens above a field near the bottom of the window instead of off screen, stays inside the right
  edge for wide fields, and follows its field when the page shifts it. ([28c71dc](https://github.com/zoltrons/warren/commit/28c71dc7e9ea491a4d09ddb049214248e03d0174))
- Sites that ask the newer `getClientCapabilities()` before offering passkeys now see that passkeys and passkey
  autofill are available, also in a browser without a built-in authenticator. ([c659ca9](https://github.com/zoltrons/warren/commit/c659ca9ec19cf376c2699f77aedc93f047ba99ca))
- A passkey imported from another manager with a sign counter now counts up on every sign-in (saved to the vault
  first), so sites that check the counter no longer take it for a copied passkey. ([a061b48](https://github.com/zoltrons/warren/commit/a061b4893fdc0c6739e2ab8bb6eac6e5cd2af3d6))
- A card picked in the inline menu fills a checkout whose number, expiry and security code sit in separate frames
  of the payment provider, not only the field you were in. ([2cc1188](https://github.com/zoltrons/warren/commit/2cc1188c9e565a8d17202e861b6aa481ff48f4b1))
- Card fields in a checkout's small iframes (one field per frame) get a usable inline menu: the page draws it under
  the field instead of the frame cutting it off. ([c1e0241](https://github.com/zoltrons/warren/commit/c1e024149c54425dad3f68845d80098e6695d82d))
- A passkey request for an RP ID Warren may not use (another site's, or one allowed only through the site's related
  origins) goes straight to the browser instead of an approval window that could only fail. ([8b249bc](https://github.com/zoltrons/warren/commit/8b249bcd38ae537fdf954f407a72ebfde8ad158a))
- "Use another device or browser" in the passkey window hands the request to the browser only once the page has
  focus again, so the browser no longer refuses it as coming from an unfocused page. ([6c1f878](https://github.com/zoltrons/warren/commit/6c1f878a236493f83d8f9ffa7aebfd11a71adb7d))
- The inline menu works on logins inside a modal dialog or a focus-trapping pop-up: it opens above them (the
  browser's top layer) and takes clicks and the arrow keys. The save bar sits in the top layer too. ([3373099](https://github.com/zoltrons/warren/commit/3373099ac5f97c28e0d88fc24527bf36808b6de7))
- An item saved elsewhere (the page's save bar, a passkey, another window) shows up in the open popup or side
  panel at once, and a new login joins "On this site" right after saving. ([08b73db](https://github.com/zoltrons/warren/commit/08b73db8e0ddaab662e4eaf5f5ba7ff11fa6829d))
- The popup opens a large vault faster after unlock and after a sync: the whole list is built once instead of four
  times, and a sync that finds nothing new only stops the spinner (1500 items: four 150–390 ms freezes down to one). ([5992de9](https://github.com/zoltrons/warren/commit/5992de949e481bb094d8ff2aa69a9a08ed802ff9))
- The vault list in a large vault re-renders, scrolls and hovers faster: rows out of view are no longer laid out or
  painted (1500 items: a filter or clear about 700 ms down to 300). ([5992de9](https://github.com/zoltrons/warren/commit/5992de949e481bb094d8ff2aa69a9a08ed802ff9))
- Scrolling no longer waits for the popup's script: the mouse wheel handler sits on the sideways filter row only. ([5992de9](https://github.com/zoltrons/warren/commit/5992de949e481bb094d8ff2aa69a9a08ed802ff9))
- Coming back to the vault list (from an item, another tab, or a re-sort) shows the same rows where they were, also
  when the item just joined "Recently opened" or long names wrap onto two lines. ([5992de9](https://github.com/zoltrons/warren/commit/5992de949e481bb094d8ff2aa69a9a08ed802ff9))

All commits: [v0.0.18...v0.0.19](https://github.com/zoltrons/warren/compare/v0.0.18...v0.0.19)

## 0.0.18 — 2026-11-11

### Fixed

- The popup no longer stutters on hover, scroll and website icon loads in a large vault: each time the browser sized
  the popup to its content, two narrow-layout rules made it re-check the styles of the whole list, twice.
- Vault search keeps up with typing in a large vault: each item's text is prepared for matching once per list, not
  on every keystroke (5000 items: about 20 ms per key down to 2).
- The inline menu no longer downloads the weak-password word list on every website; only the popup loads it.

## 0.0.17 — 2026-11-11

### Fixed

- The popup and side panel no longer lag in a large vault, most of all with animations on: every website icon that
  loaded made the browser re-check the styles of the whole list (a regression in 0.0.15).

## 0.0.16 — 2026-11-11

### Added

- Inline menu: a "Manage passwords…" row pinned under the list opens Warren, as in Chrome's own autofill menu.
- Save bar: shows the username and a masked password it is about to save; Escape closes it.

### Changed

- The popup, side panel, inline menu and save bar take Chrome's shapes and behavior (Chrome Refresh / Material 3)
  in Warren's own colors: pill buttons, round icon buttons, borderless tonal cards, 13 px text, Chrome's toggle
  switch, an inverse toast, and a dropdown and save bar that look like Chrome's. Icons are unchanged.
- The generator's type is a dropdown next to its title; Send's Text/File and the two-step login method are segmented
  buttons.
- Inline menu rows lead with the username and show a key (card, person) glyph; suggestions use regular weight, and
  the keyboard selection is a filled row.
- Motion follows Material timing (100/200 ms); menus and dialogs fade in and out, the inline menu and save bar fade
  in and out, and buttons no longer shrink on press.
- Short screens (locked, sign-in) are only as tall as their content.
- Dark theme: a deeper, quieter cherry background so the ear-pink accent carries; hover and press layers take the
  text color instead of raspberry; section labels are muted subheads.
- Send rows show a file or text glyph; the save bar leads with a key; the Favorites chip uses the outline star.

### Fixed

- Inline menu rows: their accessible name now contains the visible text (WCAG 2.5.3).

## 0.0.15 — 2026-11-10

### Added

- Settings: a search box (press `/`, clear with × or Escape) that keeps only the matching settings; it matches the
  start of words in titles, descriptions and choices ("lock" finds Auto-lock, not Blocked websites; "dark" finds
  Theme), ignoring case, accents and the Turkish dotted/dotless i. An Appearance section for theme, width, density,
  animations and website icons.
- Undo: moving an item to the trash takes one click and offers Undo (also Ctrl/Cmd+Z); a notice stays up while the
  pointer or keyboard is on it.
- Leaving the editor with unsaved edits asks first: Cancel or Escape shows "Unsaved changes" with Discard; a second
  click leaves.
- Keyboard: `/` jumps to the vault search; ArrowDown steps into the results, Enter opens the first one, ArrowUp on
  the first row goes back; Escape goes back from an item, the editor or a Send form; focus stays on a control after
  an in-place action (copy, show password, a length step, a switch).
- The inline menu works from the keyboard: ArrowDown enters the list, the arrows move, Enter fills, Escape returns
  to the field.
- Empty vault and empty Send list offer their next step (New item and Import items; New Send).
- Screen readers: vault search says how many items it found; vault rows are list items holding a real button, named
  with the username and the marks (code, weak, reused, favorite).

### Changed

- Screens slide when you go into an item or back, and fade between tabs; rows added or removed in the editor and in
  settings lists animate. All of it follows the system's reduced motion setting and Settings → Appearance; under
  reduced motion busy bars stay visible and the sync icon still turns.
- New item and New Send sit in the header as its one filled button, instead of floating over the rows.
- Fill sits only on the rows listed for the current site; other items fill from their own view.
- While searching, the best name matches come first, without letter headings.
- Settings order: Autofill, Autofill on page load, Clipboard and website matching, Blocked websites, Account (now
  with Log out, side panel and tab), Security (now with Lock now), Appearance, Vault, About. Sync now is one row;
  Clear beside Show recently opened shows only when there is something to clear; action rows show an icon.
- Log out in Settings, deleting a folder, deleting forever and deleting a Send take a second click ("Click again to
  …"), which disarms after 4 s; an armed Send delete says so under its name.
- Send rows: the name opens the Send, its state is written out ("Password-protected", "Disabled"), dates read like
  the rest ("Nov 5, 2026"); a new file Send picks its file from a row in the app's style, and its switches sit in
  cards like the fields.
- Text follows the browser's font size (type, icons and icon buttons in rem); the inline menu and save bar keep
  theirs. Rows too narrow for text and controls (large text, a narrow side panel) move the controls under the text;
  a side panel under 220 px shows its tabs as icons.
- Focus ring: solid brand color (5.3:1 or more, in the contrast check), drawn inside rows and keeping each control's
  rounded shape; visible in Windows High Contrast.
- Contrast: digits in passwords have their own color in every theme; switches keep one knob color with a 3:1 off
  track; faint icons reach 3:1; the current tab is marked by a filled pill as well as its color.
- Copy: no "·" or spaced "—" joins; "Click again" instead of "Tap again"; "Logging in…"; "Large type"; plainer hints
  for autofill on page load, submit after filling, blocked websites and biometrics; the editor's Websites section is
  named as in the item view; "No matching items" says what to try and names the search keywords.
- Generator: suggestions wrap instead of ending in "…" and drop the repeated "20 characters"; character-set chips use
  the body font; the generated value is not read aloud on every change.
- Lists: the site's rows show the same marks as elsewhere; Recently opened and Favorites leave out items already
  shown above; a hovered row keeps a weak or reused warning beside its quick actions; letter headings match the other
  headings; an empty vault hides the filter chips; SSH key has its own icon.
- The lock screen always shows the lock. A failure notice shows an error icon.

### Fixed

- The copy notice said "clears in 30 s" whatever the setting; it now says when the clipboard clears ("Copied. Clears
  in 1 minute"), or just "Copied".
- Counts read right: "1 site", "1 day", "1 second left", "1 previous password".
- Vault search ignores accents and the Turkish dotted/dotless i ("zurich" finds Zürich, "istanbul" finds İstanbul).
- The whole popup was one live region, so screen readers could re-read screens and the list on every keystroke.
- The toast's Undo was dimmed by a more specific rule; it is drawn in the brand color in every theme.
- A narrow side panel at 200 % zoom no longer scrolls sideways or squeezes names to a word per line.
- "Cannot reach the server" says what to check.

## 0.0.14 — 2026-11-10

### Security

- Two-step login with a security key: the server's `webauthn-connector.html` is framed with
  `sandbox="allow-scripts allow-same-origin"`, so a click in it cannot navigate the popup or its tab to a page of
  the server's.
- Passkeys: an IP address is only its own RP ID; the tail of one ("1.1" on 192.168.1.1) is no longer taken as a
  parent domain.
- The timed clipboard clear reads the clipboard first and only erases the value Warren copied (a SHA-256 kept in
  `storage.session`); this adds the `clipboardRead` permission.
- CSV export: the item name is defused like the username (a passkey item is named by its relying party's name).

### Fixed

- Email aliases: a self-host URL the service rejects no longer drops the API key typed next to it; the key is
  saved and the URL error is shown.
- A password built on a common word is weak whatever its length.
- The field watcher walks the page once instead of twice and scans the shadow root of an added host.
- The vault cache is no longer bound by the 10 MB storage quota (`unlimitedStorage`).

## 0.0.13 — 2026-11-08

### Security

- Autofill on page load fills the top frame or a frame of the tab's own origin only: a page can no longer frame
  another site's login form, hide it, and have the saved login written into it.
- A trailing dot ("example.com.") no longer gets a page past the blocked sites; never-save and blocked entries are
  kept without it.
- A passkey request the page aborts right away no longer opens the approval window, and cannot replace a saved
  passkey the site never received.
- A page that stops responding can no longer hold up unlock, sync or saves for the other tabs: page calls give up
  after 10 seconds.
- CSV export: a username that looks like a spreadsheet formula is written with a leading `'` (and read back
  without it), so opening the export cannot run it.
- The storage access level is set for both storage areas independently, and a failure is logged.
- SSO logins key the KDF floor by the lowercased email, like the password login.
- Releases: the SBOM tool runs pinned by digest with the source mounted read-only, and the signing job takes the
  SBOM from outside its checkout.

## 0.0.12 — 2026-11-07

### Security

- KDF floors raised to OWASP's minimums: Warren no longer sends a hash of the master password made with PBKDF2 under
  600 000 iterations or Argon2id under 19 MiB x 2, also on a first login. An account below them must raise its KDF in
  the web vault before it can log in here. The extension pages' CSP now has `object-src 'none'`.
- `npm ci` runs no package's install script (`ignore-scripts=true` in `.npmrc`).
- CI scans the whole history for committed secrets (gitleaks), and every release ships a CycloneDX SBOM with
  signed provenance.

- Every item Warren creates (new, cloned, imported, or a passkey's new login) gets its own key, as the official
  clients do on Bitwarden's cloud. On Vaultwarden they do not create such keys themselves; that they open such items
  there has not been tested yet. Only then are a login's websites bound to it, so a server cannot move another item's website into it
  and have the login filled on that site. Items made earlier keep working as they are.

### Added

- Organizations: create an item in a collection, move a personal item into an organization, change an item's
  collections.
- Duo two-step login (personal and organization Duo).
- Export as Bitwarden CSV or password-protected JSON; import of both.
- Blocked websites: no inline menu, page-load fill or passkey prompt on a site and its subdomains. Never-save sites
  can be added by hand.
- Delete an attachment; "Change password on this site"; extension width, compact mode, animations and toolbar badge
  count settings.

### Fixed

- "Never save" works for sites on a non-default port: a site added in settings no longer gets the save bar, and
  "Never" in the bar covers the site whatever its port.

## 0.0.11 — 2026-11-05

### Security

- A server can no longer get round the KDF floor with a number the crypto core wraps (2^32 + 5000 iterations read
  as 5000): KDF values from the server are taken only as PBKDF2 or Argon2id and whole numbers within 32 bits.
- A lock now wins over every fill, save bar, field picker, unlock and passkey save in flight: a fill the lock
  overtook reaches no page, a typed password waiting in the save bar is not written back, and an unlock that began
  before the lock does not complete. A login, logout or server change wins over a token refresh, the push connection
  and an SSO callback the same way, and a token is only ever sent to the server and account it belongs to.
- A save bar update is made against the revision it was shown for, so an older prompt cannot undo a newer password.
- A cancelled passkey request is not saved; if it is cancelled while the save is on its way, the passkey it replaced
  is put back.
- Passkey relying party ids with an empty label (`com.`) are refused.
- Autosubmit presses nothing when the login button went away during the fill, and no Enter on a page with more
  buttons than are inspected. Page-load autofill puts custom fields only into the login it fills. Enter in a password
  field offers the save for its own form. A fill that writes no field counts as no fill.
- Releases need the tagged commit on `main` with a green `ci` run for its push there.

### Fixed

- Editing a Send keeps its text and its access password whatever key casing the server uses.
- An export refuses to run when a folder cannot be decrypted, instead of dropping it.
- A change saved on the server no longer reports an error when only the refresh afterwards failed (a retry could
  create it twice). A sync that started before a save no longer hides the saved item.
- The popup ignores answers to requests made before a lock (and states from before an unlock), and a master
  password typed for a passkey request is cleared on lock.

## 0.0.10 — 2026-11-05

### Security

- The refresh token is stored sealed with the user key, no longer in clear text. After a browser restart a locked
  vault syncs again after the first unlock.
- "Unlock with PIN" without the master password after a restart needs a PIN of at least 8 characters with one that
  is not a digit. A shorter PIN set this way before asks for the master password after the next restart.
- Passkey private keys stay in the crypto worker: the popup never holds one, and a new passkey, an item updated from
  the save bar and an attachment's item no longer pass through the service worker.
- Passkeys: the "user verified" flag is set only when the user was verified for that request (unlock or master
  password in the approval window). A site that requires verification asks for the master password.
- A popup or side panel fill is bound to the tab and site it showed, and refused once either changed.
- A lock wins over a login, unlock or re-prompt still in flight. A server can no longer lower the KDF: a weaker one
  than the account used here is refused unless still safe, and PBKDF2 under 100 000 iterations is never used.
- Login URIs whose checksum does not match are dropped, so a server cannot point a login at another site.
- Saves carry the revision they were read at: the server refuses a stale draft instead of overwriting newer data.
- Autosubmit never presses a destructive button and submits only when the password was written. One-time-code
  fields never get the account password; page-load autofill skips sign-up forms; fields clipped away count as hidden.
- Releases: the CRX is signed without any npm package or browser next to the key, and a release needs a signed tag.

### Changed

- Copied values are cleared after 1 minute by default (was 5). A delay you picked stays.
- Every login, card and identity row has a Fill button while a page is open; a login saved for another site asks
  first ("Fill anyway").
- Website icons follow the server's icon service redirects (Vaultwarden `ICON_SERVICE`).
- Export and import include bank accounts, driver's licenses and passports. An export with an undecryptable personal
  item is refused instead of incomplete.

### Fixed

- A Send whose text could not be read no longer opens an empty editor that would wipe it on save.
- An SSH private key keeps its line breaks while hidden.
- Large Type and the QR code close when a re-prompt grant ends.
- An invalid TOTP key shows one error instead of retrying on every render.
- A login request pushed from another device shows in an open popup again.

## 0.0.9 — 2026-11-05

### Added

- Log in with device: approve the login from another logged-in device instead of entering the master password.
  Both devices show the same fingerprint phrase. Requires a previous master-password login in this browser
  (Vaultwarden restriction); two-step login still applies.
- Approval of login requests from other devices: system notification, then Confirm or Deny in the popup with the
  fingerprint phrase, device type, IP address and time. Requires an unlocked vault.
- Live sync over Vaultwarden's WebSocket notifications. Changes from other clients appear immediately, including in
  an open popup or side panel. A server-side "log out all sessions" also logs Warren out.
- Fill for logins not saved for the current site, after a confirmation.
- Permission: `notifications`.

### Changed

- The PIN key uses its own Argon2id parameters (256 MiB, 3 iterations) regardless of the account KDF. Existing PIN
  keys are re-wrapped on the next unlock.
- Settings show a warning for accounts that still use PBKDF2.
- Website icons are off by default; icon requests no longer follow redirects.
- Extension pages enforce Trusted Types.
- Release files carry signed build provenance (`gh attestation verify`).

### Fixed

- The inline menu could be opened by a page script focusing a field.
- Fill values could reach a frame that had navigated after the origin check.
- Trashed items were offered for filling and passkey sign-in.
- Page-load autofill copied the TOTP code to the clipboard.
- A regular-expression URI match on a long URL could hang the vault worker.
- Forwarded email alias requests included the page path.
- 2FA "remember me" tokens were stored next to the account email in clear text.

## 0.0.8 — 2026-11-04

### Changed

- **New icons.** The interface uses Lucide's outline icons, drawn with one 1.75 px stroke at every size so they
  sit evenly next to the text. Send has a horizontal paper plane and the PIN unlock a password-field glyph.

### Fixed

- **Pure black theme:** monogram tiles were nearly invisible and the tinted Fill button, selected chips and
  highlighted rows faded into the black; they now keep their color.

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
