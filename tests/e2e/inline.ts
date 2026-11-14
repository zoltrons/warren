// e2e group "inline": inline menu, save bar, card and identity fill.
// Runs alone with --only inline (run.ts), together with the groups it imports.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { type Page } from "playwright-core";
import { BASE, step, poll, apiSession, SITE, ctx, sw, page, fill, unlockIfLocked, rows } from "./harness.ts";
import { vaultUser } from "./vault.ts";
import { loginPage, reopenPopup, fieldValues } from "./autofill.ts";

// Menu and bar are extension iframes inside a closed shadow root; Playwright still lists their frames.
export const frameOf = async (p: Page, file: string) => {
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
export const values = (p: Page | import("playwright-core").Frame, ids: string[]) =>
  p.evaluate((ids) => ids.map((id) => (document.getElementById(id) as HTMLInputElement).value), ids);

await step("inline menu: focusing the username lists site matches; picking one fills", async () => {
  await unlockIfLocked();
  await loginPage.goto(`${SITE}/login`);
  await loginPage.click("#u");
  const menu = await frameOf(loginPage, "menu.html");
  await menu.getByRole("option", { name: /, Local app$/ }).click();
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
  // The menu gives its first row focus whenever its frame gets focus (menu.ts). The page must not be able to give
  // it that focus and put a row under the user's Enter: the closed shadow root keeps the frame out of window.frames.
  assert.equal(await loginPage.evaluate(() => frames.length), 0, "the page can reach the menu's frame");
  await loginPage.keyboard.press("ArrowDown");
  await menu.waitForFunction(() => document.activeElement?.getAttribute("aria-label")?.endsWith(", Local app"));
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
  await (await frameOf(loginPage, "menu.html")).getByRole("option", { name: /, Local app$/ }).click();
  await loginPage.waitForFunction(() => (document.getElementById("host")!.shadowRoot!.getElementById("p") as HTMLInputElement).value !== "");
  await loginPage.goto(`${SITE}/framed`);
  const inner = loginPage.frameLocator("#f");
  await inner.locator("#u").click();
  await (await frameOf(loginPage, "menu.html")).getByRole("option", { name: /, Local app$/ }).click();
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
  await (await frameOf(loginPage, "menu.html")).getByRole("option", { name: /^Visa/ }).click();
  await loginPage.waitForFunction(() => (document.getElementById("cc") as HTMLInputElement).value !== "");
  assert.deepEqual(await values(loginPage, ["cn", "cc", "m", "y", "cvc"]), ["Ada L", "4111111111111111", "01", "2030", "123"]);
});

await step("inline menu: a field in a tiny iframe gets its menu drawn by the top page, and the pick fills it", async () => {
  await loginPage.goto(`${SITE}/tiny-frame`);
  await loginPage.frameLocator("#f").locator("#cc").click();
  const option = (await frameOf(loginPage, "menu.html")).getByRole("option", { name: /^Visa/ });
  await option.waitFor();
  assert.equal(await loginPage.locator("warren-menu").count(), 1, "the top page drew no menu");
  const box = await loginPage.evaluate(() => [document.getElementById("f")!.getBoundingClientRect().bottom, document.querySelector("warren-menu")!.getBoundingClientRect().top]);
  assert.ok(box[1]! >= box[0]! - 44 && box[1]! <= box[0]! + 8, `menu not under the frame's field: ${JSON.stringify(box)}`);
  await option.click();
  const f = loginPage.frames().find((x) => x.url().endsWith("/card-number"))!;
  await f.waitForFunction(() => (document.getElementById("cc") as HTMLInputElement).value !== "");
  assert.equal((await values(f, ["cc"]))[0], "4111111111111111");
  await loginPage.waitForTimeout(300);
  assert.equal(await loginPage.locator("warren-menu").count(), 0, "the top page's menu stayed after the fill");
});

await step("inline menu: a card form split over one frame per field is filled by one pick", async () => {
  await loginPage.goto(`${SITE}/split-card`);
  await loginPage.frameLocator("#number").locator("#cc").click();
  await (await frameOf(loginPage, "menu.html")).getByRole("option", { name: /^Visa/ }).click();
  const frame = (path: string) => loginPage.frames().find((x) => x.url().endsWith(path))!;
  await frame("/card-cvc").waitForFunction(() => (document.getElementById("cvc") as HTMLInputElement).value !== "");
  assert.deepEqual([(await values(frame("/card-number"), ["cc"]))[0], (await values(frame("/card-exp"), ["exp"]))[0], (await values(frame("/card-cvc"), ["cvc"]))[0]], ["4111111111111111", "01/30", "123"]);
});

await step("inline menu: identity fields list identities and fill name, e-mail, phone and address", async () => {
  await reopenPopup();
  await page.getByRole("button", { name: "New item" }).click();
  await page.getByRole("button", { name: "Identity", exact: true }).click();
  await fill("Name", "My identity");
  await fill("First name", "Ada");
  await fill("Last name", "Lovelace");
  await fill("Email", "ada@example.test");
  await fill("Phone", "5551234");
  await fill("Address 1", "12 Analytical St");
  await fill("City / Town", "London");
  await fill("Postal code", "N1 9GU");
  await page.getByRole("button", { name: "Save" }).click();
  await rows().filter({ hasText: "My identity" }).first().waitFor(); // also listed under Identities for the open site
  await loginPage.goto(`${SITE}/identity`);
  await loginPage.click("#fn");
  await (await frameOf(loginPage, "menu.html")).getByRole("option", { name: /^My identity/ }).click();
  await loginPage.waitForFunction(() => (document.getElementById("fn") as HTMLInputElement).value !== "");
  assert.deepEqual(await values(loginPage, ["fn", "ln", "em", "ph", "ad", "ci", "zi"]), ["Ada", "Lovelace", "ada@example.test", "5551234", "12 Analytical St", "London", "N1 9GU"]);
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
  await menu.getByRole("option", { name: "Create account" }).click();
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
  await menu.getByRole("option", { name: /, Local app$/ }).waitFor();
  assert.equal(await menu.getByRole("option", { name: "Create account" }).count(), 0);
  await loginPage.goto(`${SITE}/register`);
  await loginPage.click("#u");
  await (await frameOf(loginPage, "menu.html")).getByRole("option", { name: "Create account" }).waitFor();
});

await step("inline menu: a registration form offers a new e-mail alias once a service is set up, and fills it", async () => {
  // Without a service the row is not there (an earlier step set a key: clear it first).
  await page.evaluate(() => chrome.runtime.sendMessage({ type: "setAliasSettings", settings: { vendor: "simplelogin", token: "", baseUrl: "", domain: "", prefix: false } }));
  await loginPage.bringToFront();
  await loginPage.goto(`${SITE}/register`);
  await loginPage.click("#u");
  const before = await frameOf(loginPage, "menu.html");
  await before.getByRole("option", { name: "Create account" }).waitFor();
  assert.equal(await before.getByRole("option", { name: "New e-mail alias" }).count(), 0);
  // A SimpleLogin that lives on this machine: what the extension sends, and what it answers.
  const seen: { url: string; key: string | undefined }[] = [];
  const stub = createServer((req, res) => {
    seen.push({ url: req.url ?? "", key: req.headers.authentication as string | undefined });
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ alias: "fresh.alias@sl.example" }));
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
  try {
    await page.evaluate((b) => chrome.runtime.sendMessage({ type: "setAliasSettings", settings: { vendor: "simplelogin", token: "sl-inline-key", baseUrl: b, domain: "", prefix: false } }), base);
    await loginPage.goto(`${SITE}/register`);
    await loginPage.click("#u");
    await (await frameOf(loginPage, "menu.html")).getByRole("option", { name: "New e-mail alias" }).click();
    await loginPage.waitForFunction(() => (document.getElementById("u") as HTMLInputElement).value !== "");
    assert.equal(await loginPage.inputValue("#u"), "fresh.alias@sl.example");
    assert.equal(seen.length, 1);
    assert.match(seen[0]!.url, /^\/api\/alias\/random\/new\?hostname=localhost$/);
    assert.equal(seen[0]!.key, "sl-inline-key");
  } finally {
    stub.close();
    await page.evaluate(() => chrome.runtime.sendMessage({ type: "setAliasSettings", settings: { vendor: "simplelogin", token: "", baseUrl: "", domain: "", prefix: false } }));
  }
});

