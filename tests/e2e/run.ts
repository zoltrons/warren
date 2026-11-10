// End-to-end test: real extension in a Chromium 156 browser against a local Vaultwarden.
//   docker compose -f dev/vaultwarden/docker-compose.yml up -d
//   bash tools/build-wasm.sh --features register --out dist/wasm-register   (test-only account setup)
//   node tools/fetch-psl.mjs && node tools/build.mjs --e2e
//   CHROME_PATH=<chromium-based browser that honours --load-extension> npm run test:e2e
import assert from "node:assert/strict";
import { constants, createCipheriv, createDecipheriv, createHash, createHmac, createPublicKey, generateKeyPairSync, pbkdf2Sync, publicEncrypt, randomBytes, verify } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium, type Locator, type Page, type Worker } from "playwright-core";
import { answerAuthRequest, authRequestStatus, createAuthRequest, passwordToken, pendingAuthRequests, prelogin, refreshToken, revisionDate } from "../../src/transport/auth.ts";
import { call } from "../../src/transport/http.ts";

const BASE = process.env.VW_URL ?? "http://localhost:8080";
const root = join(import.meta.dirname, "../..");
const TOTP_KEY = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP"; // test fixture, 20 bytes

const wasmDir = join(root, "dist/wasm-register");
const wasm = await import(pathToFileURL(join(wasmDir, "core_wasm.js")).href);
await wasm.default({ module_or_path: readFileSync(join(wasmDir, "core_wasm_bg.wasm")) });

type Kdf = [number, number, number, number];
interface TestUser { email: string; password: string; kdf: Kdf }

/** A click that closes its own window (a passkey decision): the window going away mid-click is success. */
async function closingClick(w: Page, target: Locator) {
  await target.click().catch((e: unknown) => {
    if (!w.isClosed()) throw e;
  });
}

const passed: string[] = [];
let currentPage: Page | undefined;
async function step(name: string, fn: () => Promise<void>) {
  const t = performance.now();
  try {
    await fn();
  } catch (e) {
    console.error(`FAIL ${name}\n  popup: ${(await currentPage?.locator("#app").innerText().catch(() => "?"))?.replace(/\s+/g, " ")}`);
    throw e;
  }
  passed.push(`ok  ${name} (${Math.round(performance.now() - t)} ms)`);
  console.log(passed.at(-1));
}

// ---------- server-side fixtures (through the API, like a fresh client would) ----------

function authHash(u: TestUser): string {
  const h = wasm.deriveMasterKey(u.password, u.email, ...u.kdf);
  try {
    return wasm.makeAuthHash(h, u.password, false);
  } finally {
    wasm.freeMasterKey(h);
  }
}

