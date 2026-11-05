# Updates from GitHub releases

Every `v*` tag builds a signed `.crx`, a `.zip` and an **`updates.xml`** (`.github/workflows/release.yml`).
The tag must be annotated: its message, the version's `CHANGELOG.md` section, becomes the release notes
(`git tag -a vX.Y.Z --cleanup=verbatim -F notes.md`; without `verbatim` git drops the `###` headings).
The manifest's `update_url` points at `https://github.com/zoltrons/warren/releases/latest/download/updates.xml`,
which always resolves to the newest release's update manifest:

```xml
<gupdate xmlns="http://www.google.com/update2/response" protocol="2.0">
  <app appid="<extension id>">
    <updatecheck codebase=".../releases/download/vX.Y.Z/warren-vX.Y.Z.crx" version="X.Y.Z" />
  </app>
</gupdate>
```

The browser polls it on its own schedule (a few hours), downloads the `.crx` when `version` is newer than the
installed one, checks the signature against the extension's key and installs it. Nothing in the extension code
makes the request.

- **The extension id is fixed by the `CRX_KEY` secret.** The workflow derives the id from it (SHA-256 of the
  public key, first 128 bits, written with `a`-`p`), so a new key means a new extension that cannot update the
  old one. Never regenerate it. Warren's id is `nkaabaakdmjjoplnpijkcnpmenphaikf`; the release fails on any other.
- **The signing job runs no third-party code.** `tools/pack-crx.mjs` writes the CRX3 file (the released `.zip`,
  signed) with `node:crypto` only and reads it back before publishing; the job installs no npm package and starts no
  browser, so a compromised dependency never sees `CRX_KEY`. `node tools/pack-crx.mjs --verify <file.crx>` checks a
  download and prints its extension id.
- **Every released file carries signed build provenance.** The release job attests the `.crx`, `.zip` and
  `updates.xml` (SLSA provenance via Sigstore, `actions/attest`), so a download can be traced to the commit and
  workflow run that built it: `gh attestation verify warren-vX.Y.Z.crx --repo zoltrons/warren`. A release also
  refuses to build while `npm audit` (high) or `cargo deny check advisories` fails.
- **Only builds that contain `update_url` can update themselves.** An older install has to be replaced by hand
  once.
- **The browser decides whether an off-store extension may update.** Chromium honours `update_url` for extensions
  installed by enterprise policy, which also works for personal machines. On macOS, for example, a managed
  preference for the browser's bundle id with `ExtensionInstallForcelist` set to
  `nkaabaakdmjjoplnpijkcnpmenphaikf;https://github.com/zoltrons/warren/releases/latest/download/updates.xml` installs and keeps
  the extension current. A hand-installed `.crx` is refused by stock Chrome, and Chromium forks differ in what
  they allow, so check yours before relying on it.
