// The in-page side of the inline menu and the save bar (SECURITY.md invariants 1 and 4): the site comes from the
// browser's sender, and a frame without the per-document secret (a copy of menu.html / bar.html a page framed
// itself) can neither list nor act. Runs the real inline.ts, engine.ts (with the autofill wasm) and store.ts.
import "../shared/uint8-polyfill.ts"; // Node 24 in CI
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseFrameRequest, parsePageRequest } from "../shared/messages.ts";
import { i18n } from "./i18n-stub.test.ts";

const session: Record<string, unknown> = {};
const local: Record<string, unknown> = { account: { email: "a@b.test" } };
const area = (data: Record<string, unknown>) => ({
  get: async (key: string | null) => (key === null ? { ...data } : { [key]: data[key] }),
  set: async (values: Record<string, unknown>) => void Object.assign(data, structuredClone(values)),
  remove: async (keys: string | string[]) => {
    for (const k of [keys].flat()) delete data[k];
  },
});
const noop = async () => undefined;
let offscreen = false;
/** The worker's matchUri answer, released by the test. */
let matched: ((items: unknown[]) => void) | undefined;
const tabMessages: string[] = [];
(globalThis as { chrome?: unknown }).chrome = {
  i18n,
  storage: { session: area(session), local: area(local) },
  alarms: { create: noop, clear: noop },
  offscreen: {
    Reason: { WORKERS: "WORKERS", CLIPBOARD: "CLIPBOARD" },
    hasDocument: async () => offscreen,
    createDocument: async () => void (offscreen = true),
    closeDocument: async () => void (offscreen = false),
  },
  runtime: {
    id: "warren",
    sendMessage: async ({ req }: { req: { op: string } }) =>
      req.op === "matchUri" ? { ok: true, value: await new Promise((r) => (matched = r)) } : { ok: true, value: req.op === "vaultLoaded" ? true : req.op === "fillData" ? { password: "old" } : null },
  },
  tabs: { query: async () => [], sendMessage: async (_tab: number, m: { type: string }) => void tabMessages.push(m.type), get: async () => ({ url: "https://evil.test/" }) },
};
const wasm = new URL("../../dist/wasm/autofill_core_bg.wasm", import.meta.url);
globalThis.fetch = (async () => new Response(readFileSync(wasm), { headers: { "content-type": "application/wasm" } })) as typeof fetch;

const { handleFrame, handlePage, resumeSaves, showBar } = await import("./inline.ts");
const { lockNow } = await import("./lock.ts");

const password = { fieldId: 1, formId: 1, type: "password", htmlName: "password", isActive: true, dataAttributes: {}, blockPath: [1] };
// The page claims to be the bank; the browser says the frame is on evil.test inside a bank tab.
const focus = parsePageRequest({ type: "inlineFocus", nonce: "n1", details: { origin: "https://bank.test", forms: [{ formId: 1 }], fields: [password], buttons: [] } });
const sender = { tab: { id: 1, url: "https://bank.test/" }, frameId: 3, url: "https://evil.test/frame" } as chrome.runtime.MessageSender;

test("sender: the inline menu belongs to the frame the browser reports, not to the page's claim or the tab", async () => {
  assert.deepEqual(await handlePage(focus, sender), { kind: "login", rows: 1 }); // locked: "Unlock to fill"
  const ctx = session["inline:1"] as { url: string; frameId: number; nonce: string };
  assert.equal(ctx.url, "https://evil.test/frame");
  assert.equal(ctx.frameId, 3);
});

test("frame secret: a menu without this document's nonce cannot list", async () => {
  await assert.rejects(handleFrame(parseFrameRequest({ type: "inlineList", nonce: "guessed" }), 1), /not the one opened/);
  // The right nonce gets as far as the lock check.
  assert.deepEqual(await handleFrame(parseFrameRequest({ type: "inlineList", nonce: "n1" }), 1), { kind: "login", locked: true, items: [], passkey: false, create: false, alias: false, generate: false });
});

