#!/usr/bin/env node
// Mutation check for the SECURITY.md invariants (docs/VERIFICATION.md): removes or inverts one check at a time, runs
// the suite that should notice, and restores the file. KILLED = a test failed (or the suite hung), SURVIVED = nothing
// noticed the check was gone. Run on a clean tree: an interrupted run can leave a mutant behind (`git diff` shows it).
//   node tools/mutate.mjs [id...]      no ids: all of them (several minutes; a hung suite waits for its timeout)
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const unit = "npm test";
const fill = "node tools/verify.mjs fill";
const preview = "node dev/preview/build.mjs && node dev/preview/shot.mjs";
const M = [
  // 7a guardKdf
  ["kdf-floorMin", "src/background/account.ts", "if (tooWeak(kdf))", "if (false && tooWeak(kdf))", unit],
  ["kdf-downgrade", "src/background/account.ts", "if (kdfDowngrade(kdf, floors[key]))", "if (false && kdfDowngrade(kdf, floors[key]))", unit],
  ["kdf-noPersist", "src/background/account.ts", 'await setLocal("kdfFloors",', 'if (false) await setLocal("kdfFloors",', unit],
  ["kdf-tokenUnguarded", "src/background/account.ts", "const accountKdf = await guardKdf(serverUrl, email, kdfFromToken(t, kdf));", "const accountKdf = kdfFromToken(t, kdf);", unit],
  ["kdf-ssoUnguarded", "src/background/account.ts", "const kdf = await guardKdf(base, email, kdfFromToken(t, await prelogin(base, email)));", "const kdf = kdfFromToken(t, await prelogin(base, email));", unit],
  ["kdf-pbkdf2Min", "src/background/kdf.ts", "export const PBKDF2_MIN = 600_000;", "export const PBKDF2_MIN = 5000;", unit],
  ["kdf-reverifyMin", "src/background/account.ts", "  if (tooWeak(account.kdf))\n    throw", "  if (false)\n    throw", unit],
  // 4 guardClicks + frame secrets
  ["clicks-300to0", "src/ui/dom.ts", "Date.now() - since >= 300", "Date.now() - since >= 0", unit],
  ["clicks-ignoreVisible", "src/ui/dom.ts", ".isVisible ? since || Date.now() : 0", ".isVisible || true ? since || Date.now() : 0", unit],
  ["clicks-moveNoReset", "src/ui/dom.ts", "if (since) since = Date.now();", "", unit],
  ["frame-nonce", "src/background/inline.ts", "if (req.nonce !== ctx.nonce) throw", "if (false) throw", unit],
  ["frame-barToken", "src/background/inline.ts", "if (!p.token || req.token !== p.token) throw", "if (false) throw", unit],
  // 8b epochs
  ["epoch-assertNoop", "src/background/lock.ts", "if (e !== epoch) throw", "if (false) throw", unit],
  ["epoch-checkNoop", "src/background/account.ts", "if (lockEpoch() === epoch) return write?.();", "if (true) return write?.();", unit],
  ["epoch-ownerNoop", "src/background/lock.ts", "if (taken.some((o) => o !== owner)) throw", "if (false) throw", unit],
  ["epoch-engineGuard", "src/background/engine.ts", "const guard = () => assertEpoch(req.epoch);", "const guard = () => undefined;", unit],
  ["epoch-reprompt", "src/background/account.ts", "  await verifyMasterPassword(password);\n  assertEpoch(epoch);", "  await verifyMasterPassword(password);", unit],
  ["epoch-afterUnlock", "src/background/account.ts", "await checkEpoch(epoch, () => updateSession({ unlocked: true }));", "await updateSession({ unlocked: true });", unit],
  ["epoch-saveBar", "src/background/inline.ts", "  if (epoch !== lockEpoch()) return;\n  await setTabState(\"save\", tabId, { ...p, token });", "  await setTabState(\"save\", tabId, { ...p, token });", unit],
  ["epoch-loginSubmitted", "src/background/inline.ts", "  if (epoch !== lockEpoch()) return;\n  await setTabState(\"save\", tabId, pending);", "  await setTabState(\"save\", tabId, pending);", unit],
  // 8b popup: a screen change still waiting for its view-transition frame never lands after a lock
  ["render-staleSwap", "src/ui/popup.ts", "    if (seq !== renderSeq) return;\n", "", preview],
  ["epoch-lockFirst", "src/background/lock.ts", "  const mine = ++epoch;\n  revokeReprompts();", "  revokeReprompts();\n  await Promise.resolve();\n  const mine = ++epoch;", unit],
  // 1 sender
  ["sender-frameUrlFromTab", "src/background/inline.ts", "const url = httpUrl(sender)?.href;", "const url = httpUrl(sender.tab)?.href;", unit],
  ["sender-passkeyAnyFrame", "src/background/passkey.ts", "sender.frameId !== 0 ||", "", unit],
  // 2 parsers
  ["parse-unknownPage", "src/shared/messages.ts", 'if (typeof type !== "string" || !Object.hasOwn(validators, type)) throw new ValidationError("unknown message type");\n    return validators[type]!(v, "") as T;', 'if (typeof type !== "string" || !Object.hasOwn(validators, type)) return v as T;\n    return validators[type]!(v, "") as T;', unit],
  ["parse-unknownPopup", "src/shared/messages.ts", 'if (typeof type !== "string" || !Object.hasOwn(requestValidators, type)) throw new ValidationError("unknown message type");', 'if (typeof type !== "string" || !Object.hasOwn(requestValidators, type)) return v as Request;', unit],
  ["parse-credIds64", "src/shared/messages.ts", "if (list.length > 64) throw", "if (false) throw", unit],
  ["parse-challengeCap", "src/shared/messages.ts", "const challengeField = capped(64 * 1024);", "const challengeField = str;", unit],
  ["parse-pageString", "src/shared/messages.ts", "const pageString = opt(capped(MAX_PAGE_STRING));", "const pageString = opt(str);", unit],
  // 3 origin in page
  ["origin-collect", "src/autofill/page.ts", "if (location.origin !== req.origin) return", "if (false) return", fill],
  ["origin-execute", "src/autofill/executor/fill.ts", "if (location.origin !== req.origin) return", "if (false) return", fill],
  // 11 checkRpId
  ["rp-noSuffix", "src/offscreen/fido2.ts", "|| (isPublicSuffix(id) && !isLoopback(id))", "", unit],
  ["rp-noSecure", "src/offscreen/fido2.ts", "if (!secure ||", "if (", unit],
  ["rp-noDot", "src/offscreen/fido2.ts", "host.endsWith(`.${id}`)", "host.endsWith(id)", unit],
  ["rp-noLabelled", "src/offscreen/fido2.ts", "|| !labelled ||", "||", unit],
  ["rp-assertUnchecked", "src/offscreen/vault.ts", "export async function passkeyAssert(itemId: string, wanted: string, rpId: string, origin: string, challenge: string, uv: boolean) {\n  await checkRp(rpId, origin);", "export async function passkeyAssert(itemId: string, wanted: string, rpId: string, origin: string, challenge: string, uv: boolean) {", unit],
  ["rp-createUnchecked", "src/offscreen/vault.ts", "  await checkRp(input.rpId, input.origin);\n", "", unit],
  // 8b per call site
  ["epoch-pickerStart", "src/background/picker.ts", "  assertEpoch(epoch);\n  await updateSession({ picker: { tabId, panel } });", "  await updateSession({ picker: { tabId, panel } });", unit],
  ["epoch-pickerFinish", "src/background/picker.ts", "if (epoch !== lockEpoch()) return; // a lock ended the picker meanwhile", "", unit],
  ["epoch-passkeySave", "src/background/passkey.ts", "        assertEpoch(epoch);\n      }).catch", "      }).catch", unit],
  ["epoch-vaultCommit", "src/background/vault.ts", "    assertEpoch(epoch);\n    await run(cache);", "    await run(cache);", unit],
  ["epoch-vaultLoad", "src/background/vault.ts", "    () => assertEpoch(epoch),\n  );\n\n/** Changes", "    () => undefined,\n  );\n\n/** Changes", unit],
  ["epoch-vaultPut", "src/background/vault.ts", "  assertEpoch(epoch);\n  guard?.();", "  guard?.();", unit],
];

const only = process.argv.slice(2);
for (const [id, file, from, to, cmd] of M) {
  if (only.length && !only.includes(id)) continue;
  const path = join(root, file);
  const orig = readFileSync(path, "utf8");
  const n = orig.split(from).length - 1;
  if (n !== 1) {
    console.log(`| ${id} | NOT APPLIED (${n} matches) |`);
    continue;
  }
  writeFileSync(path, orig.replace(from, to));
  let status = "SURVIVED";
  let failed = "";
  try {
    execSync(cmd, { cwd: root, stdio: "pipe", timeout: 240_000 });
  } catch (e) {
    status = "KILLED";
    const out = String(e.stdout) + String(e.stderr);
    failed = [...new Set([...out.matchAll(/^\s*(?:✖|not ok \d+ -) (.+?)(?: \(\d.*)?$/gm)].map((m) => m[1].trim()))].slice(0, 3).join(" ; ");
    if (!failed) failed = out.split("\n").filter((l) => /error|Error/.test(l)).slice(0, 2).join(" / ");
  } finally {
    writeFileSync(path, orig);
  }
  console.log(`| ${id} | ${file} | ${cmd} | ${status} | ${failed} |`);
}
