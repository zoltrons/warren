import assert from "node:assert/strict";
import { constants, createCipheriv, createHmac, generateKeyPairSync, publicEncrypt, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Locator, type Page, type Worker } from "playwright-core";
import { passwordToken } from "../../src/transport/auth.ts";
import { call } from "../../src/transport/http.ts";


export const BASE = process.env.VW_URL ?? "http://localhost:8080";
export const root = join(import.meta.dirname, "../..");
export const TOTP_KEY = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"; // test fixture, 20 bytes

export const wasmDir = join(root, "dist/wasm-register");
export const wasm = await import(pathToFileURL(join(wasmDir, "core_wasm.js")).href);
await wasm.default({ module_or_path: readFileSync(join(wasmDir, "core_wasm_bg.wasm")) });

export type Kdf = [number, number, number, number];
export interface TestUser { email: string; password: string; kdf: Kdf }

/** A click that closes its own window (a passkey decision): the window going away mid-click is success. */
export async function closingClick(w: Page, target: Locator) {
  await target.click().catch((e: unknown) => {
    if (!w.isClosed()) throw e;
  });
}

export const passed: string[] = [];
export const skipped: string[] = [];
let skipReason = "";
/**
 * Skips the steps that follow, up to the end of the group (run.ts resets it). Only for a dependency a local machine
 * cannot have (the SSO IdP); CI sets CI=true and there a missing dependency fails the run instead.
 */
export function skipRestUnless(ok: boolean, reason: string) {
  if (ok) return;
  if (process.env.CI) throw new Error(`cannot skip in CI: ${reason}`);
  skipReason = reason;
}
export const endGroup = () => void (skipReason = "");
export async function step(name: string, fn: () => Promise<void>) {
  if (skipReason) {
    skipped.push(`skip ${name} (${skipReason})`);
    console.log(skipped.at(-1));
    return;
  }
  const t = performance.now();
  try {
    await fn();
  } catch (e) {
    console.error(`FAIL ${name}\n  popup: ${(await page?.locator("#app").innerText().catch(() => "?"))?.replace(/\s+/g, " ")}`);
    throw e;
  }
  passed.push(`ok  ${name} (${Math.round(performance.now() - t)} ms)`);
  console.log(passed.at(-1));
}

// ---------- server-side fixtures (through the API, like a fresh client would) ----------

export function authHash(u: TestUser): string {
  const h = wasm.deriveMasterKey(u.password, u.email, ...u.kdf);
  try {
    return wasm.makeAuthHash(h, u.password, false);
  } finally {
    wasm.freeMasterKey(h);
  }
}

export async function register(label: string, kdf: Kdf): Promise<TestUser> {
  const u = { email: `warren-${label}-${randomBytes(4).toString("hex")}@example.test`, password: `test-${label}-pw`, kdf };
  const token = await call(BASE, "POST", "/identity/accounts/register/send-verification-email", { json: { email: u.email, name: label } });
  const h = wasm.deriveMasterKey(u.password, u.email, ...kdf);
  const keys = JSON.parse(wasm.makeRegistrationKeys(h));
  await call(BASE, "POST", "/identity/accounts/register/finish", {
    json: {
      email: u.email, emailVerificationToken: token, masterPasswordHash: wasm.makeAuthHash(h, u.password, false), key: keys.key,
      kdf: kdf[0], kdfIterations: kdf[1], kdfMemory: kdf[0] === 1 ? kdf[2] : null, kdfParallelism: kdf[0] === 1 ? kdf[3] : null,
      userAsymmetricKeys: { publicKey: keys.publicKey, encryptedPrivateKey: keys.encryptedPrivateKey },
    },
  });
  wasm.freeMasterKey(h);
  return u;
}