test("frame secret: a save bar without the token of the bar this tab was shown cannot read or save", async () => {
  session["save:1"] = { kind: "add", url: "https://bank.test/login", username: "u", password: "typed", token: "t1", expiresAt: Date.now() + 60_000 };
  await assert.rejects(handleFrame(parseFrameRequest({ type: "barInfo", token: "guessed" }), 1), /no longer active/);
  await assert.rejects(handleFrame(parseFrameRequest({ type: "barAction", token: "guessed", action: "save" }), 1), /no longer active/);
  assert.deepEqual(await handleFrame(parseFrameRequest({ type: "barInfo", token: "t1" }), 1), { kind: "add", host: "bank.test", username: "u" });
});

test("epoch: a lock while a submitted login is matched leaves no save prompt holding the typed password", async () => {
  delete session["save:1"];
  session.session = { unlocked: true };
  offscreen = true;
  const submitted = handlePage(parsePageRequest({ type: "loginSubmitted", username: "u", password: "typed" }), sender);
  for (let i = 0; i < 200 && !matched; i++) await new Promise((r) => setTimeout(r, 5));
  await lockNow();
  matched!([]);
  await submitted;
  assert.equal(session["save:1"], undefined);
  assert.ok(!tabMessages.includes("barShow"));
});

test("two-step sign-in: the username of the first page names the login the password page saves", async () => {
  delete session["save:1"];
  session.session = { unlocked: true };
  offscreen = true;
  matched = undefined;
  const page = { tab: { id: 1, url: "https://evil.test/" }, frameId: 0, url: "https://evil.test/signin" } as chrome.runtime.MessageSender;
  await handlePage(parsePageRequest({ type: "loginSubmitted", username: "ali@evil.test", password: "" }), page);
  assert.equal((session["ident:1"] as { username?: string }).username, "ali@evil.test");
  const submitted = handlePage(parsePageRequest({ type: "loginSubmitted", username: "", password: "typed" }), page);
  for (let i = 0; i < 200 && !matched; i++) await new Promise((r) => setTimeout(r, 5));
  matched!([]);
  await submitted;
  assert.deepEqual([(session["save:1"] as { kind?: string }).kind, (session["save:1"] as { username?: string }).username], ["add", "ali@evil.test"]);
});

test("locked: a submitted login waits behind an unlock prompt and is matched once the vault is open", async () => {
  delete session["save:1"];
  delete session["ident:1"];
  tabMessages.length = 0;
  session.session = { unlocked: false };
  offscreen = false;
  matched = undefined;
  const page = { tab: { id: 1, url: "https://evil.test/" }, frameId: 0, url: "https://evil.test/signin" } as chrome.runtime.MessageSender;
  await handlePage(parsePageRequest({ type: "loginSubmitted", username: "u", password: "typed" }), page);
  assert.equal((session["save:1"] as { kind?: string }).kind, "locked");
  assert.ok(tabMessages.includes("barShow"), "the bar asks for an unlock");
  session.session = { unlocked: true };
  offscreen = true;
  const resuming = resumeSaves();
  for (let i = 0; i < 200 && !matched; i++) await new Promise((r) => setTimeout(r, 5));
  matched!([]);
  await resuming;
  assert.equal((session["save:1"] as { kind?: string }).kind, "add");
});

test("logged out: a submitted login is not kept, there is nothing to unlock", async () => {
  delete session["save:1"];
  session.session = { unlocked: false };
  const account = local.account;
  delete local.account;
  const page = { tab: { id: 1, url: "https://evil.test/" }, frameId: 0, url: "https://evil.test/signin" } as chrome.runtime.MessageSender;
  await handlePage(parsePageRequest({ type: "loginSubmitted", username: "u", password: "typed" }), page);
  local.account = account;
  assert.equal(session["save:1"], undefined);
});

