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

const { handleFrame, handlePage, resumeSaves } = await import("./inline.ts");
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