/** Retries an async check (e.g. a value in extension storage) for up to 5 s. */
export async function poll(what: string, check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

export const totpNow = (key = TOTP_KEY) => JSON.parse(wasm.totp(key, Date.now())) as { code: string; remaining: number };
/** The two-step login key: the server picks it (get-authenticator), so it is known only after enableTotp. */
export let twoFactorKey = "";

/** Vaultwarden rejects a TOTP code twice in the same step, so wait for a fresh one. */
export async function freshTotp(): Promise<string> {
  await new Promise((r) => setTimeout(r, (totpNow(twoFactorKey).remaining + 1) * 1000));
  return totpNow(twoFactorKey).code;
}

/** Vaultwarden's flow: get-authenticator returns a key and a verification token bound to it; enabling needs both. */
export async function enableTotp(u: TestUser): Promise<void> {
  const tok = await passwordToken(BASE, { email: u.email, authHash: authHash(u), deviceId: crypto.randomUUID() });
  const setup = (await call(BASE, "POST", "/api/two-factor/get-authenticator", {
    token: tok.access_token,
    json: { masterPasswordHash: authHash(u) },
  })) as { authenticator: { key: string }; userVerificationToken: string };
  twoFactorKey = setup.authenticator.key;
  await call(BASE, "POST", "/api/two-factor/authenticator", {
    token: tok.access_token,
    json: { key: twoFactorKey, token: totpNow(twoFactorKey).code, userVerificationToken: setup.userVerificationToken },
  });
}

/**
 * Server-side view of a user through a second, independent client session (the test's own WASM
 * instance + raw API calls), used to seed vaults and to check what the extension wrote.
 */
export async function apiSession(u: TestUser) {
  const tok = await passwordToken(BASE, { email: u.email, authHash: authHash(u), deviceId: crypto.randomUUID() });
  const h = wasm.deriveMasterKey(u.password, u.email, ...u.kdf);
  wasm.unlockUserKey(h, tok.Key!, tok.PrivateKey);
  const userId = JSON.parse(Buffer.from(tok.access_token.split(".")[1]!, "base64url").toString()).sub as string;
  const token = tok.access_token;
  return {
    token,
    /** `keyed`: with a key of its own, as Warren writes new items; most seeded items stay without, as on Vaultwarden. */
    async create(plain: Record<string, unknown>, keyed = false) {
      const enc = JSON.parse(wasm.encryptCipher(JSON.stringify(plain), keyed));
      return (await call(BASE, "POST", "/api/ciphers", { token, json: { ...enc, encryptedFor: userId } })) as { id: string };
    },
    async update(plain: Record<string, any>) {
      const enc = JSON.parse(wasm.encryptCipher(JSON.stringify(plain), false));
      await call(BASE, "PUT", `/api/ciphers/${plain.id}`, { token, json: { ...enc, encryptedFor: userId } });
    },
    async folder(name: string) {
      const encName = JSON.parse(wasm.encryptCipher(JSON.stringify({ type: 2, name }), false)).name;
      return (await call(BASE, "POST", "/api/folders", { token, json: { name: encName } })) as { id: string };
    },
    async folders() {
      const sync = (await call(BASE, "GET", "/api/sync?excludeDomains=true", { token })) as { folders: unknown[] };
      return (JSON.parse(wasm.decryptFolders(JSON.stringify(sync.folders))).folders as { name: string }[]).map((f) => f.name);
    },
    /** Organization items as the server has them: owner, collections and the decrypted name. */
    async orgCiphers() {
      const sync = (await call(BASE, "GET", "/api/sync?excludeDomains=true", { token })) as { ciphers: { organizationId?: string; collectionIds?: string[] }[]; profile: { organizations: { id: string; key: string }[] } };
      wasm.setOrgKeys(JSON.stringify(Object.fromEntries(sync.profile.organizations.map((o) => [o.id, o.key]))));
      return sync.ciphers.filter((c) => c.organizationId).map((c) => ({ ...JSON.parse(wasm.decryptCipher(JSON.stringify(c))), organizationId: c.organizationId, collectionIds: c.collectionIds }) as Record<string, any>);
    },
    /** Personal items. */
    async ciphers() {
      const sync = (await call(BASE, "GET", "/api/sync?excludeDomains=true", { token })) as { ciphers: { organizationId?: string }[] };
      return sync.ciphers.filter((c) => !c.organizationId).map((c) => JSON.parse(wasm.decryptCipher(JSON.stringify(c))) as Record<string, any>);
    },
    done: () => wasm.lock(),
  };
}

/**
 * Creates an organization with one collection for `u`, and a secure note in that collection. All
 * crypto here is node:crypto (org key RSA-OAEP-wrapped for the user, names AES-CBC + HMAC), independent
 * of core-wasm.
 */
export async function createOrgNote(u: TestUser, orgName: string, collectionName: string, noteName: string): Promise<void> {
  const tok = await passwordToken(BASE, { email: u.email, authHash: authHash(u), deviceId: crypto.randomUUID() });
  const token = tok.access_token;
  const userId = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString()).sub as string;
  const { publicKey } = (await call(BASE, "GET", `/api/users/${userId}/public-key`, { token })) as { publicKey: string };
  const orgKey = randomBytes(64);
  const enc = (plain: Buffer | string) => {
    const iv = randomBytes(16);
    const c = createCipheriv("aes-256-cbc", orgKey.subarray(0, 32), iv);
    const ct = Buffer.concat([c.update(plain), c.final()]);
    const mac = createHmac("sha256", orgKey.subarray(32)).update(Buffer.concat([iv, ct])).digest();
    return `2.${iv.toString("base64")}|${ct.toString("base64")}|${mac.toString("base64")}`;
  };
  const wrapped = publicEncrypt({ key: Buffer.from(publicKey, "base64"), format: "der", type: "spki", padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: "sha1" }, orgKey);
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048, publicKeyEncoding: { type: "spki", format: "der" }, privateKeyEncoding: { type: "pkcs8", format: "der" } });
  const org = (await call(BASE, "POST", "/api/organizations", {
    token,
    json: {
      name: orgName, billingEmail: u.email, planType: 0, collectionName: enc(collectionName), key: `4.${wrapped.toString("base64")}`,
      keys: { publicKey: pair.publicKey.toString("base64"), encryptedPrivateKey: enc(pair.privateKey) },
    },
  })) as { id: string };
  const sync = (await call(BASE, "GET", "/api/sync?excludeDomains=true", { token })) as { collections: { id: string; organizationId: string }[] };
  const coll = sync.collections.find((c) => c.organizationId === org.id)!;
  await call(BASE, "POST", "/api/ciphers/create", {
    token,
    json: { cipher: { type: 2, name: enc(noteName), notes: null, secureNote: { type: 0 }, organizationId: org.id, encryptedFor: userId }, collectionIds: [coll.id] },
  });
}

