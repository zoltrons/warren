# Reporting a vulnerability

Please report security problems privately through GitHub: **Security → Report a vulnerability** on
this repository. Do not open a public issue for them.

Include what an attacker needs (a malicious page, a hostile server, access to the browser profile, ...),
the steps to reproduce and the Warren version. You should get an answer within a week; a fix ships as a
new release, which installed copies pick up on their own (`docs/UPDATES.md`).

Only the latest release is supported, against the latest Vaultwarden release. What Warren promises, and
what it knowingly does not, is in [`docs/SECURITY.md`](../docs/SECURITY.md); a "Known gaps" entry is not a
new finding unless you can get past what it describes.