test("several logins, none with the typed password: the update bar offers them, and saves only one of them", async () => {
  delete session["save:1"];
  delete session["ident:1"];
  session.session = { unlocked: true };
  offscreen = true;
  matched = undefined;
  const page = { tab: { id: 1, url: "https://evil.test/" }, frameId: 0, url: "https://evil.test/change" } as chrome.runtime.MessageSender;
  const submitted = handlePage(parsePageRequest({ type: "loginSubmitted", username: "", password: "new" }), page);
  for (let i = 0; i < 200 && !matched; i++) await new Promise((r) => setTimeout(r, 5));
  matched!([
    { id: "a", type: 1, name: "site", sub: "ann", readOnly: false },
    { id: "b", type: 1, name: "site", sub: "bob", readOnly: false },
  ]);
  await submitted;
  const p = session["save:1"] as { kind: string; choices?: { id: string }[]; token: string };
  assert.deepEqual([p.kind, p.choices?.map((c) => c.id)], ["update", ["a", "b"]]);
  const info = (await handleFrame(parseFrameRequest({ type: "barInfo", token: p.token }), 1)) as { choices?: unknown[] };
  assert.equal(info.choices?.length, 2);
  await assert.rejects(handleFrame(parseFrameRequest({ type: "barAction", action: "save", token: p.token, itemId: "not-offered" }), 1), /Pick the login/);
});

test("Use a strong password: only on a registration form, filled into the menu's own frame as a password only", async () => {
  session.session = { unlocked: true };
  offscreen = true;
  const c = chrome as unknown as { runtime: { sendMessage: (m: { req: { op: string } }) => Promise<unknown> }; scripting?: unknown };
  const worker = c.runtime.sendMessage;
  c.runtime.sendMessage = async (m) => (m.req.op === "generate" ? { ok: true, value: "Gen-pw" } : m.req.op === "encryptText" ? { ok: true, value: ["2.e|e|e"] } : worker(m));
  const injected: { target: { frameIds?: number[] }; args?: unknown[] }[] = [];
  c.scripting = { executeScript: async (i: { target: { frameIds?: number[] }; args?: unknown[] }) => (injected.push(i), []) };
  try {
    session["inline:1"] = { frameId: 3, url: "https://evil.test/login", kind: "login", nonce: "g1", signup: false };
    await assert.rejects(handleFrame(parseFrameRequest({ type: "inlineGenerate", nonce: "g1" }), 1), /registration/);
    assert.equal(injected.length, 0);
    session["inline:1"] = { frameId: 3, url: "https://evil.test/signup", kind: "login", nonce: "g1", signup: true };
    await handleFrame(parseFrameRequest({ type: "inlineGenerate", nonce: "g1" }), 1);
    assert.ok(injected.length > 0 && injected.every((i) => JSON.stringify(i.target.frameIds) === "[3]"), "only the menu's frame");
    assert.equal((local.genHistory as unknown[]).length, 1, "kept in the generator history");
  } finally {
    c.runtime.sendMessage = worker;
    delete c.scripting;
  }
});