await step("inline menu: it opens right under its field, also on a page taller than the window", async () => {
  await loginPage.bringToFront();
  await loginPage.goto(`${SITE}/login`);
  await loginPage.evaluate(() => { document.body.style.minHeight = "3000px"; });
  await loginPage.click("#u");
  await (await frameOf(loginPage, "menu.html")).getByRole("option", { name: /, Local app$/ }).waitFor();
  const [field, menu] = await loginPage.evaluate(() => ["#u", "warren-menu"].map((s) => { const r = document.querySelector(s)!.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left }; }));
  assert.ok(Math.abs(menu!.top - field!.bottom - 4) < 1, JSON.stringify({ field, menu }));
  assert.ok(Math.abs(menu!.left - field!.left) < 1, JSON.stringify({ field, menu }));
  await loginPage.keyboard.press("Escape");
});

await step("inline menu: a login inside a modal dialog gets a menu above it that takes the click", async () => {
  await loginPage.bringToFront();
  await loginPage.goto(`${SITE}/modal`);
  await loginPage.click("#u");
  const option = (await frameOf(loginPage, "menu.html")).getByRole("option", { name: /, Local app$/ });
  await option.waitFor();
  assert.equal(await loginPage.evaluate(() => !!document.querySelector("dialog warren-menu:popover-open")), true, "menu not in the dialog's top layer");
  await option.click();
  await loginPage.waitForFunction(() => (document.getElementById("p") as HTMLInputElement).value !== "");
});