async function register(label: string, kdf: Kdf): Promise<TestUser> {
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
async function poll(what: string, check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.fail(`timed out waiting for ${what}`);
}

const totpNow = (key = TOTP_KEY) => JSON.parse(wasm.totp(key, Date.now())) as { code: string; remaining: number };
/** The two-step login key: the server picks it (get-authenticator), so it is known only after enableTotp. */
let twoFactorKey = "";

/** Vaultwarden rejects a TOTP code twice in the same step, so wait for a fresh one. */
async function freshTotp(): Promise<string> {
  await new Promise((r) => setTimeout(r, (totpNow(twoFactorKey).remaining + 1) * 1000));
  return totpNow(twoFactorKey).code;
}

/** Vaultwarden's flow: get-authenticator returns a key and a verification token bound to it; enabling needs both. */
async function enableTotp(u: TestUser): Promise<void> {
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
async function apiSession(u: TestUser) {
  const tok = await passwordToken(BASE, { email: u.email, authHash: authHash(u), deviceId: crypto.randomUUID() });
  const h = wasm.deriveMasterKey(u.password, u.email, ...u.kdf);
  wasm.unlockUserKey(h, tok.Key!, tok.PrivateKey);
  const userId = JSON.parse(Buffer.from(tok.access_token.split(".")[1]!, "base64url").toString()).sub as string;
  const token = tok.access_token;
  return {
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
async function createOrgNote(u: TestUser, orgName: string, collectionName: string, noteName: string): Promise<void> {
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
const SITE = "http://localhost:8099";
const LOGIN_FORM = `<form onsubmit="return false"><input id="u" name="user" autocomplete="username"><input id="p" type="password" name="pw"><button type="button" id="show">Show</button><button>Sign in</button></form>`;
const pages: Record<string, string> = {
  "/card": `<form><input id="cn" autocomplete="cc-name"><input id="cc" autocomplete="cc-number"><select id="m" autocomplete="cc-exp-month"><option></option><option>01</option><option>02</option></select><input id="y" name="exp-year"><input id="cvc" name="cvc"></form>`,
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
  "/useronly": `<form onsubmit="return false"><input id="u" name="login" placeholder="Email or phone"><button type="submit">Next</button></form>`,
};
const site = createServer((req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(`<!doctype html><title>Test site</title>${pages[new URL(req.url!, SITE).pathname] ?? LOGIN_FORM}`);
}).listen(8099);

// ---------- browser ----------

const ext = join(root, "dist/ext");
const profile = mkdtempSync(join(tmpdir(), "warren-e2e-"));
const ctx = await chromium.launchPersistentContext(profile, {
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: "chromium" }),
  headless: process.env.HEADED ? false : true,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});

try {
  const sw: Worker = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent("serviceworker"));
  const id = new URL(sw.url()).host;
  const popupUrl = `chrome-extension://${id}/popup.html`;
  // Extension origins cannot be granted clipboard-read, so read the (browser-wide) clipboard from a server page.
  await ctx.grantPermissions(["clipboard-read"], { origin: new URL(BASE).origin });
  const readClipboard = async () => {
    const p = await ctx.newPage();
    try {
      await p.goto(`${BASE}/alive`);
      return await p.evaluate(() => navigator.clipboard.readText());
    } finally {
      await p.close();
    }
  };
  let page: Page = await ctx.newPage();
  currentPage = page;
  const open = async () => {
    await page.goto(popupUrl);
    await page.locator("#app .page").waitFor();
  };
  const heading = () => page.locator("#app h1").first().textContent();
  const fill = async (label: string, value: string) => page.getByLabel(label, { exact: true }).fill(value);
  const click = async (name: string) => page.getByRole("button", { name, exact: true }).click();
  const loginAs = async (u: TestUser) => {
    await fill("Email", u.email);
    await fill("Master password", u.password);
    await click("Log in");
  };
  const expectUnlocked = () => page.getByRole("searchbox", { name: "Search vault" }).waitFor({ timeout: 20_000 });
  const unlockIfLocked = async () => {
    await page.goto(popupUrl);
    await page.locator("#app .page").waitFor();
    if (await page.getByRole("heading", { name: "Vault locked" }).count()) {
      await fill("Master password", "test-vault-pw");
      await click("Unlock");
      await expectUnlocked();
    }
  };
  const logout = async () => {
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Log out" }).click();
    await page.getByRole("button", { name: "Click again to log out" }).click();
    await page.getByRole("heading", { name: "Log in" }).waitFor();
  };

  const pbkdf2 = await register("pbkdf2", [0, 600000, 0, 0]);
  const argon = await register("argon2", [1, 3, 64, 4]);
  const totpUser = await register("totp", [0, 600000, 0, 0]);
  await enableTotp(totpUser);

  await step("transport: prelogin, password grant, refresh grant, revision-date", async () => {
    const kdf = await prelogin(BASE, argon.email);
    assert.deepEqual([kdf.type, kdf.iterations, kdf.memory, kdf.parallelism], argon.kdf);
    const t = await passwordToken(BASE, { email: argon.email, authHash: authHash(argon), deviceId: crypto.randomUUID() });
    assert.ok(t.Key && t.PrivateKey && t.refresh_token);
    const r = await refreshToken(BASE, t.refresh_token!);
    assert.ok((await revisionDate(BASE, r.access_token)) > 0);
  });

  await step("setup: server URL + host permission", async () => {
    await open();
    assert.equal(await heading(), "Warren");
    await fill("Server URL", BASE);
    await click("Continue");
    await page.getByRole("heading", { name: "Log in" }).waitFor();
  });

  await step("login PBKDF2-600k", async () => {
    await loginAs(pbkdf2);
    await expectUnlocked();
    assert.equal(await sw.evaluate(() => chrome.offscreen.hasDocument()), true);
  });

  await step("popup first render < 100 ms (unlocked state)", async () => {
    await open();
    await expectUnlocked();
    const ms = await page.evaluate(() => performance.getEntriesByName("warren:first-render")[0]?.startTime ?? -1);
    console.log(`    first render ${ms.toFixed(1)} ms`);
    assert.ok(ms > 0 && ms < 100, `first render took ${ms} ms`);
  });

  await step("lock drops keys; wrong password rejected; unlock works", async () => {
    await page.getByRole("button", { name: "Lock now" }).click();
    await page.getByRole("heading", { name: "Vault locked" }).waitFor();
    assert.equal(await sw.evaluate(() => chrome.offscreen.hasDocument()), false);
    await fill("Master password", "wrong-password");
    await click("Unlock");
    await page.getByRole("alert").filter({ hasText: "Wrong master password" }).waitFor();
    await fill("Master password", pbkdf2.password);
    await click("Unlock");
    await expectUnlocked();
  });

  await step("PIN: set in settings, unlocks the locked vault, wrong PIN refused, never stored in clear", async () => {
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Unlock with PIN").check();
    await page.getByLabel("PIN", { exact: true }).fill("4826");
    await click("Set PIN");
    await poll("PIN armed", () => sw.evaluate(async () => !!(await chrome.storage.session.get("session")).session?.pin));
    const dump = await sw.evaluate(async () => JSON.stringify([await chrome.storage.local.get(null), await chrome.storage.session.get(null)]));
    assert.ok(!dump.includes("4826"), "PIN found in storage");
    await page.getByRole("button", { name: "Lock now" }).click();
    await page.getByRole("heading", { name: "Vault locked" }).waitFor();
    assert.equal(await sw.evaluate(() => chrome.offscreen.hasDocument()), false);
    await fill("PIN", "0000");
    await click("Unlock");
    await page.getByRole("alert").filter({ hasText: "Wrong PIN" }).waitFor();
    await fill("PIN", "4826");
    await click("Unlock");
    await expectUnlocked();
  });

  await step("PIN: after a browser restart the master password re-arms it", async () => {
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "lock" }));
    // A restart empties storage.session; drop the PIN-wrapped key the same way.
    await sw.evaluate(async () => {
      const { session } = await chrome.storage.session.get("session");
      delete session.pin;
      await chrome.storage.session.set({ session });
    });
    await open();
    await page.getByRole("heading", { name: "Vault locked" }).waitFor();
    assert.equal(await page.getByLabel("PIN", { exact: true }).count(), 0);
    await fill("Master password", pbkdf2.password);
    await click("Unlock");
    await expectUnlocked();
    await poll("PIN re-armed", () => sw.evaluate(async () => !!(await chrome.storage.session.get("session")).session?.pin));
  });

  await step("PIN: five wrong PINs log out", async () => {
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "lock" }));
    await open();
    for (let i = 0; i < 5; i++) {
      await fill("PIN", "1111");
      await click("Unlock");
      await page.getByRole("alert").waitFor();
    }
    await page.getByRole("alert").filter({ hasText: "logged out" }).waitFor();
    await open();
    await page.getByRole("heading", { name: "Log in" }).waitFor();
    await loginAs(pbkdf2);
    await expectUnlocked();
  });

  await step("no secrets in extension storage", async () => {
    const dump = await sw.evaluate(async () =>
      JSON.stringify([await chrome.storage.local.get(null), await chrome.storage.session.get(null)]),
    );
    assert.ok(!dump.includes(pbkdf2.password), "master password found in storage");
    assert.ok(!dump.includes(authHash(pbkdf2)), "auth hash found in storage");
  });

  await step("auto-lock alarm locks the vault", async () => {
    await sw.evaluate(() => chrome.alarms.create("autolock", { when: Date.now() + 200 }));
    await page.waitForTimeout(2000);
    await open();
    await page.getByRole("heading", { name: "Vault locked" }).waitFor();
    await fill("Master password", pbkdf2.password);
    await click("Unlock");
    await expectUnlocked();
  });

  await step("timeout action 'log out' forgets the account; login Argon2id 3/64MiB/4", async () => {
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Timeout action").selectOption("logout");
    // Requests run in order and each re-arms the auto-lock alarm before replying: once this no-op
    // answers, the select's request has done so too and cannot push our short alarm back.
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "setSettings" }));
    assert.equal(await sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings?.timeoutAction), "logout");
    await sw.evaluate(() => chrome.alarms.create("autolock", { when: Date.now() + 200 }));
    await page.waitForTimeout(2000);
    await open();
    await page.getByRole("heading", { name: "Log in" }).waitFor();
    assert.equal(await sw.evaluate(async () => Object.keys(await chrome.storage.local.get(["account", "vault"])).length), 0);
    await sw.evaluate(async () => {
      const { settings } = await chrome.storage.local.get("settings");
      await chrome.storage.local.set({ settings: { ...settings, timeoutAction: "lock" } });
    });
    await loginAs(argon);
    await expectUnlocked();
  });

  await step("an abandoned two-step login frees its master key without the popup", async () => {
    await logout();
    await loginAs(totpUser);
    await page.getByRole("heading", { name: "Two-step login" }).waitFor();
    const pending = () => sw.evaluate(async () => !!(await chrome.storage.session.get("session")).session?.pending);
    assert.equal(await pending(), true);
    assert.ok(await sw.evaluate(() => chrome.alarms.get("pendingLogin")), "expiry alarm not scheduled");
    await sw.evaluate(() => chrome.alarms.create("pendingLogin", { when: Date.now() + 100 }));
    await poll("pending login freed", async () => !(await pending()));
    await page.goto(popupUrl);
    await loginAs(pbkdf2);
    await expectUnlocked();
  });

  await step("TOTP two-step login with remember-device", async () => {
    await logout();
    const code = await freshTotp();
    await loginAs(totpUser);
    await page.getByRole("heading", { name: "Two-step login" }).waitFor();
    await fill("Verification code", "000000");
    await click("Continue");
    await page.getByRole("alert").waitFor();
    await fill("Verification code", code);
    await page.getByText("Remember this device").click();
    await click("Continue");
    await expectUnlocked();
  });

  await step("remembered device skips the second step", async () => {
    await logout();
    await loginAs(totpUser);
    await expectUnlocked();
  });

  await step("YubiKey OTP two-step login sends provider 3 with the typed OTP", async () => {
    await logout();
    // Vaultwarden checks OTPs with Yubico's servers, so stand in for the server's 2FA answer inside the
    // service worker; the second request (with the OTP) goes to the real server, which logs in this
    // user without two-step login.
    await sw.evaluate(() => {
      const real = globalThis.fetch;
      const g = globalThis as unknown as { yubiSeen: (string | null)[] };
      globalThis.fetch = async (input, init) => {
        const form = new URLSearchParams(String(init?.body ?? ""));
        if (String(input).endsWith("/identity/connect/token") && form.get("grant_type") === "password") {
          if (!form.has("twoFactorProvider"))
            return new Response(JSON.stringify({ error: "invalid_grant", TwoFactorProviders: ["3"], TwoFactorProviders2: { "3": { Nfc: true } } }), { status: 400 });
          g.yubiSeen = [form.get("twoFactorProvider"), form.get("twoFactorToken")];
          globalThis.fetch = real;
        }
        return real(input, init);
      };
    });
    await loginAs(pbkdf2);
    await page.getByRole("button", { name: "YubiKey" }).waitFor();
    const otp = "cccccbcjdifctrndncchkftchjlnbhvhtugdljibejrv";
    await fill("Verification code", otp);
    await page.getByLabel("Verification code", { exact: true }).press("Enter");
    await expectUnlocked();
    assert.deepEqual(await sw.evaluate(() => (globalThis as unknown as { yubiSeen: unknown }).yubiSeen), ["3", otp]);
  });

  // ---------- WebAuthn two-step login ----------
  const keyUser = await register("webauthn", [0, 600000, 0, 0]);
  // Virtual authenticator on a page of the server origin registers the key like the web vault would.
  const regPage = await ctx.newPage();
  await regPage.goto(`${BASE}/alive`);
  const regCdp = await ctx.newCDPSession(regPage);
  await regCdp.send("WebAuthn.enable", { enableUI: false });
  const authenticator = {
    protocol: "ctap2" as const, transport: "usb" as const, hasResidentKey: true, hasUserVerification: true,
    isUserVerified: true, automaticPresenceSimulation: true,
  };
  const { authenticatorId: regAuth } = await regCdp.send("WebAuthn.addVirtualAuthenticator", { options: authenticator });
  {
    const tok = await passwordToken(BASE, { email: keyUser.email, authHash: authHash(keyUser), deviceId: crypto.randomUUID() });
    // Vaultwarden's flow: get-webauthn trades the password for a verification token the next two calls need.
    const { userVerificationToken } = (await call(BASE, "POST", "/api/two-factor/get-webauthn", {
      token: tok.access_token,
      json: { masterPasswordHash: authHash(keyUser) },
    })) as { userVerificationToken: string };
    const json = { userVerificationToken };
    const { options: challenge } = (await call(BASE, "POST", "/api/two-factor/get-webauthn-challenge", { token: tok.access_token, json })) as { options: unknown };
    // The passkey shim offers to save this key in the vault; hand it to the security key instead.
    const handBack = ctx.waitForEvent("page", { predicate: (p) => p.url().includes("popup.html?passkey=") })
      .then((w) => closingClick(w, w.getByRole("button", { name: "Use another device or browser" })));
    const deviceResponse = await regPage.evaluate(async (opts: any) => {
      const bytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      const b64u = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
      opts.challenge = bytes(opts.challenge);
      opts.user.id = bytes(opts.user.id);
      opts.excludeCredentials = (opts.excludeCredentials ?? []).map((c: any) => ({ ...c, id: bytes(c.id) }));
      const c = (await navigator.credentials.create({ publicKey: opts })) as PublicKeyCredential;
      const r = c.response as AuthenticatorAttestationResponse;
      return { id: c.id, rawId: b64u(c.rawId), type: c.type, response: { attestationObject: b64u(r.attestationObject), clientDataJson: b64u(r.clientDataJSON) } };
    }, challenge);
    await handBack;
    await call(BASE, "POST", "/api/two-factor/webauthn", { token: tok.access_token, json: { ...json, id: 1, name: "e2e key", deviceResponse } });
  }
  const { credentials } = await regCdp.send("WebAuthn.getCredentials", { authenticatorId: regAuth });
  await regPage.close();

  await step("WebAuthn two-step login through the server's connector page", async () => {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("WebAuthn.enable", { enableUI: false });
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", { options: authenticator });
    await cdp.send("WebAuthn.addCredential", { authenticatorId, credential: credentials[0]! });
    await logout();
    // The virtual key answers at once, so the 2FA screen may be gone before we look; watch the connector frame instead.
    const connector = page.waitForEvent("framenavigated", (f) => f.url().startsWith(`${BASE}/webauthn-connector.html`));
    await loginAs(keyUser);
    await connector;
    await expectUnlocked();
    await cdp.detach();
  });

  await step("side panel: same UI, fluid width, offered from settings", async () => {
    assert.equal((await sw.evaluate(() => chrome.sidePanel.getOptions({}))).path, "sidepanel.html");
    const panel = await ctx.newPage();
    await panel.setViewportSize({ width: 520, height: 800 });
    await panel.goto(`chrome-extension://${id}/sidepanel.html`);
    await panel.getByRole("searchbox", { name: "Search vault" }).waitFor();
    assert.equal(await panel.evaluate(() => document.body.getBoundingClientRect().width), 520);
    await panel.getByRole("button", { name: "Settings" }).click();
    assert.equal(await panel.getByRole("button", { name: "Open in side panel" }).count(), 0);
    await panel.close();
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: "Open in side panel" }).waitFor();
    await page.getByRole("button", { name: "Vault", exact: true }).click();
  });

  // ---------- Send ----------
  const openSendTab = async () => {
    await page.getByRole("navigation").getByRole("button", { name: "Send" }).click();
    await page.getByRole("heading", { name: "Send", exact: true }).waitFor();
  };
  // A recipient opens the link. The web vault refuses plain-http servers, so this is the recipient
  // flow over the API, decrypted with node:crypto (written from the spec, independent of core-wasm).
  const receive = async (link: string, password?: string) => {
    const m = /^(.+)\/#\/send\/([\w-]+)\/([\w-]+)$/.exec(link);
    assert.ok(m && m[1] === BASE, link);
    const [accessId, urlKey] = [m[2]!, m[3]!];
    const secret = Buffer.from(urlKey, "base64url");
    const prk = createHmac("sha256", "bitwarden-send").update(secret).digest();
    const t1 = createHmac("sha256", prk).update(Buffer.from("send\x01")).digest(); // HKDF-Expand, info "send"
    const t2 = createHmac("sha256", prk).update(Buffer.concat([t1, Buffer.from("send\x02")])).digest();
    const open = (iv: Buffer, mac: Buffer, ct: Buffer) => {
      assert.ok(createHmac("sha256", t2).update(Buffer.concat([iv, ct])).digest().equals(mac), "send MAC mismatch");
      const d = createDecipheriv("aes-256-cbc", t1, iv);
      return Buffer.concat([d.update(ct), d.final()]);
    };
    const str = (enc: string) => {
      const [iv, ct, mac] = enc.slice(2).split("|").map((b) => Buffer.from(b, "base64"));
      assert.equal(enc.slice(0, 2), "2.");
      return open(iv!, mac!, ct!).toString("utf8");
    };
    const form: Record<string, string> = { grant_type: "send_access", client_id: "web", send_id: accessId };
    if (password) form.password_hash_b64 = pbkdf2Sync(password, secret, 100_000, 32, "sha256").toString("base64");
    const { access_token: token } = (await call(BASE, "POST", "/identity/connect/token", { form })) as { access_token: string };
    const s = (await call(BASE, "POST", "/api/sends/access", { token })) as any;
    let file: Buffer | undefined;
    if (s.file) {
      const { url } = (await call(BASE, "POST", `/api/sends/access/file/${s.file.id}`, { token })) as { url: string };
      const b = Buffer.from(await (await fetch(url)).arrayBuffer());
      assert.equal(b[0], 2);
      file = open(b.subarray(1, 17), b.subarray(17, 49), b.subarray(49));
    }
    return { name: str(s.name), text: s.text?.text ? str(s.text.text) : undefined, fileName: s.file ? str(s.file.fileName) : undefined, file };
  };

  await step("Send: text send link decrypts for a recipient", async () => {
    await openSendTab();
    await page.getByRole("button", { name: "New Send" }).click();
    await fill("Name", "Wifi for guests");
    await page.getByLabel("Text", { exact: true }).fill("guest-wifi-pass-42");
    await page.getByRole("button", { name: "Create and copy link" }).click();
    await page.getByRole("listitem").filter({ hasText: "Wifi for guests" }).waitFor();
    const r = await receive(await readClipboard());
    assert.deepEqual([r.name, r.text], ["Wifi for guests", "guest-wifi-pass-42"]);
  });

  let reportLink = "";
  await step("Send: password-protected file send; server checks our password hash", async () => {
    await page.getByRole("button", { name: "New Send" }).click();
    await fill("Name", "Report");
    await page.getByRole("button", { name: "File", exact: true }).click();
    await page.getByLabel("File", { exact: true }).setInputFiles({ name: "report.txt", mimeType: "text/plain", buffer: Buffer.from("quarterly numbers\n") });
    await fill("Password (optional)", "s3nd-pw");
    await page.getByRole("button", { name: "Create and copy link" }).click();
    await page.getByRole("listitem").filter({ hasText: "Report" }).waitFor();
    const link = (reportLink = await readClipboard());
    await assert.rejects(receive(link, "wrong-pw"));
    const r = await receive(link, "s3nd-pw");
    assert.deepEqual([r.name, r.fileName, r.file?.toString("utf8")], ["Report", "report.txt", "quarterly numbers\n"]);
  });

  await step("Send: edit renames, keeps link and password; disabling stops access", async () => {
    await page.getByRole("button", { name: "Edit Report" }).click();
    await page.getByRole("heading", { name: "Edit Send" }).waitFor();
    await fill("Name", "Report Q3");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("listitem").filter({ hasText: "Report Q3" }).waitFor();
    assert.equal((await receive(reportLink, "s3nd-pw")).name, "Report Q3");
    await page.getByRole("button", { name: "Edit Report Q3" }).click();
    await page.getByLabel("Disable this Send").check();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("listitem").filter({ hasText: "Disabled" }).waitFor();
    await assert.rejects(receive(reportLink, "s3nd-pw"));
  });

  await step("Send: delete removes it on the server", async () => {
    await page.getByRole("button", { name: "Delete Wifi for guests" }).click();
    await page.getByRole("button", { name: "Click again to delete" }).click();
    await page.getByRole("status").filter({ hasText: "Send deleted" }).waitFor();
    // Full sync from the server, then a fresh popup that reads the list from the worker again.
    await sw.evaluate(() => chrome.storage.local.remove("vault"));
    await open();
    await expectUnlocked();
    await openSendTab();
    await page.getByRole("listitem").filter({ hasText: "Report" }).waitFor();
    assert.equal(await page.getByRole("listitem").filter({ hasText: "Wifi for guests" }).count(), 0);
    assert.equal(await page.getByRole("listitem").filter({ hasText: "Report" }).count(), 1);
  });

  // ---------- vault ----------
  const vaultUser = await register("vault", [1, 3, 64, 4]);
  const api = await apiSession(vaultUser);
  const work = await api.folder("Work");
  await api.create({ type: 1, name: "GitHub", folderId: work.id, login: { username: "octo", password: "gh-secret-1", totp: TOTP_KEY, uris: [{ uri: "https://github.com/login", match: null }] }, fields: [{ name: "PIN", value: "4321", type: 1 }] });
  // Keyed, so the attachments step covers an attachment key wrapped with the item's own key.
  await api.create({ type: 2, name: "Wifi note", notes: "SSID: home\npassword: hunter2", secureNote: { type: 0 } }, true);
  await api.create({ type: 3, name: "Visa", card: { cardholderName: "Ada L", number: "4111111111111111", code: "123", brand: "Visa", expMonth: "1", expYear: "2030" } });
  api.done();
  // The opening button of each vault row (the row itself is the list item).
  const rows = () => page.getByRole("list").getByRole("listitem").locator(".row-main");
  const back = () => page.getByRole("button", { name: "Back" }).click();

  await step("vault: sync, list, search, folder filter", async () => {
    await logout();
    await loginAs(vaultUser);
    await expectUnlocked();
    await page.getByRole("listitem").filter({ hasText: "GitHub" }).waitFor();
    assert.equal(await rows().count(), 3);
    await page.getByRole("searchbox").fill("wifi");
    assert.equal(await rows().count(), 1);
    await page.getByRole("searchbox").fill("");
    await page.getByRole("button", { name: "Work", exact: true }).click();
    assert.equal(await rows().count(), 1);
    assert.match(await rows().first().innerText(), /GitHub/);
    await page.getByRole("button", { name: "Work", exact: true }).click(); // chips toggle off again
    assert.equal(await rows().count(), 3);
  });

  await step("website icons are off by default, come from the server's icon service and can be turned off", async () => {
    const icon = () => rows().filter({ hasText: "GitHub" }).locator(".tile img");
    // Off by default: the hosts would reach the server in clear text.
    assert.equal(await icon().count(), 0);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Show website icons").check();
    await page.getByRole("button", { name: "Vault", exact: true }).click();
    // Fetched once from the server's icon service (to check its tone), then shown from a blob URL.
    await icon().waitFor();
    assert.match((await icon().getAttribute("src")) ?? "", /^blob:/);
    const url = `${BASE}/icons/github.com/icon.png`;
    assert.ok(await page.evaluate((u) => performance.getEntriesByType("resource").some((e) => e.name === u), url), "icon not fetched from the server");
    assert.equal(await rows().filter({ hasText: "Wifi note" }).locator(".tile img").count(), 0);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Show website icons").uncheck();
    await poll("icons setting saved", () => sw.evaluate(async () => (await chrome.storage.local.get("settings")).settings?.favicons === false));
    await page.getByRole("button", { name: "Vault", exact: true }).click();
    await rows().filter({ hasText: "GitHub" }).waitFor();
    assert.equal(await icon().count(), 0);
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByLabel("Show website icons").check();
    await page.getByRole("button", { name: "Vault", exact: true }).click();
    await icon().waitFor();
  });

  await step("item view: reveal password, TOTP matches, hidden field, copy schedules clearing", async () => {
    await rows().filter({ hasText: "GitHub" }).click();
    await page.getByRole("heading", { name: "GitHub" }).waitFor();
    await page.getByRole("button", { name: "Show password" }).first().click();
    await page.getByText("gh-secret-1").waitFor();
    const shown = (await page.locator("[data-totp]").innerText()).replace(/\s/g, "");
    assert.ok([totpNow().code, JSON.parse(wasm.totp(TOTP_KEY, Date.now() - 30_000)).code].includes(shown), `totp ${shown}`);
    assert.ok(!(await page.locator("#app").innerText()).includes("4321"), "hidden custom field shown in clear");
    await page.getByRole("button", { name: "Copy Username" }).click();
    await page.getByRole("status").filter({ hasText: "Copied" }).waitFor();
    assert.ok(await sw.evaluate(() => chrome.alarms.get("clipboard")), "clipboard clear alarm not scheduled");
    assert.equal(await readClipboard(), "octo");
    await sw.evaluate(() => chrome.alarms.create("clipboard", { when: Date.now() + 100 }));
    await page.waitForTimeout(1500);
    assert.equal(await readClipboard(), "", "clipboard not cleared");
    await back();
  });

  await step("card shown with masked number and editable", async () => {
    await rows().filter({ hasText: "Visa" }).click();
    await page.getByRole("heading", { name: "Visa" }).waitFor();
    const text = await page.locator("#app").innerText();
    assert.ok(text.includes("Ada L") && !text.includes("4111111111111111"));
    assert.equal(await page.getByRole("button", { name: "Edit" }).count(), 1);
    await back();
  });

  await step("create login in popup; server copy decrypts independently", async () => {
    await page.getByRole("button", { name: "New item" }).click();
    await fill("Name", "Example");
    await page.getByRole("button", { name: "Generate username" }).click();
    await page.getByRole("button", { name: "Use this username" }).click();
    assert.notEqual(await page.getByLabel("Username", { exact: true }).inputValue(), "");
    await fill("Username", "alice");
    // The generator keeps the form as it was, and its settings apply to the value it hands back.
    await page.getByRole("button", { name: "Generate password" }).click();
    await page.getByRole("button", { name: "Use this password" }).waitFor();
    const length = page.getByRole("slider", { name: "Length" });
    await length.fill("30");
    await page.waitForFunction(() => document.querySelector("output")?.textContent?.length === 30);
    await page.getByRole("button", { name: "Use this password" }).click();
    assert.equal((await page.getByLabel("Password", { exact: true }).inputValue()).length, 30);
    assert.equal(await page.getByLabel("Username", { exact: true }).inputValue(), "alice");
    assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "Example");
    await page.getByRole("button", { name: "Generate password" }).click();
    await length.fill("20"); // later steps expect the default length
    await page.waitForFunction(() => document.querySelector("output")?.textContent?.length === 20);
    await page.getByRole("button", { name: "Back" }).click();
    await page.getByRole("button", { name: "Add website" }).click();
    await fill("Website 1", "example.com");
    await page.getByRole("button", { name: "Add website" }).click();
    await fill("Website 2", "https://login.example.com");
    await page.getByRole("button", { name: "Save" }).click();
    await rows().filter({ hasText: "Example" }).waitFor();
    const s = await apiSession(vaultUser);
    const c = (await s.ciphers()).find((x) => x.name === "Example");
    s.done();
    assert.equal(c?.login.username, "alice");
    assert.equal(c?.login.password.length, 30);
    assert.deepEqual(c?.login.uris.map((u: { uri: string }) => u.uri), ["example.com", "https://login.example.com"]);
  });

  await step("edit password keeps history; stale edits are refused by the server", async () => {
    await rows().filter({ hasText: "GitHub" }).click();
    await page.getByRole("button", { name: "Edit" }).click();
    await fill("Password", "gh-secret-2");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByRole("heading", { name: "GitHub" }).waitFor();
    const s = await apiSession(vaultUser);
    const c = (await s.ciphers()).find((x) => x.name === "GitHub");
    s.done();
    assert.equal(c?.login.password, "gh-secret-2");
    assert.equal(c?.passwordHistory?.[0]?.password, "gh-secret-1");
    assert.equal(c?.fields?.[0]?.value, "4321", "custom field lost on edit");
    assert.equal(c?.login.totp, TOTP_KEY, "totp lost on edit");
    // Another client edits it; our now-stale copy must not overwrite that (server granularity is 1 s).
    await page.waitForTimeout(1500);
    const other = await apiSession(vaultUser);
    await other.update({ ...c, notes: "edited elsewhere" });
    other.done();
    await page.getByRole("button", { name: "Edit" }).click();
    await fill("Password", "gh-secret-3");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByRole("alert").filter({ hasText: "out of date" }).waitFor();
    // Unsaved edits: the first Cancel warns and offers Discard, the second leaves.
    await page.getByRole("button", { name: "Cancel" }).click();
    await page.getByRole("status").filter({ hasText: "Unsaved changes" }).waitFor();
    await page.getByRole("button", { name: "Cancel" }).click();
    await back();
  });

  await step("external change arrives with sync", async () => {
    const s = await apiSession(vaultUser);
    await s.create({ type: 2, name: "Added elsewhere", secureNote: { type: 0 } });
    s.done();
    await page.getByRole("button", { name: "Sync now" }).click();
    await rows().filter({ hasText: "Added elsewhere" }).waitFor();
  });

  await step("push: a change made elsewhere shows in the open popup without a sync", async () => {
    const s = await apiSession(vaultUser);
    await s.create({ type: 2, name: "Pushed in", secureNote: { type: 0 } });
    s.done();
    await rows().filter({ hasText: "Pushed in" }).waitFor({ timeout: 10_000 });
  });

  await step("login request from another device: notification, phrase, approval hands over the user key", async () => {
    // Another device of the same account (Vaultwarden only takes requests from known devices).
    const other = crypto.randomUUID();
    await passwordToken(BASE, { email: vaultUser.email, authHash: authHash(vaultUser), deviceId: other });
    const { publicKey } = JSON.parse(wasm.authRequestCreate(vaultUser.email)) as { publicKey: string };
    const accessCode = randomBytes(16).toString("hex");
    const req = await createAuthRequest(BASE, { email: vaultUser.email, publicKey, deviceId: other, accessCode });
    await page.getByRole("heading", { name: "Login request" }).waitFor({ timeout: 10_000 });
    assert.ok((await sw.evaluate(() => chrome.notifications.getAll()))["loginRequest"], "no notification");
    assert.equal(await page.locator(".phrase").textContent(), wasm.authRequestFingerprint(vaultUser.email, publicKey));
    await click("Confirm login");
    await expectUnlocked();
    assert.ok(!(await sw.evaluate(() => chrome.notifications.getAll()))["loginRequest"], "notification left behind");
    // The requester logs in with the access code and opens the vault with the key we sent.
    const answer = await authRequestStatus(BASE, req.id, accessCode);
    assert.ok(answer.requestApproved && answer.key);
    const t = await passwordToken(BASE, { email: vaultUser.email, authHash: accessCode, deviceId: other, authRequest: req.id });
    wasm.authRequestUnlock(answer.key!, t.PrivateKey);
    const sync = (await call(BASE, "GET", "/api/sync?excludeDomains=true", { token: t.access_token })) as { ciphers: { organizationId?: string }[] };
    const names = sync.ciphers.filter((c) => !c.organizationId).map((c) => JSON.parse(wasm.decryptCipher(JSON.stringify(c))).name);
    assert.ok(names.includes("Pushed in"), names.join());
    wasm.lock();
  });

  await step("log in with device: approved on another device, no master password", async () => {
    await logout();
    await fill("Email", vaultUser.email);
    await click("Log in with device");
    const phrase = await page.locator(".phrase").textContent();
    // The approving device: an unlocked session that checks the phrase against the request's public key.
    const approver = crypto.randomUUID();
    const tok = await passwordToken(BASE, { email: vaultUser.email, authHash: authHash(vaultUser), deviceId: approver });
    const h = wasm.deriveMasterKey(vaultUser.password, vaultUser.email, ...vaultUser.kdf);
    wasm.unlockUserKey(h, tok.Key!, tok.PrivateKey);
    const [r] = await pendingAuthRequests(BASE, tok.access_token);
    assert.ok(r, "request not on the server");
    assert.equal(wasm.authRequestFingerprint(vaultUser.email, r.publicKey), phrase);
    await answerAuthRequest(BASE, tok.access_token, r.id, { key: wasm.authRequestApprove(r.publicKey), deviceId: approver, approve: true });
    wasm.lock();
    await expectUnlocked();
    await rows().filter({ hasText: "Pushed in" }).waitFor();
    // The stored account still unlocks with the master password.
    await page.getByRole("button", { name: "Lock now" }).click();
    await page.getByRole("heading", { name: "Vault locked" }).waitFor();
    await fill("Master password", vaultUser.password);
    await click("Unlock");
    await expectUnlocked();
  });

  await step("attachments: upload in the popup, download decrypts, server copy decrypts", async () => {
    await rows().filter({ hasText: "Wifi note" }).click();
    await page.getByRole("heading", { name: "Wifi note" }).waitFor();
    await page.getByLabel("Add attachment").setInputFiles({ name: "router.txt", mimeType: "text/plain", buffer: Buffer.from("admin / 1234\n") });
    const button = page.getByRole("button", { name: "Download router.txt" });
    await button.waitFor();
    const [dl] = await Promise.all([page.waitForEvent("download"), button.click()]);
    assert.equal(dl.suggestedFilename(), "router.txt");
    assert.equal(readFileSync(await dl.path()).toString(), "admin / 1234\n");
    const s = await apiSession(vaultUser);
    const c = (await s.ciphers()).find((x) => x.name === "Wifi note");
    s.done();
    assert.equal(c?.attachments?.[0]?.fileName, "router.txt");
    await back();
  });

  await step("organization item shows its organization and collection names", async () => {
    await createOrgNote(vaultUser, "Team Alpha", "Engineering", "Team wiki");
    await page.getByRole("button", { name: "Sync now" }).click();
    await rows().filter({ hasText: "Team wiki" }).click();
    await page.getByRole("heading", { name: "Team wiki" }).waitFor();
    await page.getByText("Team Alpha", { exact: true }).waitFor();
    await page.getByText("Engineering", { exact: true }).waitFor();
    await back();
  });

  await step("organization item can be edited by its owner", async () => {
    await rows().filter({ hasText: "Team wiki" }).click();
    await page.getByRole("button", { name: "Edit" }).click();
    await fill("Name", "Team wiki v2");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByRole("heading", { name: "Team wiki v2" }).waitFor();
    await page.getByText("Engineering", { exact: true }).waitFor();
    // An editable organization item takes attachments too, and the item view shows it right after.
    await page.getByLabel("Add attachment").setInputFiles({ name: "org.txt", mimeType: "text/plain", buffer: Buffer.from("shared\n") });
    await page.getByRole("button", { name: "Download org.txt" }).waitFor();
    await back();
  });

  await step("move to trash", async () => {
    await rows().filter({ hasText: "Wifi note" }).click();
    await page.getByRole("button", { name: "Move to trash" }).click();
    await page.getByRole("status").filter({ hasText: "Moved to trash" }).waitFor();
    assert.equal(await rows().filter({ hasText: "Wifi note" }).count(), 0);
    const s = await apiSession(vaultUser);
    const c = (await s.ciphers()).find((x) => x.name === "Wifi note");
    s.done();
    assert.ok(c?.deletedDate, "not in server trash");
  });

  await step("trash: restore, then delete forever", async () => {
    await page.getByRole("button", { name: "Trash (1)" }).click();
    await rows().filter({ hasText: "Wifi note" }).click();
    await page.getByText("This item is in the trash").waitFor();
    await page.getByRole("button", { name: "Restore" }).click();
    await page.getByRole("status").filter({ hasText: "Restored" }).waitFor();
    await rows().filter({ hasText: "Wifi note" }).click();
    await page.getByRole("button", { name: "Move to trash" }).click();
    await page.getByRole("button", { name: "Trash (1)" }).click();
    await rows().filter({ hasText: "Wifi note" }).click();
    await page.getByRole("button", { name: "Delete forever" }).click();
    await page.getByRole("button", { name: "Click again to delete forever" }).click();
    await page.getByRole("status").filter({ hasText: "Deleted" }).waitFor();
    const s = await apiSession(vaultUser);
    assert.equal((await s.ciphers()).filter((x) => x.name === "Wifi note").length, 0);
    s.done();
  });

  await step("editor: new card with a hidden custom field; clone; favorite", async () => {
    await page.getByRole("button", { name: "New item" }).click();
    await page.getByRole("button", { name: "Card", exact: true }).click();
    await fill("Name", "Work Amex");
    await fill("Cardholder name", "Ada Lovelace");
    await page.getByLabel("Brand").selectOption("Amex");
    await fill("Number", "378282246310005");
    await page.getByLabel("Expiration month").selectOption("7");
    await fill("Expiration year", "2031");
    await page.getByRole("button", { name: "Add field" }).click();
    await page.getByLabel("Field on the page").fill("PIN");
    await page.getByLabel("Value to fill").fill("9876");
    await page.getByRole("combobox").filter({ hasText: "Text" }).selectOption("1");
    await page.getByRole("button", { name: "Save" }).click();
    await rows().filter({ hasText: "Work Amex" }).click();
    await page.getByRole("button", { name: "Favorite" }).click();
    await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    await page.getByRole("button", { name: "Clone" }).click();
    await page.getByRole("button", { name: "Save" }).click();
    await rows().filter({ hasText: "Work Amex (copy)" }).waitFor();
    const s = await apiSession(vaultUser);
    const all = await s.ciphers();
    s.done();
    const c = all.find((x) => x.name === "Work Amex");
    assert.deepEqual([c?.type, c?.card.brand, c?.card.number, c?.card.expMonth, c?.card.expYear, c?.favorite], [3, "Amex", "378282246310005", "7", "2031", true]);
    assert.deepEqual(c?.fields, [{ name: "PIN", value: "9876", type: 1, linkedId: null }]);
    const copy = all.find((x) => x.name === "Work Amex (copy)");
    assert.equal(copy?.card.number, "378282246310005");
    // A new item gets a key of its own, and a clone does not keep the original's (SECURITY.md 10a).
    assert.ok(c?.key && copy?.key && c.key !== copy.key, "new item and clone each carry their own key");
  });

  await step("folders: create, rename, delete (names checked on the server)", async () => {
    const names = () => page.locator("input[aria-label=\"Folder name\"]");
    const index = (name: string) => page.evaluate((n) => [...document.querySelectorAll<HTMLInputElement>("input[aria-label=\"Folder name\"]")].findIndex((i) => i.value === n), name);
    const serverFolders = async () => {
      const s = await apiSession(vaultUser);
      const f = await s.folders();
      s.done();
      return f;
    };
    await page.getByRole("button", { name: "Folders", exact: true }).click();
    await page.getByLabel("New folder").fill("Banking");
    await page.getByRole("button", { name: "Add", exact: true }).click();
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLInputElement>("input[aria-label=\"Folder name\"]")].some((i) => i.value === "Banking"));
    assert.ok((await serverFolders()).includes("Banking"));
    const i = await index("Banking");
    await names().nth(i).fill("Bank");
    await page.getByRole("button", { name: "Rename" }).nth(i).click();
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLInputElement>("input[aria-label=\"Folder name\"]")].some((i) => i.value === "Bank"));
    assert.ok((await serverFolders()).includes("Bank"));
    await page.getByRole("button", { name: "Delete folder" }).nth(await index("Bank")).click();
    await page.getByRole("button", { name: "Click again to delete" }).click(); // a folder delete takes two clicks
    await page.waitForFunction(() => ![...document.querySelectorAll<HTMLInputElement>("input[aria-label=\"Folder name\"]")].some((i) => i.value === "Bank"));
    assert.ok(!(await serverFolders()).includes("Bank"));
    await page.getByRole("button", { name: "Back" }).click();
  });

  await step("export: master password re-checked, personal items as Bitwarden JSON", async () => {
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("button", { name: /^Export vault/ }).click();
    await page.getByLabel("Master password").fill("wrong-password");
    await click("Export");
    await page.getByRole("alert").filter({ hasText: "Wrong master password" }).waitFor();
    await page.getByLabel("Master password").fill(vaultUser.password);
    const [dl] = await Promise.all([page.waitForEvent("download"), click("Export")]);
    assert.match(dl.suggestedFilename(), /^warren_export_\d{14}\.json$/);
    const data = JSON.parse(readFileSync(await dl.path(), "utf8"));
    assert.equal(data.encrypted, false);
    const github = data.items.find((i: any) => i.name === "GitHub");
    assert.equal(github?.login?.username, "octo");
    assert.equal(data.folders.find((f: any) => f.id === github.folderId)?.name, "Work");
    assert.ok(!data.items.some((i: any) => i.name === "Team wiki v2"), "organization item exported");
  });

  await step("import: Bitwarden JSON creates items and folders on the server", async () => {
    const file = {
      encrypted: false,
      folders: [{ id: "f-1", name: "Imported folder" }],
      items: [
        { id: "i-1", folderId: "f-1", type: 1, name: "Imported login", favorite: true, login: { username: "imp", password: "imp-pw", uris: [{ uri: "https://imp.example", match: null }] } },
        { id: "i-2", type: 99, name: "Unknown type" },
      ],
    };
    await page.getByLabel("Import items").setInputFiles({ name: "export.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(file)) });
    await page.getByRole("status").filter({ hasText: "Imported 1 item(s). Skipped 1 unsupported item(s)." }).waitFor();
    const s = await apiSession(vaultUser);
    const c = (await s.ciphers()).find((x) => x.name === "Imported login");
    const folders = await s.folders();
    s.done();
    assert.deepEqual([c?.login.username, c?.login.password, c?.favorite], ["imp", "imp-pw", true]);
    // Imported with a key of its own, and its website survives the checksum check that key turns on.
    assert.ok(c?.key, "imported item carries its own key");
    assert.equal(c?.login.uris?.[0]?.uri, "https://imp.example");
    assert.ok(folders.includes("Imported folder"));
    await page.getByRole("button", { name: "Vault", exact: true }).click();
    await rows().filter({ hasText: "Imported login" }).waitFor();
  });

  await step("export and import: CSV, and JSON protected by a file password", async () => {
    await page.getByRole("button", { name: "Settings" }).click();
    const exportAs = async (format: string, filePassword?: string) => {
      await page.getByRole("button", { name: /^Export vault/ }).click();
      await page.getByLabel("File format").selectOption(format);
      if (filePassword) await page.getByLabel("File password").fill(filePassword);
      await page.getByLabel("Master password").fill(vaultUser.password);
      const [dl] = await Promise.all([page.waitForEvent("download"), click("Export")]);
      return { name: dl.suggestedFilename(), text: readFileSync(await dl.path(), "utf8") };
    };
    const csv = await exportAs("csv");
    assert.match(csv.name, /^warren_export_\d{14}\.csv$/);
    assert.match(csv.text.split("\n")[0]!, /^folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp$/);
    assert.ok(csv.text.includes("GitHub") && csv.text.includes("octo"));
    const prot = await exportAs("encrypted", "file-pass-123");
    assert.match(prot.name, /_encrypted\.json$/);
    const p = JSON.parse(prot.text);
    assert.deepEqual([p.encrypted, p.passwordProtected], [true, true]);
    assert.ok(!prot.text.includes("octo"), "clear text in a protected export");
    // Imports: a CSV, then the protected file (asks for its password, refuses a wrong one).
    await page.getByLabel("Import items").setInputFiles({ name: "x.csv", mimeType: "text/csv", buffer: Buffer.from("folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp\n,,login,CSV login,,,0,https://csv.example,csv-user,csv-pw,\n") });
    await page.getByRole("status").filter({ hasText: "Imported 1 item(s)." }).waitFor();
    // The file opens with its password outside Warren too (same format as the official clients).
    const opened = JSON.parse(wasm.passwordOpenExport(prot.text, "file-pass-123"));
    assert.ok(opened.items.some((i: any) => i.name === "GitHub" && i.login?.username === "octo"));
    // A small protected file (not the whole vault again, which would double every item for later steps).
    const small = wasm.passwordProtectExport(JSON.stringify({ encrypted: false, folders: [], items: [{ type: 2, name: "Protected note", secureNote: { type: 0 } }] }), "file-pass-123", 0, 600_000, 0, 0);
    await page.getByLabel("Import items").setInputFiles({ name: "p.json", mimeType: "application/json", buffer: Buffer.from(small) });
    await page.getByLabel("File password").fill("nope");
    await click("Import");
    await page.getByRole("alert").filter({ hasText: "Wrong file password" }).waitFor();
    await page.getByLabel("File password").fill("file-pass-123");
    await click("Import");
    await page.getByRole("status").filter({ hasText: "Imported 1 item(s)." }).waitFor();
    const s = await apiSession(vaultUser);
    const all = await s.ciphers();
    s.done();
    assert.equal(all.find((x) => x.name === "CSV login")?.login.password, "csv-pw");
    assert.ok(all.some((x) => x.name === "Protected note"), "protected export not imported");
    await page.getByRole("button", { name: "Vault", exact: true }).click();
  });

  await step("organizations: create in a collection, move a personal item in, change its collections", async () => {
    await page.getByRole("button", { name: "New item" }).click();
    await page.getByRole("button", { name: "Note", exact: true }).click();
    await fill("Name", "Org created");
    await page.getByLabel("Owner").selectOption({ label: "Team Alpha" });
    await page.getByRole("group", { name: "Collections" }).getByText("Engineering").click();
    await page.getByRole("button", { name: "Save" }).click();
    await rows().filter({ hasText: "Org created" }).waitFor();
    await page.getByRole("button", { name: "New item" }).click();
    await page.getByRole("button", { name: "Note", exact: true }).click();
    await fill("Name", "Moved note");
    await page.getByRole("button", { name: "Save" }).click();
    await rows().filter({ hasText: "Moved note" }).click();
    await page.getByRole("button", { name: "Move to organization" }).click();
    await page.getByRole("group", { name: "Collections" }).getByText("Engineering").click();
    await page.getByRole("button", { name: "Move to organization" }).click();
    await page.getByRole("heading", { name: "Moved note" }).waitFor();
    await page.getByText("Team Alpha", { exact: true }).waitFor();
    const s = await apiSession(vaultUser);
    const org = await s.orgCiphers();
    const personal = await s.ciphers();
    s.done();
    const created = org.find((c) => c.name === "Org created");
    const moved = org.find((c) => c.name === "Moved note");
    assert.ok(created?.collectionIds?.length === 1, "created item has no collection");
    assert.ok(moved?.key && moved.collectionIds?.length === 1, "moved item not in the collection");
    assert.ok(!personal.some((c) => c.name === "Moved note"), "moved item still personal");
    // Out of every collection is refused; the item keeps the one it has.
    await page.getByRole("button", { name: "Collections", exact: true }).click();
    await page.getByRole("heading", { name: "Collections" }).waitFor();
    const eng = page.getByRole("group", { name: "Collections" }).getByRole("checkbox");
    assert.equal(await eng.isChecked(), true, "current collection not shown as chosen");
    await page.getByRole("group", { name: "Collections" }).getByText("Engineering").click();
    assert.equal(await eng.isChecked(), false);
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByRole("alert").filter({ hasText: "Pick at least one collection" }).waitFor();
    await back();
    await back();
  });

  await step("attachments: deleted after a second tap", async () => {
    await rows().filter({ hasText: "Team wiki v2" }).first().click(); // also under "Recently opened"
    await page.getByRole("button", { name: "Delete org.txt" }).click();
    await page.getByRole("button", { name: "Click again to delete" }).click();
    await page.getByRole("status").filter({ hasText: "Deleted" }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Download org.txt" }).count(), 0);
    const s = await apiSession(vaultUser);
    const c = (await s.orgCiphers()).find((x) => x.name === "Team wiki v2");
    s.done();
    assert.equal(c?.attachments?.length ?? 0, 0);
    await back();
  });

  await step("generator: password and passphrase", async () => {
    await page.getByRole("button", { name: "Generator" }).click();
    const out = page.getByRole("status", { name: "Generated value" }).or(page.locator("output"));
    await page.waitForFunction(() => (document.querySelector("output")?.textContent ?? "…") !== "…");
    assert.equal((await out.first().innerText()).length, 20);
    await page.getByRole("button", { name: "Passphrase" }).click();
    await page.waitForFunction(() => (document.querySelector("output")?.textContent ?? "").split("-").length === 5);
  });

  await step("generator: usernames (random word, plus-addressed email, catch-all)", async () => {
    const until = (re: RegExp) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector("output")?.textContent ?? ""), re.source);
    await page.getByRole("button", { name: "Username", exact: true }).click();
    await until(/^[A-Z][a-z-]+\d{4}$/); // capitalized EFF word + 4 digits (defaults)
    await page.getByRole("button", { name: "Plus-addressed email" }).click();
    await until(/^[^@]+\+[a-z0-9]{8}@/);
    const plus = await page.locator("output").innerText();
    assert.equal(plus.replace(/\+[a-z0-9]{8}@/, "@"), vaultUser.email);
    await page.getByRole("button", { name: "Catch-all email" }).click();
    await page.getByLabel("Domain").fill("catch.example");
    await page.getByLabel("Domain").blur();
    await until(/^[a-z0-9]{8}@catch\.example$/);
  });

  await step("generator: an alias API key survives closing the popup and a lock, encrypted at rest", async () => {
    await page.getByRole("button", { name: "Alias", exact: true }).click();
    await page.getByLabel("API key").fill("sl-token-secret");
    // No blur and no change event: the popup just goes away, like a click outside it.
    await poll("alias key saved", () => sw.evaluate(async () => !!(await chrome.storage.local.get("aliasSettings")).aliasSettings));
    const raw = await sw.evaluate(async () => (await chrome.storage.local.get("aliasSettings")).aliasSettings);
    assert.ok(raw.startsWith("2.") && !raw.includes("sl-token-secret"), raw);
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "lock" }));
    await unlockIfLocked();
    await page.getByRole("button", { name: "Generator" }).click();
    await poll("alias key restored", async () => (await page.getByLabel("API key").inputValue()) === "sl-token-secret");
    await page.getByRole("button", { name: "Username", exact: true }).click();
    await page.waitForFunction(() => /^[a-z0-9]{8}@catch\.example$/.test(document.querySelector("output")?.textContent ?? ""));
  });

  await step("generator history: copied values listed, encrypted at rest, clearable", async () => {
    const value = await page.locator("output").innerText();
    await page.getByRole("button", { name: "Copy Generated value" }).click();
    await poll("history entry", () => sw.evaluate(async () => ((await chrome.storage.local.get("genHistory")).genHistory ?? []).length === 1));
    const raw = await sw.evaluate(async () => JSON.stringify(await chrome.storage.local.get("genHistory")));
    assert.ok(!raw.includes(value) && raw.includes('"2.'), raw);
    await page.getByRole("button", { name: "Generator history" }).click();
    await page.getByRole("listitem").filter({ hasText: value }).waitFor();
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await page.getByText("Copied values show up here").waitFor();
    assert.equal(await sw.evaluate(async () => Object.keys(await chrome.storage.local.get("genHistory")).length), 0);
    await page.getByRole("button", { name: "Back" }).click();
  });

  // Design review screenshots (not assertions): SHOTS=<dir> npm run test:e2e
  if (process.env.SHOTS) {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      const shot = (name: string) => page.locator("body").screenshot({ path: join(process.env.SHOTS!, `${scheme}-${name}.png`) });
      await page.getByRole("button", { name: "Vault", exact: true }).click();
      await shot("list");
      await rows().filter({ hasText: "GitHub" }).click();
      await page.getByRole("heading", { name: "GitHub" }).waitFor();
      await shot("item");
      await page.getByRole("button", { name: "Edit" }).click();
      await shot("edit");
      await page.getByRole("button", { name: "Cancel" }).click();
      await back();
      await page.getByRole("button", { name: "Generator" }).click();
      await shot("generator");
      await page.getByRole("button", { name: "Settings" }).click();
      await shot("settings");
    }
    await page.emulateMedia({ colorScheme: null });
    await page.getByRole("button", { name: "Vault", exact: true }).click();
  }

  await step("re-prompt: a flagged item's secrets need the master password again, until the next lock", async () => {
    await unlockIfLocked();
    const ask = (msg: Record<string, unknown>) => page.evaluate((m) => chrome.runtime.sendMessage(m), msg);
    const saved = await ask({ type: "saveItem", item: { type: 2, name: "Guarded note", notes: "guarded secret", secureNote: { type: 0 }, reprompt: 1 } });
    const id: string = saved.data.items.find((i: { name: string }) => i.name === "Guarded note").id;
    // Every path that returns secrets is gated in the service worker, not only in the UI.
    for (const m of [{ type: "getItem", id }, { type: "totp", id }, { type: "downloadAttachment", cipherId: id, attachmentId: "x" }])
      assert.equal((await ask(m)).code, "reprompt", m.type);
    assert.equal((await ask({ type: "confirmReprompt", id, password: "wrong" })).code, "wrongPassword");
    assert.equal((await ask({ type: "repromptGranted", id })).data, false);
    assert.equal((await ask({ type: "confirmReprompt", id, password: vaultUser.password })).ok, true);
    assert.equal((await ask({ type: "getItem", id })).data.notes, "guarded secret");
    // The open item view polls this to hide the item again once the grant is gone.
    assert.equal((await ask({ type: "repromptGranted", id })).data, true);
    await ask({ type: "lock" });
    await unlockIfLocked();
    assert.equal((await ask({ type: "repromptGranted", id })).data, false, "grant survived a lock");
    assert.equal((await ask({ type: "getItem", id })).code, "reprompt", "grant survived a lock");
    await ask({ type: "deleteItem", id });
    await ask({ type: "purgeItem", id });
  });

  await step("lock clears decrypted vault from the popup", async () => {
    await page.getByRole("button", { name: "Vault", exact: true }).click();
    await page.getByRole("button", { name: "Lock now" }).click();
    await page.getByRole("heading", { name: "Vault locked" }).waitFor();
    assert.ok(!(await page.locator("#app").innerText()).includes("GitHub"));
  });

  // ---------- autofill ----------
  const s3 = await apiSession(vaultUser);
  await s3.create({ type: 1, name: "Local app", login: { username: "local-user", password: "local-pass", totp: TOTP_KEY, uris: [{ uri: SITE, match: null }] } });
  s3.done();
  const loginPage = await ctx.newPage();
  await loginPage.goto(`${SITE}/login`);
  const reopenPopup = async () => {
    if (page.isClosed()) page = await ctx.newPage();
    currentPage = page;
    await loginPage.bringToFront(); // the "active tab" the popup works on
    await page.goto(popupUrl);
  };
  const fieldValues = () =>
    loginPage.evaluate(() => [(document.getElementById("u") as HTMLInputElement).value, (document.getElementById("p") as HTMLInputElement).value]);
  const setFields = (u: string, p: string) =>
    loginPage.evaluate(([u, p]) => {
      (document.getElementById("u") as HTMLInputElement).value = u!;
      (document.getElementById("p") as HTMLInputElement).value = p!;
    }, [u, p]);

  await step("autofill: popup lists site matches and fills the page; TOTP code copied", async () => {
    await unlockIfLocked();
    await reopenPopup();
    await page.getByRole("heading", { name: "On localhost:8099" }).waitFor();
    // The site section and the vault list both offer Fill: the site section comes first.
    await page.getByRole("button", { name: "Fill Local app" }).first().click();
    await loginPage.waitForFunction(() => (document.getElementById("p") as HTMLInputElement).value !== "");
    assert.deepEqual(await fieldValues(), ["local-user", "local-pass"]);
    const codes = () => [totpNow().code, JSON.parse(wasm.totp(TOTP_KEY, Date.now() - 30_000)).code];
    let copied = "";
    for (let i = 0; i < 10 && !codes().includes(copied); i++) copied = await readClipboard();
    assert.ok(codes().includes(copied), `clipboard ${copied}`);
    assert.ok(await sw.evaluate(() => chrome.alarms.get("clipboard")), "clipboard clear alarm not scheduled");
  });

  await step("a TOTP refresh is not activity: an open item cannot keep the vault unlocked", async () => {
    await reopenPopup();
    await page.getByRole("heading", { name: "On localhost:8099" }).waitFor();
    await page.waitForTimeout(500); // let the popup's own start-up requests settle
    const { data } = await page.evaluate(() => chrome.runtime.sendMessage({ type: "pageMatches" }));
    const id = data.items.find((i: { hasTotp: boolean }) => i.hasTotp).id;
    const until = () => sw.evaluate(async () => (await chrome.storage.session.get("session")).session.unlockedUntil);
    const before = await until();
    const r = await page.evaluate((id) => chrome.runtime.sendMessage({ type: "totp", id }), id);
    assert.equal(r.ok, true);
    assert.equal(await until(), before);
  });

  const shortcut = () =>
    sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return (globalThis as any).warrenTest.autofillFromGesture(tab);
    });

  await step("Ctrl+Shift+L handler: fills matching sites only", async () => {
    const other = await ctx.newPage();
    await other.goto("http://127.0.0.1:8099/login");
    await other.bringToFront();
    assert.deepEqual(await shortcut(), { filled: false, reason: "noMatch" });
    await other.close();
    await setFields("", "");
    await loginPage.bringToFront();
    assert.deepEqual(await shortcut(), { filled: true });
    assert.deepEqual(await fieldValues(), ["local-user", "local-pass"]);
    const cmds = await sw.evaluate(() => chrome.commands.getAll());
    // The suggested key is only a suggestion; browsers may leave it unassigned (Helium does).
    const cmd = cmds.find((c) => c.name === "autofill-login");
    assert.ok(cmd, "autofill-login command not registered");
    console.log(`    assigned shortcut: ${JSON.stringify(cmd.shortcut)}`);
  });

  await step("autofill: a zero-size password decoy is skipped, a username-first step still fills", async () => {
    await loginPage.goto(`${SITE}/decoy`);
    await loginPage.bringToFront();
    assert.deepEqual(await shortcut(), { filled: true });
    const decoy = await loginPage.evaluate(() => ["decoy", "u", "p"].map((id) => (document.getElementById(id) as HTMLInputElement).value));
    assert.deepEqual(decoy, ["", "local-user", "local-pass"]);
    await loginPage.goto(`${SITE}/useronly`);
    await loginPage.bringToFront();
    assert.deepEqual(await shortcut(), { filled: true });
    assert.equal(await loginPage.evaluate(() => (document.getElementById("u") as HTMLInputElement).value), "local-user");
    await loginPage.goto(`${SITE}/login`);
  });

  await step("badge counts the site's logins; context menu lists them and fills the picked one", async () => {
    await reopenPopup(); // also makes the login page the active tab
    const badge = () =>
      sw.evaluate(async () => {
        const [t] = await chrome.tabs.query({ url: "http://localhost:8099/*" });
        return chrome.action.getBadgeText({ tabId: t!.id });
      });
    await poll("badge 1", async () => (await badge()) === "1");
    const { data } = await page.evaluate(() => chrome.runtime.sendMessage({ type: "pageMatches" }));
    const menuId = `warren-autofill:${data.items[0].id}`;
    // contextMenus has no getter; update() fails for an id that does not exist.
    const menuExists = (mid: string) => sw.evaluate((m) => new Promise((r) => chrome.contextMenus.update(m, {}, () => r(!chrome.runtime.lastError))), mid);
    // The popup's own sync rebuilds the menu (removeAll + create) after the badge is already up.
    await poll("context menu entry", () => menuExists(menuId) as Promise<boolean>);
    await setFields("", "");
    const r = await sw.evaluate(async (m) => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return (globalThis as any).warrenTest.onContextMenu({ menuItemId: m }, tab);
    }, menuId);
    assert.deepEqual(r, { filled: true });
    assert.deepEqual(await fieldValues(), ["local-user", "local-pass"]);
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "lock" }));
    await poll("badge cleared", async () => (await badge()) === "");
    assert.equal(await menuExists(menuId), false);
    await unlockIfLocked();
  });

  await step("save login from page: new username creates an item", async () => {
    await setFields("new-user", "new-pass");
    await reopenPopup();
    await page.getByRole("button", { name: "Save login from this page" }).click();
    assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "localhost");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    const s = await apiSession(vaultUser);
    const c = (await s.ciphers()).find((x) => x.login?.username === "new-user" && !x.deletedDate);
    s.done();
    assert.equal(c?.login.password, "new-pass");
    assert.equal(c?.login.uris[0].uri, SITE);
  });

  await step("save login from page: same username updates the password", async () => {
    await setFields("local-user", "local-pass-2");
    await reopenPopup();
    await page.getByRole("button", { name: "Save login from this page" }).click();
    await page.getByRole("heading", { name: "Edit item" }).waitFor();
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByRole("heading", { name: "Local app" }).waitFor();
    const s = await apiSession(vaultUser);
    const c = (await s.ciphers()).find((x) => x.name === "Local app");
    s.done();
    assert.equal(c?.login.password, "local-pass-2");
    assert.equal(c?.passwordHistory?.[0]?.password, "local-pass");
  });

  // ---------- inline menu, save bar, card fill (content script on every page) ----------
  // Menu and bar are extension iframes inside a closed shadow root; Playwright still lists their frames.
  const frameOf = async (p: Page, file: string) => {
    for (let i = 0; i < 100; i++) {
      const f = p.frames().find((x) => x.url().includes(`/${file}`));
      if (f) {
        await p.waitForTimeout(1000); // guardClicks ignores clicks until the frame was visible for 300 ms
        return f;
      }
      await p.waitForTimeout(100);
    }
    throw new Error(`${file} did not appear`);
  };
  const values = (p: Page | import("playwright-core").Frame, ids: string[]) =>
    p.evaluate((ids) => ids.map((id) => (document.getElementById(id) as HTMLInputElement).value), ids);

  await step("inline menu: focusing the username lists site matches; picking one fills", async () => {
    await unlockIfLocked();
    await loginPage.goto(`${SITE}/login`);
    await loginPage.click("#u");
    const menu = await frameOf(loginPage, "menu.html");
    await menu.getByRole("button", { name: "Fill Local app" }).click();
    await loginPage.waitForFunction(() => (document.getElementById("p") as HTMLInputElement).value !== "");
    assert.deepEqual(await fieldValues(), ["local-user", "local-pass-2"]);
    await loginPage.waitForTimeout(300);
    assert.equal(await loginPage.locator("warren-menu").count(), 0, "menu reopened after the fill");
  });

  await step("inline menu: ArrowDown enters the list, ArrowUp returns to the field, Enter fills", async () => {
    await loginPage.goto(`${SITE}/login`);
    await loginPage.click("#u");
    const menu = await frameOf(loginPage, "menu.html");
    // Only the menu's own frame can send it back: the page posting the same text changes nothing.
    await loginPage.evaluate(() => postMessage("warren:back", "*"));
    await loginPage.waitForTimeout(200);
    assert.equal(await loginPage.locator("warren-menu").count(), 1, "a page message closed the menu");
    await loginPage.keyboard.press("ArrowDown");
    await menu.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Fill Local app");
    await loginPage.keyboard.press("ArrowUp"); // above the first row: back to the field, menu closed
    await loginPage.waitForFunction(() => document.activeElement?.id === "u" && !document.querySelector("warren-menu"));
    await loginPage.click("#u"); // a click reopens a dismissed menu
    await frameOf(loginPage, "menu.html");
    await loginPage.keyboard.press("ArrowDown");
    await loginPage.keyboard.press("Enter");
    await loginPage.waitForFunction(() => (document.getElementById("p") as HTMLInputElement).value !== "");
    assert.deepEqual(await fieldValues(), ["local-user", "local-pass-2"]);
  });

  await step("blocked websites: no inline menu there until unblocked", async () => {
    await page.getByRole("button", { name: "Settings" }).click();
    await page.getByRole("textbox", { name: "Block" }).fill("http://localhost:8099/login");
    await page.getByRole("button", { name: "Block", exact: true }).click();
    await page.getByText("localhost", { exact: true }).waitFor();
    await loginPage.goto(`${SITE}/login`);
    await loginPage.click("#u");
    await loginPage.waitForTimeout(1500);
    assert.equal(await loginPage.locator("warren-menu").count(), 0, "menu on a blocked site");
    await page.getByRole("button", { name: "Unblock localhost" }).click();
    await page.getByRole("button", { name: "Unblock localhost" }).waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Vault", exact: true }).click();
    await loginPage.goto(`${SITE}/login`);
    await loginPage.click("#u");
    await frameOf(loginPage, "menu.html");
  });

  await step("inline menu: fields in an open shadow root and in an iframe", async () => {
    await loginPage.goto(`${SITE}/shadow`);
    await loginPage.locator("#u").click(); // Playwright pierces open shadow roots
    await (await frameOf(loginPage, "menu.html")).getByRole("button", { name: "Fill Local app" }).click();
    await loginPage.waitForFunction(() => (document.getElementById("host")!.shadowRoot!.getElementById("p") as HTMLInputElement).value !== "");
    await loginPage.goto(`${SITE}/framed`);
    const inner = loginPage.frameLocator("#f");
    await inner.locator("#u").click();
    await (await frameOf(loginPage, "menu.html")).getByRole("button", { name: "Fill Local app" }).click();
    const f = loginPage.frames().find((x) => x.url() === `${SITE}/login`)!;
    await f.waitForFunction(() => (document.getElementById("p") as HTMLInputElement).value !== "");
    assert.deepEqual(await values(f, ["u", "p"]), ["local-user", "local-pass-2"]);
  });

  await step("popup fill: reaches a login form inside a same-origin iframe", async () => {
    await loginPage.goto(`${SITE}/framed`);
    const inner = loginPage.frames().find((f) => f.url() === `${SITE}/login`)!;
    await inner.waitForFunction(() => !!document.getElementById("u"));
    await reopenPopup();
    // The site section and the vault list both offer Fill: the site section comes first.
    await page.getByRole("button", { name: "Fill Local app" }).first().click();
    await inner.waitForFunction(() => (document.getElementById("p") as HTMLInputElement).value !== "");
    assert.deepEqual(await values(inner, ["u", "p"]), ["local-user", "local-pass-2"]);
    // The fill focuses the fields it writes; the inline menu must not open over the fill.
    await loginPage.waitForTimeout(300);
    assert.equal(await loginPage.locator("warren-menu").count(), 0, "menu opened after the popup fill");
  });

  await step("inline menu: card fields list cards and fill name, number, expiry and code", async () => {
    await loginPage.goto(`${SITE}/card`);
    await loginPage.click("#cc");
    await (await frameOf(loginPage, "menu.html")).getByRole("button", { name: "Fill Visa" }).click();
    await loginPage.waitForFunction(() => (document.getElementById("cc") as HTMLInputElement).value !== "");
    assert.deepEqual(await values(loginPage, ["cn", "cc", "m", "y", "cvc"]), ["Ada L", "4111111111111111", "01", "2030", "123"]);
  });

  await step("new item: the form starts on the active tab's site, other types start unnamed", async () => {
    await reopenPopup();
    await page.getByRole("button", { name: "New item" }).click();
    assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "localhost");
    assert.equal(await page.getByLabel("Website 1").inputValue(), SITE);
    await page.getByRole("button", { name: "Card", exact: true }).click();
    assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "");
    await page.getByRole("button", { name: "Cancel" }).click(); // the type changed: warns first
    await page.getByRole("button", { name: "Cancel" }).click();
  });

  await step("inline menu: a site without a login offers Create account, which opens the form for that site", async () => {
    const other = await ctx.newPage();
    await other.goto("http://127.0.0.1:8099/login");
    await other.bringToFront();
    await other.click("#u");
    const menu = await frameOf(other, "menu.html");
    // Playwright does not list the action popup as a page: watch the call, and that the popup took the request.
    await sw.evaluate(() => {
      const real = chrome.action.openPopup.bind(chrome.action);
      Object.defineProperty(chrome.action, "openPopup", { configurable: true, value: () => real().then((r: unknown) => (((globalThis as any).popupOpened = true), r)) });
    });
    const newLogin = () => sw.evaluate(async () => (await chrome.storage.session.get("session")).session.newLogin);
    await menu.getByRole("button", { name: "Create account" }).click();
    for (let i = 0; i < 50 && !(await sw.evaluate(() => (globalThis as any).popupOpened)); i++) await other.waitForTimeout(100);
    assert.equal(await sw.evaluate(() => (globalThis as any).popupOpened), true);
    for (let i = 0; i < 50 && (await newLogin()); i++) await other.waitForTimeout(100);
    assert.equal(await newLogin(), undefined);
    await sw.evaluate(() => delete (chrome.action as any).openPopup);
    await other.close();
    // What the action popup does with the request, in a tab the test can read. It is taken only once.
    await sw.evaluate(async () => {
      const { session } = await chrome.storage.session.get("session");
      await chrome.storage.session.set({ session: { ...session, newLogin: "http://127.0.0.1:8099" } });
    });
    await reopenPopup();
    await page.getByRole("heading", { name: "New item" }).waitFor();
    assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "127.0.0.1");
    assert.equal(await page.getByLabel("Website 1").inputValue(), "http://127.0.0.1:8099");
    await reopenPopup();
    await page.getByRole("button", { name: "New item" }).waitFor();
  });

  await step("inline menu: a site with a login only offers Create account on a registration form", async () => {
    await loginPage.bringToFront();
    await loginPage.goto(`${SITE}/login`);
    await loginPage.click("#u");
    const menu = await frameOf(loginPage, "menu.html");
    await menu.getByRole("button", { name: "Fill Local app" }).waitFor();
    assert.equal(await menu.getByRole("button", { name: "Create account" }).count(), 0);
    await loginPage.goto(`${SITE}/register`);
    await loginPage.click("#u");
    await (await frameOf(loginPage, "menu.html")).getByRole("button", { name: "Create account" }).waitFor();
  });

  await step("inline menu: it opens right under its field, also on a page taller than the window", async () => {
    await loginPage.bringToFront();
    await loginPage.goto(`${SITE}/login`);
    await loginPage.evaluate(() => { document.body.style.minHeight = "3000px"; });
    await loginPage.click("#u");
    await (await frameOf(loginPage, "menu.html")).getByRole("button", { name: "Fill Local app" }).waitFor();
    const [field, menu] = await loginPage.evaluate(() => ["#u", "warren-menu"].map((s) => { const r = document.querySelector(s)!.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left }; }));
    assert.ok(Math.abs(menu!.top - field!.bottom - 4) < 1, JSON.stringify({ field, menu }));
    assert.ok(Math.abs(menu!.left - field!.left) < 1, JSON.stringify({ field, menu }));
    await loginPage.keyboard.press("Escape");
  });

  await step("inline menu: a login with each input in its own shadow root gets the menu and fills", async () => {
    await loginPage.bringToFront();
    await loginPage.goto(`${SITE}/split-shadow`);
    await loginPage.click("#u");
    await (await frameOf(loginPage, "menu.html")).getByRole("button", { name: "Fill Local app" }).click();
    await loginPage.waitForFunction(() => document.querySelector("x-b")!.shadowRoot!.querySelector("input")!.value !== "");
    assert.equal(await loginPage.evaluate(() => document.querySelector("x-a")!.shadowRoot!.querySelector("input")!.value), "local-user");
  });

  const setSetting = (patch: Record<string, unknown>) => page.evaluate((m) => chrome.runtime.sendMessage(m), { type: "setSettings", ...patch });

  await step("page load: a login rendered long after load is still filled, once", async () => {
    await setSetting({ autofillOnPageLoad: true });
    try {
      await loginPage.bringToFront();
      await loginPage.goto(`${SITE}/late-login`);
      await loginPage.waitForFunction(() => (document.getElementById("p") as HTMLInputElement | null)?.value, undefined, { timeout: 10_000 });
      assert.ok(await loginPage.getAttribute("#p", "data-warren-autofilled"), "the filled field is not marked");
    } finally {
      await setSetting({ autofillOnPageLoad: false });
    }
  });

  await step("inline menu: autocomplete=off on a lone code box offers the logins and fills the code", async () => {
    await loginPage.goto(`${SITE}/otp`);
    await loginPage.click("#code");
    await (await frameOf(loginPage, "menu.html")).getByRole("button", { name: "Fill Local app" }).click();
    await loginPage.waitForFunction(() => /^\d{6}$/.test((document.getElementById("code") as HTMLInputElement).value));
  });

  await step("autosubmit: off by default, and with the setting a fill presses the login button", async () => {
    await loginPage.goto(`${SITE}/autosubmit`);
    await loginPage.click("#u");
    await (await frameOf(loginPage, "menu.html")).getByRole("button", { name: "Fill Local app" }).click();
    await loginPage.waitForFunction(() => (document.getElementById("p") as HTMLInputElement).value !== "");
    assert.equal(await loginPage.evaluate(() => (window as unknown as { submitted?: boolean }).submitted ?? false), false);
    await setSetting({ autosubmit: true });
    try {
      await loginPage.goto(`${SITE}/autosubmit`);
      await loginPage.click("#u");
      await (await frameOf(loginPage, "menu.html")).getByRole("button", { name: "Fill Local app" }).click();
      await loginPage.waitForFunction(() => (window as unknown as { submitted?: boolean }).submitted === true);
    } finally {
      await setSetting({ autosubmit: false });
    }
  });

  await step("a frame without page.js (opened before an update) gets it injected for a fill", async () => {
    await loginPage.goto(`${SITE}/login`);
    await loginPage.bringToFront();
    await sw.evaluate(async (site) => {
      const [tab] = await chrome.tabs.query({ url: `${site}/*`, active: true });
      await chrome.scripting.executeScript({ target: { tabId: tab!.id! }, func: () => void delete (globalThis as { warren?: unknown }).warren });
    }, SITE);
    const { data } = await page.evaluate(() => chrome.runtime.sendMessage({ type: "pageMatches" }));
    const id = data.items.find((i: { name: string }) => i.name === "Local app").id;
    // A fill names the page the popup showed (pageMatches).
    const r = await page.evaluate(([id, tabId, origin]) => chrome.runtime.sendMessage({ type: "fill", id, tabId, origin }), [id, data.tabId, data.origin]);
    assert.ok(r.data?.filled, JSON.stringify(r));
    assert.equal(await loginPage.inputValue("#u"), "local-user");
  });

  await step("custom fields: every type fills by name, a linked one with its login's username", async () => {
    await loginPage.bringToFront();
    await loginPage.goto(`${SITE}/custom`);
    const s = await apiSession(vaultUser);
    const c = (await s.ciphers()).find((x) => x.name === "Local app");
    s.done();
    const { data } = await page.evaluate(() => chrome.runtime.sendMessage({ type: "pageMatches" }));
    const id = data.items.find((i: { name: string }) => i.name === "Local app").id;
    const { data: item } = await page.evaluate((id) => chrome.runtime.sendMessage({ type: "getItem", id }), id);
    const fields = [
      ...(item.fields ?? []),
      { name: "member_no", value: "M-77", type: 1, linkedId: null },
      { name: "terms", value: "true", type: 2, linkedId: null },
      { name: "alias", value: null, type: 3, linkedId: 100 },
    ];
    const saved = await page.evaluate((item) => chrome.runtime.sendMessage({ type: "saveItem", item }), { ...item, fields });
    assert.ok(saved.ok, JSON.stringify(saved));
    // A fill names the page the popup showed (pageMatches).
    const r = await page.evaluate(([id, tabId, origin]) => chrome.runtime.sendMessage({ type: "fill", id, tabId, origin }), [id, data.tabId, data.origin]);
    assert.ok(r.data?.filled, JSON.stringify(r));
    assert.deepEqual(await Promise.all(["#u", "#p", "#member", "#alias"].map((f) => loginPage.inputValue(f))), [c.login.username, c.login.password, "M-77", c.login.username]);
    assert.equal(await loginPage.isChecked("#terms"), true);
    // Put the fields back on the current copy: the one read before the save above is stale now, and the server
    // refuses a stale draft.
    const { data: fresh } = await page.evaluate((id) => chrome.runtime.sendMessage({ type: "getItem", id }), id);
    await page.waitForTimeout(1100); // the server's revision dates have 1 s granularity
    const restored = await page.evaluate((item) => chrome.runtime.sendMessage({ type: "saveItem", item }), { ...fresh, fields: item.fields ?? null });
    assert.ok(restored.ok, JSON.stringify(restored));
  });

  await step("custom fields: a linked field shows what it stands for, and the editor changes it", async () => {
    const { data } = await page.evaluate(() => chrome.runtime.sendMessage({ type: "pageMatches" }));
    const id = data.items.find((i: { name: string }) => i.name === "Local app").id;
    const item = async () => (await page.evaluate((id) => chrome.runtime.sendMessage({ type: "getItem", id }), id)).data;
    const original = await item();
    await page.waitForTimeout(1100); // the server's revision dates have 1 s granularity
    const saved = await page.evaluate((item) => chrome.runtime.sendMessage({ type: "saveItem", item }), { ...original, fields: [...(original.fields ?? []), { name: "alias", value: null, type: 3, linkedId: 100 }] });
    assert.ok(saved.ok, JSON.stringify(saved));
    await reopenPopup();
    await rows().filter({ hasText: "Local app" }).first().click();
    await page.getByText("Linked: Username").waitFor();
    await page.getByRole("button", { name: "Edit" }).click();
    await page.locator("select:has(option[value='101'])").selectOption("101");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByText("Linked: Password").waitFor();
    const s = await apiSession(vaultUser);
    const c = (await s.ciphers()).find((x) => x.name === "Local app");
    s.done();
    assert.deepEqual(c.fields.at(-1), { name: "alias", value: null, type: 3, linkedId: 101 });
    const fresh = await item();
    await page.waitForTimeout(1100);
    await page.evaluate((item) => chrome.runtime.sendMessage({ type: "saveItem", item }), { ...fresh, fields: original.fields ?? [] });
    await reopenPopup();
  });

  await step("custom fields: Pick from page adds the clicked field to the unsaved editor; Esc adds nothing", async () => {
    const draft = (name: string) => ({ draft: { base: { type: 1 }, type: 1, name, notes: "", folderId: "", favorite: false, reprompt: false, data: {}, uris: [], autofillOnPageLoad: null, fields: [] }, isNew: true });
    const start = async (name: string) => {
      await loginPage.goto(`${SITE}/custom`);
      await loginPage.bringToFront();
      const r = await page.evaluate((d) => chrome.runtime.sendMessage({ type: "startFieldPicker", draft: JSON.stringify(d), panel: true }), draft(name));
      assert.ok(r.ok, JSON.stringify(r));
      await loginPage.locator("warren-picker").waitFor({ state: "attached" });
    };
    await page.waitForTimeout(1000); // the popup opened by the last step takes a pick while it loads
    await start("Picked item");
    await loginPage.evaluate(() => document.getElementById("terms")!.addEventListener("click", () => ((window as unknown as { pageSaw: boolean }).pageSaw = true)));
    await loginPage.click("#terms");
    await loginPage.locator("warren-picker").waitFor({ state: "detached" });
    assert.equal(await loginPage.isChecked("#terms"), false, "the pick reached the page");
    assert.equal(await loginPage.evaluate(() => (window as unknown as { pageSaw?: boolean }).pageSaw ?? false), false);
    await reopenPopup();
    await page.getByRole("heading", { name: "New item" }).waitFor();
    assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "Picked item");
    assert.equal(await page.getByLabel("Field on the page").inputValue(), "terms");
    // Focus is on the new row, not on the item's Name box, and it stays there once the vault has synced.
    await page.waitForTimeout(500);
    assert.ok(await page.locator(".field-card").last().evaluate((el) => el.contains(document.activeElement)), `focus is on ${await page.evaluate(() => document.activeElement?.outerHTML.slice(0, 120))}`);
    assert.equal(await page.getByLabel("Name", { exact: true }).evaluate((el) => el === document.activeElement), false);
    assert.ok(await page.locator(".field-card").last().evaluate((el) => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), "the new row is off screen");
    assert.equal(await page.getByRole("button", { name: "Pick from page" }).count(), 1);

    await page.getByText("Ticks").waitFor();

    // A field that holds what the item has links to it; one the engine cannot name stays the user's own text.
    await start("Linked item");
    await loginPage.click("#p");
    await loginPage.locator("warren-picker").waitFor({ state: "detached" });
    await reopenPopup();
    assert.equal(await page.getByLabel("Comes from this item's").inputValue(), "101");
    assert.equal(await page.getByLabel("Type", { exact: true }).inputValue(), "3");
    await page.getByText("with this item's Password").waitFor();
    await start("Own text item");
    await loginPage.click("#member");
    await loginPage.locator("warren-picker").waitFor({ state: "detached" });
    await reopenPopup();
    assert.equal(await page.getByLabel("Type", { exact: true }).inputValue(), "0");
    assert.equal(await page.getByLabel("Value to fill").count(), 1);

    await start("Cancelled item");
    await loginPage.keyboard.press("Escape");
    await loginPage.locator("warren-picker").waitFor({ state: "detached" });
    await reopenPopup();
    assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "Cancelled item");
    assert.equal(await page.getByLabel("Field on the page").count(), 0);

    await start("Abandoned item");
    await reopenPopup();
    assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "Abandoned item");
    await loginPage.locator("warren-picker").waitFor({ state: "detached" });
    await page.getByRole("button", { name: "Cancel" }).click();
  });

  await step("custom fields: the context menu copies a field's name", async () => {
    await loginPage.goto(`${SITE}/custom`);
    await loginPage.click("#member", { button: "right" });
    await loginPage.keyboard.press("Escape");
    const name = await sw.evaluate(async (site) => {
      const [tab] = await chrome.tabs.query({ url: `${site}/*`, active: true });
      return chrome.tabs.sendMessage(tab!.id!, { type: "clickedFieldName" }, { frameId: 0 });
    }, SITE);
    assert.equal(name, "member");
  });

  await step("save bar: a single-page app's plain Sign in button offers the save", async () => {
    await loginPage.goto(`${SITE}/spa-login`);
    await loginPage.fill("#u", "spa-user");
    await loginPage.fill("#p", "spa-pass");
    await loginPage.keyboard.press("Escape");
    await loginPage.locator("#go span").click();
    const bar = await frameOf(loginPage, "bar.html");
    await bar.getByText("Save this login in Warren?").waitFor();
    await bar.getByRole("button", { name: "Close" }).click();
  });

  await step("save bar: a page's own submit events without a gesture offer nothing", async () => {
    await loginPage.goto(`${SITE}/forge`);
    await loginPage.waitForTimeout(1500);
    assert.equal(await loginPage.locator("warren-bar").count(), 0, "a synthetic submit showed the bar");
  });

  await step("save bar: a submitted new login is offered and saved", async () => {
    await loginPage.goto(`${SITE}/login`);
    await loginPage.fill("#u", "bar-user");
    await loginPage.fill("#p", "bar-pass");
    await loginPage.keyboard.press("Escape");
    await loginPage.click("#show"); // type="button": not a submit, must not offer anything
    await loginPage.waitForTimeout(600);
    assert.equal(await loginPage.locator("warren-bar").count(), 0, "a non-submit button triggered the save bar");
    await loginPage.getByRole("button", { name: "Sign in" }).click();
    const bar = await frameOf(loginPage, "bar.html");
    await bar.getByText("Save this login in Warren?").waitFor();
    await bar.getByRole("button", { name: "Save", exact: true }).click();
    await loginPage.waitForFunction(() => !document.querySelector("warren-bar"));
    const s = await apiSession(vaultUser);
    const c = (await s.ciphers()).find((x) => x.login?.username === "bar-user" && !x.deletedDate);
    s.done();
    assert.deepEqual([c?.login.password, c?.login.uris[0].uri], ["bar-pass", SITE]);
  });

  await step("save bar: a changed password is offered as an update and keeps history", async () => {
    await loginPage.goto(`${SITE}/login`);
    await loginPage.fill("#u", "bar-user");
    await loginPage.fill("#p", "bar-pass-2");
    await loginPage.keyboard.press("Escape");
    await loginPage.getByRole("button", { name: "Sign in" }).click();
    const bar = await frameOf(loginPage, "bar.html");
    await bar.getByText("Update the saved password?").waitFor();
    await bar.getByRole("button", { name: "Update" }).click();
    await loginPage.waitForFunction(() => !document.querySelector("warren-bar"));
    const s = await apiSession(vaultUser);
    const c = (await s.ciphers()).find((x) => x.login?.username === "bar-user" && !x.deletedDate);
    s.done();
    assert.deepEqual([c?.login.password, c?.passwordHistory?.[0]?.password], ["bar-pass-2", "bar-pass"]);
  });

  await step("save bar: the saved login typed in other letter case offers nothing", async () => {
    await loginPage.goto(`${SITE}/login`);
    await loginPage.fill("#u", "BAR-USER");
    await loginPage.fill("#p", "bar-pass-2");
    await loginPage.keyboard.press("Escape");
    await loginPage.getByRole("button", { name: "Sign in" }).click();
    await loginPage.waitForTimeout(1500);
    assert.equal(await loginPage.locator("warren-bar").count(), 0, "a username in other case was offered as a new login");
  });

  await step("save bar: signing in to a saved login offers nothing, without a username on the page too", async () => {
    // A mistyped password first: an update is offered...
    await loginPage.goto(`${SITE}/login`);
    await loginPage.fill("#u", "bar-user");
    await loginPage.fill("#p", "bar-pass-typo");
    await loginPage.keyboard.press("Escape");
    await loginPage.getByRole("button", { name: "Sign in" }).click();
    await (await frameOf(loginPage, "bar.html")).getByText("Update the saved password?").waitFor();
    // ...then the right one (the password step of a two-step sign-in: no username on the page) takes it back.
    await loginPage.waitForTimeout(5100); // one report per 5 s
    await loginPage.fill("#u", "");
    await loginPage.fill("#p", "bar-pass-2");
    await loginPage.keyboard.press("Escape");
    await loginPage.getByRole("button", { name: "Sign in" }).click();
    await loginPage.waitForFunction(() => !document.querySelector("warren-bar"), undefined, { timeout: 5000 });
    await loginPage.goto(`${SITE}/login`); // the dropped save is not shown again on the next page
    await loginPage.waitForTimeout(1500);
    assert.equal(await loginPage.locator("warren-bar").count(), 0, "a stale save came back");
  });

  await step("save bar: a re-prompt item is never offered an update from inside a page", async () => {
    if (page.isClosed()) await reopenPopup(); // the previous popup fill closed it
    const saved = await page.evaluate((site) => chrome.runtime.sendMessage({ type: "saveItem", item: { type: 1, name: "Guarded login", reprompt: 1, login: { username: "guard-user", password: "guard-pass", uris: [{ uri: site, match: null }] } } }), SITE);
    assert.equal(saved.ok, true);
    await loginPage.goto(`${SITE}/login`);
    await loginPage.fill("#u", "guard-user");
    await loginPage.fill("#p", "guard-pass-2");
    await loginPage.keyboard.press("Escape");
    await loginPage.getByRole("button", { name: "Sign in" }).click();
    await loginPage.waitForTimeout(2000);
    assert.equal(await loginPage.evaluate(() => !!document.querySelector("warren-bar")), false, "bar offered an update");
    const s = await apiSession(vaultUser);
    const c = (await s.ciphers()).find((x) => x.name === "Guarded login");
    s.done();
    assert.equal(c?.login.password, "guard-pass");
    const id = saved.data.items.find((i: { name: string }) => i.name === "Guarded login").id;
    await page.evaluate((id) => chrome.runtime.sendMessage({ type: "deleteItem", id }), id);
    await page.evaluate((id) => chrome.runtime.sendMessage({ type: "purgeItem", id }), id);
  });

  await step("save bar: change-password form offers the new password, not the current one", async () => {
    await loginPage.goto(`${SITE}/change`);
    for (const [id, v] of [["u", "bar-user"], ["cur", "bar-pass-2"], ["new", "bar-pass-3"], ["rep", "bar-pass-3"]] as const) await loginPage.fill(`#${id}`, v);
    await loginPage.keyboard.press("Escape");
    await loginPage.click("button");
    const bar = await frameOf(loginPage, "bar.html");
    await bar.getByRole("button", { name: "Update" }).click();
    await loginPage.waitForFunction(() => !document.querySelector("warren-bar"));
    const s = await apiSession(vaultUser);
    const c = (await s.ciphers()).find((x) => x.login?.username === "bar-user" && !x.deletedDate);
    s.done();
    assert.equal(c?.login.password, "bar-pass-3");
  });

  await step("lock drops a typed password waiting in the save bar", async () => {
    if (page.isClosed()) await reopenPopup();
    await loginPage.goto(`${SITE}/login`);
    await loginPage.fill("#u", "lock-user");
    await loginPage.fill("#p", "lock-pass");
    await loginPage.keyboard.press("Escape");
    await loginPage.getByRole("button", { name: "Sign in" }).click();
    await frameOf(loginPage, "bar.html");
    const waiting = () => sw.evaluate(async () => Object.keys(await chrome.storage.session.get(null)).filter((k) => k.startsWith("save:")).length);
    assert.equal(await waiting(), 1);
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "lock" }));
    assert.equal(await waiting(), 0);
    await unlockIfLocked();
  });

  await step("lock does not wait behind a slow server call", async () => {
    await sw.evaluate((server) => {
      const g = globalThis as any;
      g.realFetch = g.fetch;
      // Hold only server calls: setIcon loads the toolbar icon with fetch("icons/…") and must not take the release hook.
      g.fetch = (...a: Parameters<typeof fetch>) =>
        String(a[0] instanceof Request ? a[0].url : a[0]).startsWith(server)
          ? new Promise((r) => (g.releaseFetch = () => r(g.realFetch(...a))))
          : g.realFetch(...a);
    }, BASE);
    const sync = page.evaluate(() => chrome.runtime.sendMessage({ type: "sync", force: true }));
    await poll("sync in flight", () => sw.evaluate(() => !!(globalThis as any).releaseFetch));
    const locked = page.evaluate(() => chrome.runtime.sendMessage({ type: "lock" })).then(() => "locked");
    const result = await Promise.race([locked, new Promise((r) => setTimeout(() => r("still waiting"), 5000))]);
    await sw.evaluate(() => {
      const g = globalThis as any;
      g.fetch = g.realFetch;
      g.releaseFetch();
      delete g.releaseFetch;
    });
    await sync;
    assert.equal(result, "locked");
    await unlockIfLocked();
  });

  await step("inline menu: a menu frame without the page's nonce is refused", async () => {
    const s = await apiSession(vaultUser);
    const github = (await s.ciphers()).find((x) => x.name === "GitHub")!;
    s.done();
    await loginPage.goto(`${SITE}/login`);
    await loginPage.click("#u");
    const menu = await frameOf(loginPage, "menu.html");
    // A copy of menu.html framed by the page has no fragment: the worker refuses it before matching.
    const r = await menu.evaluate((id) => chrome.runtime.sendMessage({ type: "inlineFill", id, nonce: "not-the-nonce" }), github.id);
    assert.equal(r.ok, false);
    assert.match(r.error, /not the one opened/);
    assert.deepEqual(await fieldValues(), ["", ""]);
  });

  await step("inline menu: a fill for an item not offered for this field is refused", async () => {
    const s = await apiSession(vaultUser);
    const github = (await s.ciphers()).find((x) => x.name === "GitHub")!; // saved for github.com, not this site
    s.done();
    await loginPage.goto(`${SITE}/login`);
    await loginPage.click("#u");
    const menu = await frameOf(loginPage, "menu.html");
    const r = await menu.evaluate((id) => chrome.runtime.sendMessage({ type: "inlineFill", id, nonce: location.hash.slice(1) }), github.id);
    assert.deepEqual([r.ok, r.error], [false, "item not available here"]);
    assert.deepEqual(await fieldValues(), ["", ""]);
  });

  await step("default password manager: Chrome's own password saving off, then handed back", async () => {
    if (page.isClosed()) await reopenPopup(); // a popup fill closes the popup
    const set = (enabled: boolean) => page.evaluate((e) => chrome.runtime.sendMessage({ type: "setDefaultManager", enabled: e }), enabled);
    const prefs = () =>
      sw.evaluate(async () => {
        const s = chrome.privacy.services;
        const all = { passwordSaving: s.passwordSavingEnabled, address: s.autofillAddressEnabled, card: s.autofillCreditCardEnabled };
        return Object.fromEntries(await Promise.all(Object.entries(all).map(async ([k, p]) => [k, await p.get({})])));
      });
    const before = await prefs();
    const ours = Object.keys(before).filter((k) => before[k].levelOfControl === "controllable_by_this_extension");
    console.log(`    controllable here: ${ours.join(", ") || "none"} (${Object.entries(before).map(([k, v]) => `${k}=${v.levelOfControl}`).join(", ")})`);
    assert.ok(ours.length, "no Chrome autofill preference is controllable in this browser");
    assert.equal((await set(true)).ok, true);
    const on = await prefs();
    for (const k of ours) assert.deepEqual([k, on[k].value, on[k].levelOfControl], [k, false, "controlled_by_this_extension"]);
    assert.equal((await set(false)).ok, true);
    const off = await prefs();
    for (const k of ours) assert.equal(off[k].levelOfControl, "controllable_by_this_extension", k);
  });

  // ---------- passkeys ----------
  // The page calls WebAuthn; our approval window opens as a new page; Node verifies the results.
  const approve = async (action: (w: Page) => Promise<void>) => {
    const w = await ctx.waitForEvent("page", { predicate: (p) => p.url().includes("popup.html?passkey=") });
    await w.waitForLoadState();
    // A decision closes the window, sometimes before the click that made it returns.
    await action(w).catch((e: unknown) => {
      if (!w.isClosed()) throw e;
    });
  };
  const challenge = randomBytes(32);
  let spki = "";

  await step("passkeys: page shim and relay are registered on every secure site", async () => {
    await unlockIfLocked();
    const scripts = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts());
    assert.deepEqual(scripts.map((s) => s.id).sort(), ["warren-passkey-page", "warren-passkey-relay"]);
    await loginPage.reload(); // the shim applies to new documents
  });

  await step("passkeys: create on a site, saved to the vault, attestation valid", async () => {
    const created = loginPage.evaluate(async (ch) => {
      const c = (await navigator.credentials.create({
        publicKey: {
          rp: { name: "Local app" }, user: { id: new Uint8Array([1, 2, 3, 4]), name: "pk-user", displayName: "PK User" },
          challenge: Uint8Array.from(ch), pubKeyCredParams: [{ type: "public-key", alg: -7 }], authenticatorSelection: { residentKey: "required" },
        },
      })) as PublicKeyCredential;
      const r = c.response as AuthenticatorAttestationResponse;
      const b = (x: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(x)));
      return { proto: c instanceof PublicKeyCredential, id: c.id, clientData: new TextDecoder().decode(r.clientDataJSON), authData: b(r.getAuthenticatorData()), spki: b(r.getPublicKey()!) };
    }, [...challenge]);
    await approve(async (w) => {
      await w.getByText("Save a passkey for pk-user on Local app?").waitFor();
      // The site's own login (no passkey yet) is offered to join; this one is saved on its own.
      await w.getByRole("listitem").filter({ hasText: "local-user" }).waitFor();
      await w.getByRole("button", { name: "Save as a new login" }).click();
    });
    const c = await created;
    assert.ok(c.proto, "not a PublicKeyCredential");
    const cd = JSON.parse(c.clientData);
    assert.deepEqual([cd.type, cd.origin, cd.challenge], ["webauthn.create", SITE, challenge.toString("base64url")]);
    const ad = Buffer.from(c.authData, "base64");
    assert.ok(ad.subarray(0, 32).equals(createHash("sha256").update("localhost").digest()), "rpIdHash");
    // UV stays clear: the vault was already unlocked and the site did not require verification (presence only).
    assert.equal(ad[32]! & 0x45, 0x41, "UP and AT flags, no UV");
    spki = c.spki;
    const s = await apiSession(vaultUser);
    const item = (await s.ciphers()).find((x) => x.login?.fido2Credentials?.length && !x.deletedDate);
    s.done();
    assert.equal(item?.login.fido2Credentials[0].rpId, "localhost");
    assert.equal(item?.login.username, "pk-user");
  });

  await step("passkeys: sign in with the stored passkey, signature verifies", async () => {
    const got = loginPage.evaluate(async (ch) => {
      const c = (await navigator.credentials.get({ publicKey: { challenge: Uint8Array.from(ch), rpId: "localhost", userVerification: "required" } })) as PublicKeyCredential;
      const r = c.response as AuthenticatorAssertionResponse;
      const b = (x: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(x)));
      return { clientData: b(r.clientDataJSON), authData: b(r.authenticatorData), sig: b(r.signature), user: b(r.userHandle!) };
    }, [...challenge]);
    // The site requires user verification: the window asks for the master password before it signs.
    await approve(async (w) => {
      await w.getByLabel(/verify it is you/).fill(vaultUser.password);
      await w.getByRole("listitem").filter({ hasText: "pk-user" }).click();
    });
    const g = await got;
    assert.equal(Buffer.from(g.authData, "base64")[32]! & 0x05, 0x05, "UP and UV flags after the master password");
    const clientData = Buffer.from(g.clientData, "base64");
    assert.equal(JSON.parse(clientData.toString()).type, "webauthn.get");
    const signed = Buffer.concat([Buffer.from(g.authData, "base64"), createHash("sha256").update(clientData).digest()]);
    const key = createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" });
    assert.ok(verify("sha256", signed, key, Buffer.from(g.sig, "base64")), "assertion signature");
    assert.deepEqual([...Buffer.from(g.user, "base64")], [1, 2, 3, 4]);
  });

  await step("passkeys: the inline menu entry signs in directly, without an approval window", async () => {
    // A passkey form: the site starts a conditional get (passkey autofill) and focuses the username field.
    await loginPage.goto(`${SITE}/login`);
    const got = loginPage.evaluate(async (ch) => {
      const pending = navigator.credentials.get({
        mediation: "conditional",
        publicKey: { challenge: Uint8Array.from(ch), rpId: "localhost" },
      }) as Promise<PublicKeyCredential>;
      const c = await pending;
      const r = c.response as AuthenticatorAssertionResponse;
      const b = (x: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(x)));
      return { clientData: b(r.clientDataJSON), authData: b(r.authenticatorData), sig: b(r.signature), user: b(r.userHandle!) };
    }, [...challenge]);
    await loginPage.locator("#u").click(); // a real focus, once the content script is listening
    got.catch(() => undefined); // a failing step must report its own error, not this call dying with the page
    const entry = (await frameOf(loginPage, "menu.html")).getByRole("button", { name: "Sign in with passkey" });
    await entry.waitFor();
    const opened: Page[] = [];
    const watch = (p: Page) => opened.push(p);
    ctx.on("page", watch);
    await entry.click();
    const g = await got;
    ctx.off("page", watch);
    assert.deepEqual(opened.filter((p) => p.url().includes("popup.html?passkey=")), [], "an approval window opened");
    const clientData = Buffer.from(g.clientData, "base64");
    assert.equal(JSON.parse(clientData.toString()).type, "webauthn.get");
    const signed = Buffer.concat([Buffer.from(g.authData, "base64"), createHash("sha256").update(clientData).digest()]);
    const key = createPublicKey({ key: Buffer.from(spki, "base64"), format: "der", type: "spki" });
    assert.ok(verify("sha256", signed, key, Buffer.from(g.sig, "base64")), "assertion signature");
    assert.deepEqual([...Buffer.from(g.user, "base64")], [1, 2, 3, 4]);
  });

  await step("passkeys: a new passkey can join a login the site already has", async () => {
    await loginPage.locator("#u").click(); // the shim leaves an unfocused document to the browser; the menu frame that held the focus is gone
    const created = loginPage.evaluate(async (ch) => {
      const c = await navigator.credentials.create({
        publicKey: {
          rp: { name: "Local app" }, user: { id: new Uint8Array([5, 6, 7, 8]), name: "pk-two", displayName: "PK Two" },
          challenge: Uint8Array.from(ch), pubKeyCredParams: [{ type: "public-key", alg: -7 }], authenticatorSelection: { residentKey: "required" },
        },
      });
      return c?.type;
    }, [...challenge]);
    await approve(async (w) => {
      // The item made by the first create holds a passkey: offered, but replaced only after a confirmation.
      await w.getByRole("listitem").filter({ hasText: "pk-user, already has a passkey" }).click();
      await w.getByText("already has a passkey. Replace it with the new one?").waitFor();
      await w.getByRole("button", { name: "Cancel" }).click();
      await w.getByRole("listitem").filter({ hasText: "local-user" }).click();
    });
    assert.equal(await created, "public-key");
    const s = await apiSession(vaultUser);
    const all = (await s.ciphers()).filter((x) => !x.deletedDate);
    s.done();
    const local = all.filter((x) => x.name === "Local app" && x.login?.username === "local-user");
    assert.equal(local.length, 1, "joined login duplicated");
    assert.equal(local[0]!.login.password, "local-pass-2", "joined login lost its password");
    assert.equal(local[0]!.login.fido2Credentials?.length, 1);
    assert.equal(all.filter((x) => x.login?.fido2Credentials?.length).length, 2);
  });

  await step("passkeys: closing the window hands the call back to the browser", async () => {
    // An empty virtual authenticator without UI makes the browser's own WebAuthn fail at once (headless
    // Chromium otherwise sometimes waits for UI that never comes).
    await loginPage.locator("#u").click(); // the shim leaves an unfocused document to the browser; the menu frame that held the focus is gone
    const cdp = await ctx.newCDPSession(loginPage);
    await cdp.send("WebAuthn.enable", { enableUI: false });
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: authenticator });
    const got = loginPage.evaluate(async (ch) => {
      try {
        await navigator.credentials.get({ publicKey: { challenge: Uint8Array.from(ch), rpId: "localhost", timeout: 1000 } });
        return "resolved";
      } catch (e) {
        return (e as DOMException).name;
      }
    }, [...challenge]);
    await approve((w) => w.close());
    // The browser's own WebAuthn (the virtual authenticator has no credential) refuses.
    assert.equal(await got, "NotAllowedError");
    await cdp.detach();
  });

  await step("passkeys: no matching passkey shows the window; a security key list goes to the browser", async () => {
    await loginPage.locator("#u").click();
    const cdp = await ctx.newCDPSession(loginPage);
    await cdp.send("WebAuthn.enable", { enableUI: false });
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: authenticator });
    const ask = (transports: string[] | undefined) =>
      loginPage.evaluate(async ({ ch, transports }) => {
        try {
          const allowCredentials = [{ type: "public-key" as const, id: new Uint8Array(16).fill(7), ...(transports ? { transports: transports as AuthenticatorTransport[] } : {}) }];
          await navigator.credentials.get({ publicKey: { challenge: Uint8Array.from(ch), rpId: "localhost", allowCredentials, timeout: 1000 } });
          return "resolved";
        } catch (e) {
          return (e as DOMException).name;
        }
      }, { ch: [...challenge], transports });
    // A passkey Warren does not hold (saved elsewhere, like Google's): Warren's window says so (Google's case).
    const got = ask(["internal", "hybrid"]);
    await approve(async (w) => {
      await w.getByText("No passkey for this site in your vault").waitFor();
      await w.getByRole("button", { name: "Use another device or browser" }).click();
    });
    assert.equal(await got, "NotAllowedError"); // the browser's own WebAuthn: the virtual key has no such credential
    // Security keys only: straight to the browser, no window.
    const opened: Page[] = [];
    const watch = (p: Page) => opened.push(p);
    ctx.on("page", watch);
    assert.equal(await ask(["usb", "nfc"]), "NotAllowedError");
    ctx.off("page", watch);
    assert.deepEqual(opened.filter((p) => p.url().includes("popup.html?passkey=")), [], "a security-key-only request opened Warren's window");
    await cdp.detach();
  });

  // ---------- SSO (mock IdP from docker-compose.yml) ----------
  const ssoUser = await register("sso", [1, 3, 64, 4]);

  await step("SSO: IdP login, connector tab closes itself, vault unlocks with the master password", async () => {
    await fetch("http://localhost:9090/_next", { method: "POST", body: JSON.stringify({ email: ssoUser.email }) });
    await logout();
    const tab = ctx.waitForEvent("page") // the SSO tab (its URL is still about:blank or mid-redirect here);
    await click("Log in with SSO");
    const t = await tab;
    await t.waitForEvent("close", { timeout: 20_000 }); // finishSso closes it after redeeming the code
    await open();
    await page.getByRole("heading", { name: "Vault locked" }).waitFor();
    assert.ok((await page.locator("#app").innerText()).includes(ssoUser.email));
    await fill("Master password", ssoUser.password);
    await click("Unlock");
    await expectUnlocked();
    const session = await sw.evaluate(() => chrome.storage.session.get("session"));
    assert.equal((session.session as { sso?: unknown }).sso, undefined, "SSO state left behind");
    assert.equal((await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts({ ids: ["warren-sso-callback"] }))).length, 0);
  });

  await step("SSO: a callback with a foreign state is refused", async () => {
    await logout();
    // Hold the connector page back until the state is replaced: otherwise a fast redirect finishes the
    // login before the test gets to it, and the callback is not foreign at all.
    let replaced!: () => void;
    const held = new Promise<void>((r) => (replaced = r));
    await ctx.route("**/sso-connector.html*", async (route) => {
      await held;
      await route.continue();
    });
    const tab = ctx.waitForEvent("page") // the SSO tab (its URL is still about:blank or mid-redirect here);
    await click("Log in with SSO");
    const t = await tab;
    // Replace our pending state, as if the callback belonged to someone else's login.
    await sw.evaluate(async () => {
      const s = (await chrome.storage.session.get("session")).session as Record<string, any>;
      await chrome.storage.session.set({ session: { ...s, sso: { ...s.sso, state: "other:clientId=browser" } } });
    });
    replaced();
    await t.waitForEvent("close", { timeout: 20_000 });
    await ctx.unroute("**/sso-connector.html*");
    await open();
    await page.getByRole("heading", { name: "Log in" }).waitFor();
    await page.getByRole("alert").filter({ hasText: "did not come from this browser" }).waitFor();
  });

  console.log(`\n${passed.length} steps passed (${await ctx.browser()?.version() ?? "persistent context"})`);
} finally {
  await ctx.close();
  site.close();
  rmSync(profile, { recursive: true, force: true });
}