test("Use a strong password: a form's passwordrules shape the password; a rule it cannot meet falls back", async () => {
  session.session = { unlocked: true };
  offscreen = true;
  const c = chrome as unknown as { runtime: { sendMessage: (m: { req: { op: string; options?: Record<string, unknown> } }) => Promise<unknown> }; scripting?: unknown };
  const worker = c.runtime.sendMessage;
  const asked: Record<string, unknown>[] = [];
  let refuse = false;
  c.runtime.sendMessage = async (m) =>
    m.req.op === "generate"
      ? (asked.push(m.req.options!), refuse && m.req.options!.sets ? { ok: false, error: "no password meets the rule" } : { ok: true, value: "Gen-pw" })
      : m.req.op === "encryptText" ? { ok: true, value: ["2.e|e|e"] } : worker(m);
  c.scripting = { executeScript: async () => [] };
  try {
    const password = { rules: "required: digit; allowed: lower; max-consecutive: 2", maxLength: 12 };
    session["inline:1"] = { frameId: 3, url: "https://site.test/signup", kind: "login", nonce: "r1", signup: true, password };
    await handleFrame(parseFrameRequest({ type: "inlineGenerate", nonce: "r1" }), 1);
    assert.deepEqual([asked[0]?.type, asked[0]?.length, asked[0]?.maxConsecutive, (asked[0]?.sets as unknown[]).length], ["password", 12, 2, 2]);
    assert.equal(asked[0]?.minNumber, 1, "the user's minimums do not outgrow the site's maxlength");
    refuse = true;
    asked.length = 0;
    session["inline:1"] = { frameId: 3, url: "https://site.test/signup", kind: "login", nonce: "r2", signup: true, password };
    await handleFrame(parseFrameRequest({ type: "inlineGenerate", nonce: "r2" }), 1);
    assert.deepEqual(asked.map((o) => !!o.sets), [true, false], "the user's own settings after the refusal");
  } finally {
    c.runtime.sendMessage = worker;
    delete c.scripting;
  }
});

test("Use a strong password: the save bar asks at once, with the form's account name, and the submit keeps both", async () => {
  delete session["save:1"];
  delete session["ident:1"];
  session.session = { unlocked: true };
  offscreen = true;
  tabMessages.length = 0;
  matched = undefined;
  const c = chrome as unknown as { runtime: { sendMessage: (m: { req: { op: string } }) => Promise<unknown> }; scripting?: unknown };
  const worker = c.runtime.sendMessage;
  c.runtime.sendMessage = async (m) => (m.req.op === "generate" ? { ok: true, value: "Gen-pw" } : m.req.op === "encryptText" ? { ok: true, value: ["2.e|e|e"] } : worker(m));
  const field = { ...password, autoCompleteType: "new-password", visible: true, viewable: true };
  const details = { origin: "https://evil.test", forms: [{ formId: 1 }], fields: [field], buttons: [] };
  const answers: Record<string, unknown> = { collect: details, execute: { filled: true }, readFocusedLogin: { url: "https://evil.test/signup", username: "me@evil.test", password: "page's own" } };
  c.scripting = { executeScript: async (i: { args?: unknown[] }) => [{ frameId: 3, documentId: "d", result: { value: answers[i.args?.[0] as string] } }] };
  try {
    session["inline:1"] = { frameId: 3, url: "https://evil.test/signup", kind: "login", nonce: "s1", signup: true };
    const generating = handleFrame(parseFrameRequest({ type: "inlineGenerate", nonce: "s1" }), 1);
    for (let i = 0; i < 200 && !matched; i++) await new Promise((r) => setTimeout(r, 5));
    matched!([]);
    await generating;
    const p = session["save:1"] as { kind: string; username: string; password: string; generated?: boolean; expiresAt: number; token: string };
    assert.deepEqual([p.kind, p.username, p.password, p.generated], ["add", "me@evil.test", "Gen-pw", true], "Warren's password, not the field's value");
    assert.ok(p.expiresAt - Date.now() > 10 * 60_000, "kept longer than a typed one");
    assert.ok(tabMessages.includes("barShow"));
    assert.equal(((await handleFrame(parseFrameRequest({ type: "barInfo", token: p.token }), 1)) as { generated?: boolean }).generated, true);
    // The page's own submit reports no account name: the one found at generation stays, and so does the prompt.
    matched = undefined;
    const page = { tab: { id: 1, url: "https://evil.test/" }, frameId: 0, url: "https://evil.test/signup" } as chrome.runtime.MessageSender;
    const submitted = handlePage(parsePageRequest({ type: "loginSubmitted", username: "", password: "Gen-pw" }), page);
    for (let i = 0; i < 200 && !matched; i++) await new Promise((r) => setTimeout(r, 5));
    matched!([]);
    await submitted;
    const q = session["save:1"] as { username: string; generated?: boolean };
    assert.deepEqual([q.username, q.generated], ["me@evil.test", true]);
  } finally {
    c.runtime.sendMessage = worker;
    delete c.scripting;
  }
});

