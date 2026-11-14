// e2e group "vault": vault list, items, edit, folders, trash, orgs, import/export, settings.
// Runs alone with --only vault (run.ts), together with the groups it imports.
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { answerAuthRequest, authRequestStatus, createAuthRequest, passwordToken, pendingAuthRequests } from "../../src/transport/auth.ts";
import { call } from "../../src/transport/http.ts";
import { emailBreaches } from "../../src/transport/vault.ts";
import { BASE, TOTP_KEY, wasm, step, authHash, register, poll, totpNow, apiSession, createOrgNote, ctx, sw, readClipboard, page, open, fill, click, loginAs, expectUnlocked, unlockIfLocked, logout, rows, back, ensureSignedIn } from "./harness.ts";

await ensureSignedIn();
export const vaultUser = await register("vault", [1, 3, 64, 4]);
export const api = await apiSession(vaultUser);
export const work = await api.folder("Work");
await api.create({ type: 1, name: "GitHub", folderId: work.id, login: { username: "octo", password: "gh-secret-1", totp: TOTP_KEY, uris: [{ uri: "https://github.com/login", match: null }] }, fields: [{ name: "PIN", value: "4321", type: 1 }] });
// Keyed, so the attachments step covers an attachment key wrapped with the item's own key.
await api.create({ type: 2, name: "Wifi note", notes: "SSID: home\npassword: hunter2", secureNote: { type: 0 } }, true);
await api.create({ type: 3, name: "Visa", card: { cardholderName: "Ada L", number: "4111111111111111", code: "123", brand: "Visa", expMonth: "1", expYear: "2030" } });
api.done();

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
  // textContent: innerText leaves out rows not rendered yet (content-visibility: auto, popup.css).
  assert.match((await rows().first().textContent()) ?? "", /GitHub/);
  await page.getByRole("button", { name: "Work", exact: true }).click(); // chips toggle off again
  assert.equal(await rows().count(), 3);
  // Back from an item: the row is where it was on screen and has focus (popup.ts scroll memory).
  const github = rows().filter({ hasText: "GitHub" }).first();
  const top = await github.evaluate((e) => e.getBoundingClientRect().top);
  await github.click();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await page.waitForFunction((t) => {
    const a = document.activeElement as HTMLElement | null;
    return !!a?.textContent?.includes("GitHub") && Math.abs(a.getBoundingClientRect().top - t) < 1;
  }, top);
  // Opening builds the list once: the site matches come with it, and the sync after it, finding nothing new, only
  // spins the sync button. Counted from before the popup's own script runs, so a fast sync cannot slip past.
  await page.addInitScript(() =>
    addEventListener("DOMContentLoaded", () => {
      const app = document.getElementById("app")!;
      const w = window as unknown as { listRenders: number };
      w.listRenders = 0;
      new MutationObserver(() => void (app.querySelector(".list-body [role=listitem]") && w.listRenders++)).observe(app, { childList: true });
    }),
  );
  await open();
  await rows().first().waitFor();
  await page.waitForTimeout(1500); // the sync ends well within this on the local server
  await page.waitForFunction(() => document.getElementById("vault-sync")?.matches(":not(:disabled, .spin)"));
  assert.equal(await page.evaluate(() => (window as unknown as { listRenders: number }).listRenders), 1, "the list was built more than once");
});