// A plain login page for autofill tests, reachable as localhost:8099 (matches) and 127.0.0.1:8099 (does not).
export const SITE = "http://localhost:8099";
export const LOGIN_FORM = `<form onsubmit="return false"><input id="u" name="user" autocomplete="username"><input id="p" type="password" name="pw"><button type="button" id="show">Show</button><button>Sign in</button></form>`;
export const pages: Record<string, string> = {
  "/card": `<form><input id="cn" autocomplete="cc-name"><input id="cc" autocomplete="cc-number"><select id="m" autocomplete="cc-exp-month"><option></option><option>01</option><option>02</option></select><input id="y" name="exp-year"><input id="cvc" name="cvc"></form>`,
  "/identity": `<form><input id="fn" autocomplete="given-name"><input id="ln" autocomplete="family-name"><input id="em" type="email" autocomplete="email"><input id="ph" type="tel" autocomplete="tel"><input id="ad" autocomplete="address-line1"><input id="ci" autocomplete="address-level2"><input id="zi" autocomplete="postal-code"></form>`,
  // Login fields inside an open shadow root.
  "/shadow": `<div id="host"></div><script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = ${JSON.stringify(LOGIN_FORM)};</script>`,
  // Fills the form and fires submit on load, with no user gesture at all.
  "/forge": `${LOGIN_FORM}<script>onload = () => { document.getElementById("u").value = "forged-user"; document.getElementById("p").value = "forged-guess"; document.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); };</script>`,
  "/change": `<form onsubmit="return false"><input id="u" autocomplete="username"><input id="cur" type="password" autocomplete="current-password"><input id="new" type="password" autocomplete="new-password"><input id="rep" type="password"><button>Change</button></form>`,
  "/register": `<form onsubmit="return false"><input id="u" type="email"><input id="p" type="password" autocomplete="new-password"><button>Go</button></form>`,
  "/split-shadow": `<div><x-a></x-a><x-b></x-b></div><script>
    document.querySelector("x-a").attachShadow({ mode: "open" }).innerHTML = '<input id="u" type="email">';
    document.querySelector("x-b").attachShadow({ mode: "open" }).innerHTML = '<input id="p" type="password">';
  </script>`,
  "/spa-login": `<div><input id="u" name="username"><input id="p" type="password"><button id="go" type="button"><span>Sign in</span></button></div>`,
  "/framed": `<p>outer</p><iframe id="f" src="/login" style="width:500px;height:200px"></iframe>`,
  // A zero-size password decoy in front of the real form, and a two-step login with no password at all.
  "/decoy": `<input id="decoy" type="password" style="position:absolute;width:0;height:0;opacity:0;border:0">${LOGIN_FORM}`,
  // A single-page app that renders its login long after load.
  "/late-login": `<div id="app"></div><script>setTimeout(() => { document.getElementById("app").innerHTML = ${JSON.stringify(LOGIN_FORM)}; }, 1200);</script>`,
  "/otp": `<form onsubmit="return false"><label for="code">Verification code</label><input id="code" autocomplete="off"><button>Verify</button></form>`,
  "/autosubmit": `<form onsubmit="window.submitted = true; return false"><input id="u" name="username"><input id="p" type="password" name="password"><button>Sign in</button></form>`,
  "/custom": `<form onsubmit="return false"><input id="u" name="username"><input id="p" type="password" name="password"><input id="member" name="member_no"><input id="alias" name="alias"><input type="checkbox" id="terms" name="terms"></form>`,
  // A login in a modal <dialog> (everything outside it is inert) and in a focus-trapping ARIA modal.
  "/modal": `<dialog id="d">${LOGIN_FORM}</dialog><script>document.getElementById("d").showModal();</script>`,
  "/trap": `<div id="m" role="dialog" aria-modal="true">${LOGIN_FORM}</div><script>document.addEventListener("focusin", (e) => { if (!document.getElementById("m").contains(e.target)) document.getElementById("u").focus(); });</script>`,
  // A payment form's one-field iframe (another origin), far too small for the menu.
  "/card-number": `<input id="cc" autocomplete="cc-number" style="width:280px">`,
  "/card-exp": `<input id="exp" autocomplete="cc-exp" style="width:120px">`,
  "/card-cvc": `<input id="cvc" autocomplete="cc-csc" style="width:80px">`,
  // A checkout that puts each card field in its own frame, all on the payment provider's origin.
  "/split-card": ["number", "exp", "cvc"].map((f) => `<iframe id="${f}" src="http://127.0.0.1:8099/card-${f}" style="width:300px;height:44px"></iframe>`).join(""),
  "/tiny-frame": `<p>Checkout</p><iframe id="f" src="http://127.0.0.1:8099/card-number" style="width:300px;height:44px;border:1px solid #888"></iframe>`,
  // A login at the very bottom of the window: no room for the menu under it.
  "/bottom": `<div style="height:calc(100vh - 60px)"></div>${LOGIN_FORM}`,
  // A web component that keeps its login in a closed shadow root; the page keeps the root for the test to read.
  "/closed-shadow": `<div id="host"></div><script>window.root = document.getElementById("host").attachShadow({ mode: "closed" }); window.root.innerHTML = ${JSON.stringify(LOGIN_FORM)};</script>`,
  // A sign-in embedded from another origin, allowed (or not) to use WebAuthn by the page's permissions policy.
  "/pk-frame": `<iframe id="pf" src="http://127.0.0.1:8099/login" allow="publickey-credentials-get *; publickey-credentials-create *" style="width:500px;height:200px"></iframe>`,
  "/pk-frame-denied": `<iframe id="pf" src="http://127.0.0.1:8099/login" style="width:500px;height:200px"></iframe>`,
  "/useronly": `<form onsubmit="return false"><input id="u" name="login" placeholder="Email or phone"><button type="submit">Next</button></form>`,
};
export const site = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><title>Test site</title>${pages[new URL(req.url!, SITE).pathname] ?? LOGIN_FORM}`);
}).listen(8099);


// ---------- browser ----------

export const ext = join(root, "dist/ext-e2e");
export const profile = mkdtempSync(join(tmpdir(), "warren-e2e-"));
export const ctx = await chromium.launchPersistentContext(profile, {
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chromium" }),
  headless: process.env.HEADED ? false : true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});


export const sw: Worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
export const id = new URL(sw.url()).host;
export const popupUrl = `chrome-extension://${id}/popup.html`;
// Extension origins cannot be granted clipboard-read, so read the (browser-wide) clipboard from a server page.
await ctx.grantPermissions(["clipboard-read"], { origin: new URL(BASE).origin });
export const readClipboard = async () => {
  const p = await ctx.newPage();
  try {
    await p.goto(`${BASE}/alive`);
    return await p.evaluate(() => navigator.clipboard.readText());
  } finally {
    await p.close();
  }
};
// A live binding: groups read it, only setPage changes it.
export let page: Page = await ctx.newPage();
export const setPage = (p: Page) => void (page = p);
export const open = async () => {
  await page.goto(popupUrl);
  await page.locator("#app .page").waitFor();
};
export const heading = () => page.locator("#app h1").first().textContent();
export const fill = async (label: string, value: string) => page.getByLabel(label, { exact: true }).fill(value);
export const click = async (name: string) => page.getByRole("button", { name, exact: true }).click();
export const loginAs = async (u: TestUser) => {
  await fill("Email", u.email);
  await fill("Master password", u.password);
  await click("Log in");
};
export const expectUnlocked = () => page.getByRole("searchbox", { name: "Search vault" }).waitFor({ timeout: 20_000 });
export const unlockIfLocked = async () => {
  await page.goto(popupUrl);
  await page.locator("#app .page").waitFor();
  if (await page.getByRole("heading", { name: "Vault locked" }).count()) {
    await fill("Master password", "test-vault-pw");
    await click("Unlock");
    await expectUnlocked();
  }
};
export const logout = async () => {
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Log out" }).click();
  await page.getByRole("button", { name: "Click again to log out" }).click();
  await page.getByRole("heading", { name: "Log in" }).waitFor();
};