test("save bar: the form's other values are offered as the username, within the validator's caps", async () => {
  delete session["save:1"];
  session.session = { unlocked: true };
  offscreen = true;
  matched = undefined;
  const page = { tab: { id: 1, url: "https://evil.test/" }, frameId: 0, url: "https://evil.test/signup" } as chrome.runtime.MessageSender;
  const submitted = handlePage(parsePageRequest({ type: "loginSubmitted", username: "ali", password: "typed", usernames: ["ali@evil.test", "ali"] }), page);
  for (let i = 0; i < 200 && !matched; i++) await new Promise((r) => setTimeout(r, 5));
  matched!([]);
  await submitted;
  const p = session["save:1"] as { usernames?: string[]; token: string };
  assert.deepEqual(p.usernames, ["ali@evil.test"], "the chosen username is not offered twice");
  assert.deepEqual(((await handleFrame(parseFrameRequest({ type: "barInfo", token: p.token }), 1)) as { usernames?: string[] }).usernames, ["ali@evil.test"]);
  assert.throws(() => parsePageRequest({ type: "loginSubmitted", username: "", password: "x", usernames: ["1", "2", "3", "4", "5", "6"] }), /too many/);
});

test("save bar: a saved login without a username and this password gets the name, not a second copy", async () => {
  delete session["save:1"];
  session.session = { unlocked: true };
  offscreen = true;
  matched = undefined;
  const page = { tab: { id: 1, url: "https://evil.test/" }, frameId: 0, url: "https://evil.test/signup" } as chrome.runtime.MessageSender;
  // The worker stub answers every fillData with the password "old".
  const submitted = handlePage(parsePageRequest({ type: "loginSubmitted", username: "me@evil.test", password: "old" }), page);
  for (let i = 0; i < 200 && !matched; i++) await new Promise((r) => setTimeout(r, 5));
  matched!([{ id: "a", type: 1, name: "evil.test", sub: "", readOnly: false }]);
  await submitted;
  const p = session["save:1"] as { kind: string; itemId?: string; addUsername?: boolean; token: string };
  assert.deepEqual([p.kind, p.itemId, p.addUsername], ["update", "a", true]);
  const info = (await handleFrame(parseFrameRequest({ type: "barInfo", token: p.token }), 1)) as { addUsername?: boolean; username: string };
  assert.deepEqual([info.addUsername, info.username], [true, "me@evil.test"]);
  // Update writes the name as the user left it in the bar, with the password unchanged.
  const c = chrome as unknown as { runtime: { sendMessage: (m: { req: Record<string, unknown> }) => Promise<unknown> } };
  const worker = c.runtime.sendMessage;
  const prepared: Record<string, unknown>[] = [];
  c.runtime.sendMessage = async (m) =>
    m.req.op === "cipherSummary" ? { ok: true, value: { id: "a", type: 1, reprompt: 0 } } : m.req.op === "preparePassword" ? (prepared.push(m.req), { ok: true, value: {} }) : worker(m as never);
  try {
    // No server here: the upload fails after the item was prepared.
    await handleFrame(parseFrameRequest({ type: "barAction", action: "save", token: p.token, username: "me2@evil.test" }), 1).catch(() => undefined);
    assert.deepEqual([prepared[0]?.id, prepared[0]?.password, prepared[0]?.username], ["a", "old", "me2@evil.test"]);
  } finally {
    c.runtime.sendMessage = worker;
  }
});