await step("inline menu: a focus-trapping modal keeps the menu usable from the keyboard", async () => {
  await loginPage.goto(`${SITE}/trap`);
  await loginPage.click("#u");
  await (await frameOf(loginPage, "menu.html")).getByRole("option", { name: /, Local app$/ }).waitFor();
  assert.equal(await loginPage.evaluate(() => !!document.querySelector("#m warren-menu")), true, "menu outside the modal");
  await loginPage.keyboard.press("ArrowDown");
  await loginPage.keyboard.press("Enter");
  await loginPage.waitForFunction(() => (document.getElementById("p") as HTMLInputElement).value !== "");
});

await step("inline menu: at the bottom of the window it opens above its field, and follows a layout shift", async () => {
  await loginPage.goto(`${SITE}/bottom`);
  await loginPage.click("#u");
  await (await frameOf(loginPage, "menu.html")).getByRole("option", { name: /, Local app$/ }).waitFor();
  const boxes = () => loginPage.evaluate(() => ["#u", "warren-menu"].map((s) => { const r = document.querySelector(s)!.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, right: r.right }; }));
  let [field, menu] = await boxes();
  assert.ok(Math.abs(menu!.bottom - (field!.top - 4)) < 1, JSON.stringify({ field, menu }));
  assert.ok(menu!.right <= (await loginPage.evaluate(() => innerWidth)), "menu past the right edge");
  // Content above the form shrinks: the field moves up, no scroll event, and the menu goes with it.
  await loginPage.evaluate(() => { (document.body.firstElementChild as HTMLElement).style.height = "200px"; });
  await loginPage.waitForTimeout(200);
  [field, menu] = await boxes();
  assert.ok(Math.abs(menu!.top - (field!.bottom + 4)) < 1, `after the shift: ${JSON.stringify({ field, menu })}`);
  await loginPage.keyboard.press("Escape");
});

await step("inline menu: a login inside a closed shadow root gets the menu and fills", async () => {
  await loginPage.goto(`${SITE}/closed-shadow`);
  const r = await loginPage.evaluate(() => { const b = (window as unknown as { root: ShadowRoot }).root.getElementById("u")!.getBoundingClientRect(); return { x: b.left + 5, y: b.top + b.height / 2 }; });
  await loginPage.mouse.click(r.x, r.y);
  await (await frameOf(loginPage, "menu.html")).getByRole("option", { name: /, Local app$/ }).click();
  await loginPage.waitForFunction(() => ((window as unknown as { root: ShadowRoot }).root.getElementById("p") as HTMLInputElement).value !== "");
  assert.equal(await loginPage.evaluate(() => ((window as unknown as { root: ShadowRoot }).root.getElementById("u") as HTMLInputElement).value), "local-user");
});

await step("inline menu: a page that removes the menu does not leave its field without one", async () => {
  await loginPage.goto(`${SITE}/login`);
  await loginPage.click("#u");
  await (await frameOf(loginPage, "menu.html")).getByRole("option", { name: /, Local app$/ }).waitFor();
  await loginPage.evaluate(() => document.querySelector("warren-menu")!.remove());
  await loginPage.click("#u");
  await loginPage.waitForFunction(() => !!document.querySelector("warren-menu"));
  await (await frameOf(loginPage, "menu.html")).getByRole("option", { name: /, Local app$/ }).click();
  await loginPage.waitForFunction(() => (document.getElementById("p") as HTMLInputElement).value !== "");
});

await step("inline menu: a login with each input in its own shadow root gets the menu and fills", async () => {
  await loginPage.bringToFront();
  await loginPage.goto(`${SITE}/split-shadow`);
  await loginPage.click("#u");
  await (await frameOf(loginPage, "menu.html")).getByRole("option", { name: /, Local app$/ }).click();
  await loginPage.waitForFunction(() => document.querySelector("x-b")!.shadowRoot!.querySelector("input")!.value !== "");
  assert.equal(await loginPage.evaluate(() => document.querySelector("x-a")!.shadowRoot!.querySelector("input")!.value), "local-user");
});

export const setSetting = (patch: Record<string, unknown>) => page.evaluate((m) => chrome.runtime.sendMessage(m), { type: "setSettings", ...patch });

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
  await (await frameOf(loginPage, "menu.html")).getByRole("option", { name: /, Local app$/ }).click();
  await loginPage.waitForFunction(() => /^\d{6}$/.test((document.getElementById("code") as HTMLInputElement).value));
});

await step("autosubmit: off by default, and with the setting a fill presses the login button", async () => {
  await loginPage.goto(`${SITE}/autosubmit`);
  await loginPage.click("#u");
  await (await frameOf(loginPage, "menu.html")).getByRole("option", { name: /, Local app$/ }).click();
  await loginPage.waitForFunction(() => (document.getElementById("p") as HTMLInputElement).value !== "");
  assert.equal(await loginPage.evaluate(() => (window as unknown as { submitted?: boolean }).submitted ?? false), false);
  await setSetting({ autosubmit: true });
  try {
    await loginPage.goto(`${SITE}/autosubmit`);
    await loginPage.click("#u");
    await (await frameOf(loginPage, "menu.html")).getByRole("option", { name: /, Local app$/ }).click();
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
