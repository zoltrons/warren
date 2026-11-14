// e2e group "sso": SSO through the mock IdP of dev/vaultwarden/docker-compose.yml.
// Runs alone with --only sso (run.ts), together with the groups it imports.
import assert from "node:assert/strict";
import { skipRestUnless, step, register, ctx, sw, page, open, fill, click, expectUnlocked, logout, ensureSignedIn } from "./harness.ts";

// The IdP comes with docker-compose.yml; a server started on its own (Apple `container`) has none. CI always has it.
const idp = await fetch("http://localhost:9090/", { signal: AbortSignal.timeout(2000) }).then(() => true, () => false);
skipRestUnless(idp, "no mock IdP on localhost:9090");
if (idp) await ensureSignedIn();
export const ssoUser = await register("sso", [1, 3, 64, 4]);

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