test("Use a strong password: the menu shows the password it then fills, and a lock takes it away", async () => {
  delete session["save:1"];
  session.session = { unlocked: true };
  offscreen = true;
  matched = undefined;
  let n = 0;
  const c = chrome as unknown as { runtime: { sendMessage: (m: { req: { op: string } }) => Promise<unknown> }; scripting?: unknown };
  const worker = c.runtime.sendMessage;
  c.runtime.sendMessage = async (m) => (m.req.op === "generate" ? { ok: true, value: `Gen-${++n}` } : m.req.op === "encryptText" ? { ok: true, value: ["2.e|e|e"] } : worker(m));
  const filled: unknown[] = [];
  c.scripting = { executeScript: async (i: { args?: unknown[] }) => (filled.push(i.args?.[1]), []) };
  try {
    session["inline:1"] = { frameId: 3, url: "https://evil.test/signup", kind: "login", nonce: "p1", signup: true };
    const listing = handleFrame(parseFrameRequest({ type: "inlineList", nonce: "p1" }), 1);
    for (let i = 0; i < 200 && !matched; i++) await new Promise((r) => setTimeout(r, 5));
    matched!([]);
    const menu = (await listing) as { suggested?: string };
    assert.equal(menu.suggested, "Gen-1");
    await handleFrame(parseFrameRequest({ type: "inlineGenerate", nonce: "p1" }), 1);
    assert.equal((local.genHistory as unknown[]).length >= 1, true);
    assert.equal(session["suggest:1"], undefined, "used once");
    assert.equal(n, 1, "the shown password, not a new one");
    session["suggest:1"] = { nonce: "p1", password: "Gen-x" };
    await lockNow();
    assert.equal(session["suggest:1"], undefined, "a lock clears it");
  } finally {
    c.runtime.sendMessage = worker;
    delete c.scripting;
    matched = undefined;
  }
});

test("save bar: after a sign-up's redirect to another host of the same site the bar still shows; never on another site", async () => {
  const c = chrome as unknown as { runtime: { getURL?: (p: string) => string }; tabs: { get: () => Promise<{ url: string }> } };
  const realFetch = globalThis.fetch;
  const realGet = c.tabs.get;
  c.runtime.getURL = (p) => `chrome-extension://warren/${p}`;
  globalThis.fetch = (async (u: string) => (String(u).endsWith("psl.json") ? new Response(JSON.stringify(["test", "com"])) : realFetch(u))) as typeof fetch;
  try {
    for (const [tab, shown] of [["https://evil.test/welcome", true], ["https://other.test/", false], ["http://evil.test/", false]] as const) {
      tabMessages.length = 0;
      c.tabs.get = async () => ({ url: tab });
      session["save:1"] = { kind: "add", url: "https://accounts.evil.test/signup", username: "u", password: "p", token: "", expiresAt: Date.now() + 60_000 };
      await showBar(1);
      assert.equal(tabMessages.includes("barShow"), shown, tab);
    }
  } finally {
    globalThis.fetch = realFetch;
    c.tabs.get = realGet;
    delete c.runtime.getURL;
  }
});