await step("list order: name both ways and most opened", async () => {
  const order = async (...names: string[]) => {
    const text = await rows().allTextContents();
    return names.map((n) => text.findIndex((x) => x.includes(n)));
  };
  const sortBy = async (label: string) => {
    await page.getByRole("button", { name: "Sort", exact: true }).click();
    await page.getByRole("menu").getByText(label, { exact: true }).click();
  };
  let [gh, wifi] = await order("GitHub", "Wifi note");
  assert.ok(gh! >= 0 && wifi! >= 0 && gh! < wifi!, "A-Z: GitHub before Wifi note");
  await sortBy("Name (Z–A)");
  [gh, wifi] = await order("GitHub", "Wifi note");
  assert.ok(wifi! < gh!, "Z-A reverses it");
  await sortBy("Most opened");
  for (let i = 0; i < 2; i++) {
    await rows().filter({ hasText: "Wifi note" }).first().click();
    await page.getByRole("heading", { name: "Wifi note" }).waitFor();
    await back();
  }
  // The counts are stored asynchronously and the list lands a frame after Back: poll.
  for (let i = 0; i < 30; i++) {
    await rows().first().waitFor();
    [gh, wifi] = await order("GitHub", "Wifi note");
    if (wifi! >= 0 && gh! >= 0 && wifi! < gh!) break;
    await page.waitForTimeout(100);
  }
  assert.ok(wifi! >= 0 && wifi! < gh!, "the more often opened item leads");
  await sortBy("Name (A–Z)");
  [gh, wifi] = await order("GitHub", "Wifi note");
  assert.ok(gh! < wifi!, "back to A-Z");
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

await step("archive: leaves the list, shows in the archive, comes back", async () => {
  await rows().filter({ hasText: "Wifi note" }).click();
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await page.getByRole("status").filter({ hasText: "Archived" }).waitFor();
  assert.equal(await rows().filter({ hasText: "Wifi note" }).count(), 0);
  let s = await apiSession(vaultUser);
  assert.ok((await s.ciphers()).find((x) => x.name === "Wifi note")?.archivedDate, "not archived on the server");
  s.done();
  await page.getByRole("button", { name: "Archive (1)" }).click();
  await rows().filter({ hasText: "Wifi note" }).click();
  await page.getByText("This item is archived").waitFor();
  await page.getByRole("button", { name: "Unarchive" }).click();
  await page.getByRole("status").filter({ hasText: "Moved back to the vault" }).waitFor();
  await rows().filter({ hasText: "Wifi note" }).waitFor();
  s = await apiSession(vaultUser);
  assert.ok(!(await s.ciphers()).find((x) => x.name === "Wifi note")?.archivedDate, "still archived on the server");
  s.done();
});

await step("security report: breach check finds only the login whose hash HIBP lists", async () => {
  // Earlier steps edited this login, so take its password as the server has it now.
  const s = await apiSession(vaultUser);
  const password = (await s.ciphers()).find((x) => x.name === "GitHub")?.login?.password as string;
  s.done();
  assert.ok(password, "GitHub has no password");
  const hex = createHash("sha1").update(password).digest("hex").toUpperCase();
  const asked: string[] = [];
  await ctx.route("https://api.pwnedpasswords.com/range/*", (route) => {
    const prefix = route.request().url().split("/").pop()!;
    asked.push(prefix);
    void route.fulfill({ status: 200, contentType: "text/plain", body: prefix === hex.slice(0, 5) ? `${hex.slice(5)}:7\r\n` : "0000000000000000000000000000000000A:0\r\n" });
  });
  // A login on a site that offers TOTP, with none set up, is listed; it is removed again at the end.
  const s0 = await apiSession(vaultUser);
  const dropbox = await s0.create({ type: 1, name: "Dropbox no 2FA", login: { username: "d@example.test", password: "Zq8!rT4mVx2#", uris: [{ uri: "https://www.dropbox.com/login", match: null }] } });
  await page.evaluate(() => chrome.runtime.sendMessage({ type: "sync", force: true }));
  await rows().filter({ hasText: "Dropbox no 2FA" }).first().waitFor();
  await page.getByRole("button", { name: "Security report" }).click();
  await page.getByRole("heading", { name: "Security report" }).waitFor();
  await page.getByRole("heading", { name: "Two-step codes available but not set up (1)" }).waitFor();
  await page.getByRole("button", { name: "Check for breached passwords" }).click();
  await page.getByRole("heading", { name: "Passwords found in breaches (1)" }).waitFor();
  assert.ok(asked.includes(hex.slice(0, 5)), "the prefix was not asked for");
  assert.ok(asked.every((p) => /^[0-9A-F]{5}$/.test(p)), "more than a 5-digit prefix left the device");
  await ctx.unroute("https://api.pwnedpasswords.com/range/*");
  await page.getByRole("button", { name: "Back" }).click();
  await call(BASE, "DELETE", `/api/ciphers/${dropbox.id}`, { token: s0.token });
  s0.done();
  await page.evaluate(() => chrome.runtime.sendMessage({ type: "sync", force: true }));
  await page.waitForFunction(() => !document.body.textContent?.includes("Dropbox no 2FA"));
});

await step("server HIBP proxy: without an admin key the extension's lookup says so", async () => {
  const s = await apiSession(vaultUser);
  const r = await emailBreaches(BASE, s.token, "someone@example.test");
  s.done();
  assert.deepEqual(r, { status: "unconfigured" });
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

await step("editor: bank account and passport are created, shown and stored encrypted", async () => {
  await page.getByRole("button", { name: "New item" }).click();
  await page.getByRole("button", { name: "Bank account", exact: true }).click();
  await fill("Name", "Main bank");
  await fill("Bank name", "Acme Bank");
  await fill("Account number", "12345678");
  await fill("IBAN", "DE89370400440532013000");
  await page.getByRole("button", { name: "Save" }).click();
  await rows().filter({ hasText: "Main bank" }).waitFor();
  await page.getByRole("button", { name: "New item" }).click();
  await page.getByRole("button", { name: "Passport", exact: true }).click();
  await fill("Name", "My passport");
  await fill("Given name", "Ada");
  await fill("Surname", "Lovelace");
  await fill("Passport number", "P1234567");
  await page.getByRole("button", { name: "Save" }).click();
  // The sub line shows the holder's name; the item page is not opened, so "Recently opened" stays as later steps expect.
  await rows().filter({ hasText: "Ada Lovelace" }).waitFor();
  await rows().filter({ hasText: "Acme Bank" }).waitFor();
  const s = await apiSession(vaultUser);
  const all = await s.ciphers();
  s.done();
  const bank = all.find((x) => x.name === "Main bank");
  assert.deepEqual([bank?.type, bank?.bankAccount?.bankName, bank?.bankAccount?.iban], [6, "Acme Bank", "DE89370400440532013000"]);
  const pp = all.find((x) => x.name === "My passport");
  assert.deepEqual([pp?.type, pp?.passport?.givenName, pp?.passport?.passportNumber], [8, "Ada", "P1234567"]);
});

await step("default-manager banner is dismissed for good; breach warning on save is opt-in", async () => {
  await page.getByText("Let Warren handle passwords in this browser").waitFor();
  await page.getByRole("button", { name: "Not now" }).click();
  await page.getByText("Let Warren handle passwords in this browser").waitFor({ state: "hidden" });
  const hex = createHash("sha1").update("123456").digest("hex").toUpperCase();
  await ctx.route("https://api.pwnedpasswords.com/range/*", (route) => {
    const prefix = route.request().url().split("/").pop()!;
    void route.fulfill({ status: 200, contentType: "text/plain", body: prefix === hex.slice(0, 5) ? `${hex.slice(5)}:5\r\n` : "0000000000000000000000000000000000A:0\r\n" });
  });
  // Off by default: a save sends nothing to HIBP and warns about nothing.
  await page.getByRole("button", { name: "New item" }).click();
  await fill("Name", "Quiet save");
  await fill("Password", "123456");
  await page.getByRole("button", { name: "Save" }).click();
  await rows().filter({ hasText: "Quiet save" }).waitFor();
  assert.equal(await page.getByText("known data breaches").count(), 0);
  // A weak password puts the "needs attention" banner on the list; Review opens the report, which lists it.
  await page.getByText(/Logins need attention/).waitFor();
  await page.getByRole("button", { name: "Review" }).click();
  await page.getByRole("heading", { name: /Weak passwords/ }).waitFor();
  await back();
  // "Don't show again" is for good: a reopened popup has no banner until Settings turns it back on.
  await page.getByRole("button", { name: "Don't show again" }).click();
  await page.getByText(/Logins need attention/).waitFor({ state: "hidden" });
  await page.reload();
  await rows().filter({ hasText: "Quiet save" }).waitFor();
  assert.equal(await page.getByText(/Logins need attention/).count(), 0);
  await page.evaluate(() => localStorage.setItem("attentionBanner", "on"));
  await page.evaluate(() => localStorage.setItem("breachSave", "on"));
  await page.getByRole("button", { name: "New item" }).click();
  await fill("Name", "Loud save");
  await fill("Password", "123456");
  await page.getByRole("button", { name: "Save" }).click();
  await page.getByText("Found in 5 known data breaches").waitFor();
  await page.evaluate(() => localStorage.setItem("breachSave", "off"));
  await ctx.unroute("https://api.pwnedpasswords.com/range/*");
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
  await page.getByRole("combobox", { name: "Type" }).selectOption("passphrase");
  await page.waitForFunction(() => (document.querySelector("output")?.textContent ?? "").split("-").length === 5);
});

await step("generator: usernames (random word, plus-addressed email, catch-all)", async () => {
  const until = (re: RegExp) => page.waitForFunction((src) => new RegExp(src).test(document.querySelector("output")?.textContent ?? ""), re.source);
  await page.getByRole("combobox", { name: "Type" }).selectOption("username");
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
  await page.getByRole("combobox", { name: "Type" }).selectOption("alias");
  await page.getByLabel("API key").fill("sl-token-secret");
  // No blur and no change event: the popup just goes away, like a click outside it.
  await poll("alias key saved", () => sw.evaluate(async () => !!(await chrome.storage.local.get("aliasSettings")).aliasSettings));
  const raw = await sw.evaluate(async () => (await chrome.storage.local.get("aliasSettings")).aliasSettings);
  assert.ok(raw.startsWith("2.") && !raw.includes("sl-token-secret"), raw);
  await page.evaluate(() => chrome.runtime.sendMessage({ type: "lock" }));
  await unlockIfLocked();
  await page.getByRole("button", { name: "Generator" }).click();
  await poll("alias key restored", async () => (await page.getByLabel("API key").inputValue()) === "sl-token-secret");
  await page.getByRole("combobox", { name: "Type" }).selectOption("username");
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

// Design review screenshots (not assertions): SHOTS=<dir> node --experimental-strip-types tests/e2e/run.ts --only vault
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
  // The DOM, not what is painted: a skipped (content-visibility) row would hide from innerText.
  assert.ok(!((await page.locator("#app").textContent()) ?? "").includes("GitHub"));
});
