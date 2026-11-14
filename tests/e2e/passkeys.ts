// e2e group "passkeys": WebAuthn create/get through Warren.
// Runs alone with --only passkeys (run.ts), together with the groups it imports.
import assert from "node:assert/strict";
import { createHash, createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { type Page } from "playwright-core";
import { call } from "../../src/transport/http.ts";
import { BASE, step, apiSession, SITE, ctx, sw, page, unlockIfLocked, authenticator } from "./harness.ts";
import { vaultUser } from "./vault.ts";
import { loginPage, reopenPopup } from "./autofill.ts";
import { frameOf } from "./inline.ts";

// The page calls WebAuthn; our approval window opens as a new page; Node verifies the results.
export const approve = async (action: (w: Page) => Promise<void>) => {
  const w = await ctx.waitForEvent("page", { predicate: (p) => p.url().includes("popup.html?passkey=") });
  await w.waitForLoadState();
  // A decision closes the window, sometimes before the click that made it returns.
  await action(w).catch((e: unknown) => {
    if (!w.isClosed()) throw e;
  });
};
export const challenge = randomBytes(32);
export let spki = "";

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

await step("passkeys: an imported passkey with a sign counter counts up, saved on the server", async () => {
  const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credentialId = crypto.randomUUID();
  const s = await apiSession(vaultUser);
  const fido2 = { credentialId, keyType: "public-key", keyAlgorithm: "ECDSA", keyCurve: "P-256", keyValue: pair.privateKey.export({ format: "der", type: "pkcs8" }).toString("base64url"), rpId: "localhost", rpName: "Local", userHandle: Buffer.from([9, 9]).toString("base64url"), userName: "imp-pk", userDisplayName: "Imported", counter: "5", discoverable: "true", creationDate: new Date().toISOString() };
  const { id } = await s.create({ type: 1, name: "Imported passkey", login: { username: "imp-pk", uris: [{ uri: SITE, match: null }], fido2Credentials: [fido2] } });
  await loginPage.locator("#u").click();
  const got = loginPage.evaluate(async ({ ch, raw }) => {
    const c = (await navigator.credentials.get({ publicKey: { challenge: Uint8Array.from(ch), rpId: "localhost", allowCredentials: [{ type: "public-key", id: Uint8Array.from(raw) }], userVerification: "discouraged" } })) as PublicKeyCredential;
    const r = c.response as AuthenticatorAssertionResponse;
    const b = (x: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(x)));
    return { clientData: b(r.clientDataJSON), authData: b(r.authenticatorData), sig: b(r.signature) };
  }, { ch: [...challenge], raw: [...Buffer.from(credentialId.replace(/-/g, ""), "hex")] });
  // Not in the local copy yet: the window syncs, then offers it.
  await approve(async (w) => {
    await w.getByRole("listitem").filter({ hasText: "imp-pk" }).click();
  });
  const g = await got;
  const ad = Buffer.from(g.authData, "base64");
  assert.equal(ad.readUInt32BE(33), 6, "sign counter");
  const signed = Buffer.concat([ad, createHash("sha256").update(Buffer.from(g.clientData, "base64")).digest()]);
  assert.ok(verify("sha256", signed, pair.publicKey, Buffer.from(g.sig, "base64")), "assertion signature");
  const saved = (await s.ciphers()).find((x) => x.id === id);
  assert.equal(saved?.login.fido2Credentials[0].counter, "6", "counter saved on the server");
  assert.equal(saved?.login.fido2Credentials[0].keyValue, fido2.keyValue, "the private key survived the save");
  // Gone again (and synced), so the next steps still see one passkey for the site.
  await call(BASE, "DELETE", `/api/ciphers/${id}`, { token: s.token });
  s.done();
  if (page.isClosed()) await reopenPopup();
  await page.evaluate(() => chrome.runtime.sendMessage({ type: "sync", force: true }));
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
  const entry = (await frameOf(loginPage, "menu.html")).getByRole("option", { name: "Sign in with passkey" });
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

await step("passkeys: an automatic upgrade (conditional create) joins the login Warren just filled, and only that", async () => {
  const s = await apiSession(vaultUser);
  const { id } = await s.create({ type: 1, name: "Upgrade me", login: { username: "up-user", password: "up-pass", uris: [{ uri: SITE, match: null }] } });
  if (page.isClosed()) await reopenPopup();
  await page.evaluate(() => chrome.runtime.sendMessage({ type: "sync", force: true }));
  const upgrade = (name: string) =>
    loginPage.evaluate(async ({ ch, name }) => {
      try {
        const c = (await navigator.credentials.create({
          mediation: "conditional",
          publicKey: { rp: { name: "Local" }, user: { id: new Uint8Array([5, 5]), name, displayName: name }, challenge: Uint8Array.from(ch), pubKeyCredParams: [{ type: "public-key", alg: -7 }] },
        } as CredentialCreationOptions)) as PublicKeyCredential;
        return { flags: new Uint8Array((c.response as AuthenticatorAttestationResponse).getAuthenticatorData())[32] };
      } catch (e) {
        return (e as DOMException).name;
      }
    }, { ch: [...challenge], name });
  await loginPage.goto(`${SITE}/login`);
  // Nothing filled in this tab yet: refused, and nothing is saved.
  assert.equal(await upgrade("up-user"), "NotAllowedError");
  await loginPage.click("#u");
  await (await frameOf(loginPage, "menu.html")).getByRole("option", { name: "up-user, Upgrade me" }).click();
  await loginPage.waitForFunction(() => (document.getElementById("p") as HTMLInputElement).value === "up-pass");
  // Another account than the one filled: refused (and the chance is used up).
  assert.equal(await upgrade("someone-else"), "NotAllowedError");
  await loginPage.goto(`${SITE}/login`); // a fresh menu frame, not the one that faded out
  await loginPage.click("#u");
  await (await frameOf(loginPage, "menu.html")).getByRole("option", { name: "up-user, Upgrade me" }).click();
  await loginPage.waitForFunction(() => (document.getElementById("p") as HTMLInputElement).value === "up-pass");
  const made = await upgrade("up-user");
  assert.equal(typeof made, "object", `upgrade refused: ${String(made)}`);
  assert.equal((made as { flags: number }).flags & 0x05, 0, "neither UP nor UV in a conditional create");
  assert.equal(await upgrade("up-user"), "NotAllowedError", "a second upgrade from one fill");
  const saved = (await s.ciphers()).find((x) => x.id === id);
  assert.equal(saved?.login.fido2Credentials?.length, 1, "the passkey did not join the filled login");
  assert.equal(saved?.login.password, "up-pass");
  // Gone again, so later steps see the site's logins as before.
  await call(BASE, "DELETE", `/api/ciphers/${id}`, { token: s.token });
  s.done();
  await page.evaluate(() => chrome.runtime.sendMessage({ type: "sync", force: true }));
});

await step("passkeys: signalCurrentUserDetails renames the site's passkey in the vault", async () => {
  const s = await apiSession(vaultUser);
  const name = async () => (await s.ciphers()).flatMap((x) => x.login?.fido2Credentials ?? []).find((c: { userHandle: string }) => c.userHandle === "AQIDBA")?.userName;
  assert.equal(await name(), "pk-user");
  const signal = (n: string) => loginPage.evaluate((n) => (PublicKeyCredential as unknown as { signalCurrentUserDetails(o: unknown): Promise<void> }).signalCurrentUserDetails({ rpId: "localhost", userId: "AQIDBA", name: n, displayName: n }), n);
  await signal("pk-renamed");
  for (let i = 0; i < 50 && (await name()) !== "pk-renamed"; i++) await loginPage.waitForTimeout(100);
  assert.equal(await name(), "pk-renamed");
  await signal("pk-user"); // back, for the steps after this one
  for (let i = 0; i < 50 && (await name()) !== "pk-user"; i++) await loginPage.waitForTimeout(100);
  assert.equal(await name(), "pk-user");
  s.done();
});

await step("passkeys: a cross-origin frame the page allows gets Warren's passkeys, with crossOrigin and topOrigin", async () => {
  await loginPage.goto(`${SITE}/pk-frame`);
  const frame = () => loginPage.frames().find((f) => f.url() === "http://127.0.0.1:8099/login")!;
  await loginPage.waitForFunction(() => !!document.querySelector("iframe"));
  await loginPage.frameLocator("#pf").locator("#u").click(); // the frame's document needs the focus
  const created = frame().evaluate(async (ch) => {
    const c = (await navigator.credentials.create({ publicKey: { rp: { name: "Framed" }, user: { id: new Uint8Array([7, 7]), name: "framed-user", displayName: "Framed" }, challenge: Uint8Array.from(ch), pubKeyCredParams: [{ type: "public-key", alg: -7 }] } })) as PublicKeyCredential;
    return { id: c.id, clientData: new TextDecoder().decode(c.response.clientDataJSON) };
  }, [...challenge]);
  await approve(async (w) => {
    await w.getByRole("button", { name: "Save passkey" }).click();
  });
  const c = await created;
  assert.deepEqual(JSON.parse(c.clientData), { type: "webauthn.create", challenge: challenge.toString("base64url"), origin: "http://127.0.0.1:8099", crossOrigin: true, topOrigin: SITE });
  await loginPage.frameLocator("#pf").locator("#u").click();
  const got = frame().evaluate(async ({ ch, id }) => {
    const r = (await navigator.credentials.get({ publicKey: { challenge: Uint8Array.from(ch), allowCredentials: [{ type: "public-key", id: Uint8Array.fromBase64(id, { alphabet: "base64url" }) }], userVerification: "discouraged" } })) as PublicKeyCredential;
    return new TextDecoder().decode(r.response.clientDataJSON);
  }, { ch: [...challenge], id: c.id });
  await approve(async (w) => {
    await w.getByRole("listitem").filter({ hasText: "framed-user" }).click();
  });
  assert.equal(JSON.parse(await got).topOrigin, SITE);
  // Without the page's permission the browser decides (and refuses), and Warren opens nothing.
  await loginPage.goto(`${SITE}/pk-frame-denied`);
  await loginPage.waitForFunction(() => !!document.querySelector("iframe"));
  await loginPage.frameLocator("#pf").locator("#u").click();
  const opened: Page[] = [];
  const watch = (p: Page) => opened.push(p);
  ctx.on("page", watch);
  const denied = await frame().evaluate(async (ch) => {
    try {
      await navigator.credentials.create({ publicKey: { rp: { name: "Framed" }, user: { id: new Uint8Array([8]), name: "x", displayName: "x" }, challenge: Uint8Array.from(ch), pubKeyCredParams: [{ type: "public-key", alg: -7 }], timeout: 1000 } });
      return "resolved";
    } catch (e) {
      return (e as DOMException).name;
    }
  }, [...challenge]);
  ctx.off("page", watch);
  assert.notEqual(denied, "resolved");
  assert.deepEqual(opened.filter((p) => p.url().includes("popup.html?passkey=")), [], "Warren's window opened for a frame the page did not allow");
  // Clean up: the framed passkey's login.
  const s = await apiSession(vaultUser);
  const item = (await s.ciphers()).find((x) => x.login?.fido2Credentials?.[0]?.rpId === "127.0.0.1" && !x.deletedDate);
  if (item) await call(BASE, "DELETE", `/api/ciphers/${item.id}`, { token: s.token });
  s.done();
  if (page.isClosed()) await reopenPopup();
  await page.evaluate(() => chrome.runtime.sendMessage({ type: "sync", force: true }));
  await loginPage.goto(`${SITE}/login`);
});

await step("passkeys: an RP ID Warren may not use goes to the browser, with no window", async () => {
  await loginPage.locator("#u").click();
  const opened: Page[] = [];
  const watch = (p: Page) => opened.push(p);
  ctx.on("page", watch);
  const got = await loginPage.evaluate(async (ch) => {
    try {
      await navigator.credentials.get({ publicKey: { challenge: Uint8Array.from(ch), rpId: "example.com", timeout: 1000 } });
      return "resolved";
    } catch (e) {
      return (e as DOMException).name;
    }
  }, [...challenge]);
  ctx.off("page", watch);
  assert.equal(got, "SecurityError"); // the browser's own answer for another site's RP ID
  assert.deepEqual(opened.filter((p) => p.url().includes("popup.html?passkey=")), [], "Warren's window opened for an unusable RP ID");
});