test("Use a private username: a sign-up's username field gets one from the generator; an e-mail box no plain word", async () => {
  delete session["save:1"];
  session.session = { unlocked: true };
  offscreen = true;
  matched = undefined;
  const c = chrome as unknown as { runtime: { sendMessage: (m: { req: { op: string; options?: Record<string, unknown> } }) => Promise<unknown> }; scripting?: unknown };
  const worker = c.runtime.sendMessage;
  const asked: Record<string, unknown>[] = [];
  c.runtime.sendMessage = async (m) =>
    m.req.op === "generate" ? (asked.push(m.req.options!), { ok: true, value: m.req.options!.type === "username" ? "quiet-otter" : "Gen-pw" }) : m.req.op === "encryptText" ? { ok: true, value: ["2.e|e|e"] } : worker(m);
  c.scripting = { executeScript: async () => [] };
  const list = async (nonce: string) => {
    matched = undefined;
    const listing = handleFrame(parseFrameRequest({ type: "inlineList", nonce }), 1);
    for (let i = 0; i < 200 && !matched; i++) await new Promise((r) => setTimeout(r, 5));
    matched!([]);
    return (await listing) as { username?: string };
  };
  try {
    session["inline:1"] = { frameId: 3, url: "https://evil.test/signup", kind: "login", nonce: "u1", signup: true, account: "username" };
    assert.equal((await list("u1")).username, "quiet-otter");
    assert.deepEqual([asked.at(-1)?.type, asked.at(-1)?.usernameType], ["username", "word"]);
    await handleFrame(parseFrameRequest({ type: "inlineUsername", nonce: "u1" }), 1);
    assert.equal(asked.filter((o) => o.type === "username").length, 1, "the shown name, not a new one");
    // No generator e-mail set: a word is no address, so an e-mail box gets no row.
    session["inline:1"] = { frameId: 3, url: "https://evil.test/signup", kind: "login", nonce: "u2", signup: true, account: "email" };
    assert.equal((await list("u2")).username, undefined);
    await assert.rejects(handleFrame(parseFrameRequest({ type: "inlineUsername", nonce: "u2" }), 1), /no private username/);
    // With the generator's e-mail set, an e-mail box gets a plus address of it; an address the generator refuses, no row.
    const prefs = (email: string) => {
      local.private = "sealed";
      const generator = { options: { usernameType: "word" }, email, domain: "", wordlist: 0 };
      return JSON.stringify({ neverSave: [], blocked: [], lastUsed: {}, opened: {}, generator });
    };
    let stored = prefs("me@mail.test");
    const inner = c.runtime.sendMessage;
    c.runtime.sendMessage = async (m) => (m.req.op === "decryptText" ? { ok: true, value: [stored] } : inner(m));
    session["inline:1"] = { frameId: 3, url: "https://evil.test/signup", kind: "login", nonce: "u4", signup: true, account: "email" };
    assert.equal((await list("u4")).username, "quiet-otter");
    assert.deepEqual([asked.at(-1)?.usernameType, asked.at(-1)?.email], ["plus", "me@mail.test"]);
    stored = prefs("me@");
    assert.equal((await list("u4")).username, undefined);
    // Turned off in Settings.
    local.settings = { signupUsernames: "off" };
    session["inline:1"] = { frameId: 3, url: "https://evil.test/signup", kind: "login", nonce: "u3", signup: true, account: "username" };
    assert.equal((await list("u3")).username, undefined);
  } finally {
    delete local.private; // a failed assert above must not leave later tests an undecryptable record
    delete local.settings;
    c.runtime.sendMessage = worker;
    delete c.scripting;
    matched = undefined;
  }
});

