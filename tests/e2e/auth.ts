// e2e group "auth": transport, setup, password/PIN/2FA logins, lock, logout.
// Runs alone with --only auth (run.ts), together with the groups it imports.
import assert from "node:assert/strict";
import { passwordToken, prelogin, refreshToken, revisionDate } from "../../src/transport/auth.ts";
import { BASE, step, authHash, register, poll, freshTotp, enableTotp, sw, popupUrl, page, open, heading, fill, click, loginAs, expectUnlocked, logout } from "./harness.ts";

export const pbkdf2 = await register("pbkdf2", [0, 600000, 0, 0]);
export const argon = await register("argon2", [1, 3, 64, 4]);
export const totpUser = await register("totp", [0, 600000, 0, 0]);
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
  assert.ok(ms > 0, "no first-render mark");
  // A busy laptop misses 100 ms now and then; CI's idle runner is the guard.
  if (process.env.CI) assert.ok(ms < 100, `first render took ${ms} ms`);
  else if (ms >= 100) console.warn(`    warning: first render ${ms.toFixed(1)} ms (fails in CI from 100 ms)`);
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