/** A virtual CTAP2 security key (CDP WebAuthn domain) that always answers with user verification. */
export const authenticator = {
  protocol: "ctap2" as const, transport: "usb" as const, hasResidentKey: true, hasUserVerification: true,
  isUserVerified: true, automaticPresenceSimulation: true,
};

// The opening button of each vault row (the row itself is the list item).
export const rows = () => page.getByRole("list").getByRole("listitem").locator(".row-main");
export const back = () => page.getByRole("button", { name: "Back" }).click();

/**
 * Leaves the popup unlocked, so a group can start on its own (--only): configures the server on a fresh profile and
 * logs in a new user. A popup that is already unlocked, as in a full run, is left as it is.
 */
export async function ensureSignedIn() {
  await open();
  if (await page.getByRole("searchbox", { name: "Search vault" }).count()) return;
  if (await page.getByLabel("Server URL", { exact: true }).count()) {
    await fill("Server URL", BASE);
    await click("Continue");
    await page.getByRole("heading", { name: "Log in" }).waitFor();
  }
  if (!(await page.getByRole("heading", { name: "Log in" }).count())) throw new Error(`ensureSignedIn: unexpected popup state: ${await heading()}`);
  await loginAs(await register("group", [0, 600000, 0, 0]));
  await expectUnlocked();
}
