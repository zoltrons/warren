// e2e group "webauthn": WebAuthn two-step login and the side panel.
// Runs alone with --only webauthn (run.ts), together with the groups it imports.
import assert from "node:assert/strict";
import { passwordToken } from "../../src/transport/auth.ts";
import { call } from "../../src/transport/http.ts";
import { BASE, closingClick, step, authHash, register, ctx, sw, id, page, loginAs, expectUnlocked, logout, authenticator, ensureSignedIn } from "./harness.ts";

await ensureSignedIn();
export const keyUser = await register("webauthn", [0, 600000, 0, 0]);
// Virtual authenticator on a page of the server origin registers the key like the web vault would.
export const regPage = await ctx.newPage();
await regPage.goto(`${BASE}/alive`);
export const regCdp = await ctx.newCDPSession(regPage);
await regCdp.send("WebAuthn.enable", { enableUI: false });
export const { authenticatorId: regAuth } = await regCdp.send("WebAuthn.addVirtualAuthenticator", { options: authenticator });
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
export const { credentials } = await regCdp.send("WebAuthn.getCredentials", { authenticatorId: regAuth });
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