test("Use a strong password on a login that exists: the update waits for the submit, it never shows before the site took it", async () => {
  delete session["save:1"];
  delete session["ident:1"];
  session.session = { unlocked: true };
  offscreen = true;
  matched = undefined;
  const c = chrome as unknown as { runtime: { sendMessage: (m: { req: { op: string } }) => Promise<unknown> }; scripting?: unknown };
  const worker = c.runtime.sendMessage;
  c.runtime.sendMessage = async (m) => (m.req.op === "generate" ? { ok: true, value: "Gen-pw" } : m.req.op === "encryptText" ? { ok: true, value: ["2.e|e|e"] } : worker(m));
  const field = { ...password, autoCompleteType: "new-password", visible: true, viewable: true };
  const answers: Record<string, unknown> = { collect: { origin: "https://evil.test", forms: [{ formId: 1 }], fields: [field], buttons: [] }, execute: { filled: true }, readFocusedLogin: { url: "https://evil.test/change", username: "me@evil.test", password: "x" } };
  c.scripting = { executeScript: async (i: { args?: unknown[] }) => [{ frameId: 3, documentId: "d", result: { value: answers[i.args?.[0] as string] } }] };
  const saved = [{ id: "a", type: 1, name: "evil.test", sub: "me@evil.test", readOnly: false }];
  try {
    session["inline:1"] = { frameId: 3, url: "https://evil.test/change", kind: "login", nonce: "w1", signup: true };
    tabMessages.length = 0;
    const generating = handleFrame(parseFrameRequest({ type: "inlineGenerate", nonce: "w1" }), 1);
    for (let i = 0; i < 200 && !matched; i++) await new Promise((r) => setTimeout(r, 5));
    matched!(saved);
    await generating;
    assert.deepEqual([(session["save:1"] as { kind: string }).kind, tabMessages.includes("barShow")], ["update", false]);
    // Leaving the page without submitting: the next page load shows nothing either.
    await showBar(1);
    assert.equal(tabMessages.includes("barShow"), false, "a page load showed a password the site never took");
    // The site's submit (or its next page) asks.
    matched = undefined;
    const page = { tab: { id: 1, url: "https://evil.test/" }, frameId: 0, url: "https://evil.test/change" } as chrome.runtime.MessageSender;
    const submitted = handlePage(parsePageRequest({ type: "loginSubmitted", username: "me@evil.test", password: "Gen-pw" }), page);
    for (let i = 0; i < 200 && !matched; i++) await new Promise((r) => setTimeout(r, 5));
    matched!(saved);
    await submitted;
    assert.ok(tabMessages.includes("barShow"));
  } finally {
    c.runtime.sendMessage = worker;
    delete c.scripting;
    matched = undefined;
  }
});

test("Use a strong password: a sign-up whose account box is still empty asks to add, even beside the site's saved logins", async () => {
  delete session["save:1"];
  delete session["ident:1"];
  session.session = { unlocked: true };
  offscreen = true;
  matched = undefined;
  const c = chrome as unknown as { runtime: { sendMessage: (m: { req: { op: string } }) => Promise<unknown> }; scripting?: unknown };
  const worker = c.runtime.sendMessage;
  c.runtime.sendMessage = async (m) => (m.req.op === "generate" ? { ok: true, value: "Gen-pw" } : m.req.op === "encryptText" ? { ok: true, value: ["2.e|e|e"] } : worker(m));
  const field = { ...password, autoCompleteType: "new-password", visible: true, viewable: true };
  const read = { url: "https://evil.test/signup", username: "", password: "x", accountBox: true };
  const answers: Record<string, unknown> = { collect: { origin: "https://evil.test", forms: [{ formId: 1 }], fields: [field], buttons: [] }, execute: { filled: true }, readFocusedLogin: read };
  c.scripting = { executeScript: async (i: { args?: unknown[] }) => [{ frameId: 3, documentId: "d", result: { value: answers[i.args?.[0] as string] } }] };
  const saved = [
    { id: "a", type: 1, name: "evil.test", sub: "work@evil.test", readOnly: false },
    { id: "b", type: 1, name: "evil.test", sub: "old@evil.test", readOnly: false },
  ];
  const generate = async (nonce: string) => {
    session["inline:1"] = { frameId: 3, url: "https://evil.test/signup", kind: "login", nonce, signup: true };
    tabMessages.length = 0;
    matched = undefined;
    const generating = handleFrame(parseFrameRequest({ type: "inlineGenerate", nonce }), 1);
    for (let i = 0; i < 200 && !matched; i++) await new Promise((r) => setTimeout(r, 5));
    matched!(saved);
    await generating;
    return session["save:1"] as { kind: string; untilSubmit?: boolean };
  };
  try {
    const p = await generate("e1");
    assert.deepEqual([p.kind, p.untilSubmit, tabMessages.includes("barShow")], ["add", undefined, true]);
    // A password reset (no account box): which login changed is unknown, so it waits for the submit.
    read.accountBox = false;
    const q = await generate("e2");
    assert.deepEqual([q.kind, q.untilSubmit, tabMessages.includes("barShow")], ["update", true, false]);
  } finally {
    c.runtime.sendMessage = worker;
    delete c.scripting;
    matched = undefined;
  }
});
