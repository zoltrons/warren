// e2e group "autofill": popup fill, badge, context menu, keyboard shortcut.
// Runs alone with --only autofill (run.ts), together with the groups it imports.
import assert from "node:assert/strict";
import { TOTP_KEY, wasm, step, poll, totpNow, apiSession, SITE, ctx, sw, popupUrl, readClipboard, page, setPage, unlockIfLocked } from "./harness.ts";
import { vaultUser } from "./vault.ts";

export const s3 = await apiSession(vaultUser);
await s3.create({ type: 1, name: "Local app", login: { username: "local-user", password: "local-pass", totp: TOTP_KEY, uris: [{ uri: SITE, match: null }] } });
s3.done();
export const loginPage = await ctx.newPage();
await loginPage.goto(`${SITE}/login`);
export const reopenPopup = async () => {
  if (page.isClosed()) setPage(await ctx.newPage());
  await loginPage.bringToFront(); // the "active tab" the popup works on
  await page.goto(popupUrl);
};
export const fieldValues = () =>
  loginPage.evaluate(() => [(document.getElementById("u") as HTMLInputElement).value, (document.getElementById("p") as HTMLInputElement).value]);
export const setFields = (u: string, p: string) =>
  loginPage.evaluate(([u, p]) => {
    (document.getElementById("u") as HTMLInputElement).value = u!;
    (document.getElementById("p") as HTMLInputElement).value = p!;
  }, [u, p]);

await step("autofill: popup lists site matches and fills the page; TOTP code copied", async () => {
  await unlockIfLocked();
  // "Local app" was added on the server while locked; an unlock does not sync, so ask for one rather than race the popup's.
  await page.evaluate(() => chrome.runtime.sendMessage({ type: "sync", force: true }));
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

export const shortcut = () =>
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
