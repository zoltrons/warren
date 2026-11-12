#!/usr/bin/env node
// Writes src/shared/totp-sites.json for the security report's "no two-step codes" check: the domains that offer TOTP
// (authenticator-app codes) according to 2fa.directory (2factorauth/twofactorauth, MIT, see NOTICE). The data is read
// here and shipped inside the extension: the extension never asks that service anything. The release workflow runs this
// before every build, so a release carries the current list; the committed copy serves local builds.
//   node tools/totp-sites.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const url = "https://api.2fa.directory/v3/totp.json";
const res = await fetch(url);
if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
const domains = new Set();
for (const [, e] of await res.json()) {
  if (!Array.isArray(e.tfa) || !e.tfa.includes("totp")) continue;
  for (const d of [e.domain, ...(e["additional-domains"] ?? [])]) if (typeof d === "string" && /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d.toLowerCase())) domains.add(d.toLowerCase());
}
if (domains.size < 1000) throw new Error(`only ${domains.size} domains: the list changed shape`);
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "src/shared/totp-sites.json");
writeFileSync(out, JSON.stringify([...domains].sort()) + "\n");
console.log(`${domains.size} domains -> ${out}`);
