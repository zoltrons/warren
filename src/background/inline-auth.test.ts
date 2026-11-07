// The in-page side of the inline menu and the save bar (SECURITY.md invariants 1 and 4): the site comes from the
// browser's sender, and a frame without the per-document secret (a copy of menu.html / bar.html a page framed
// itself) can neither list nor act. Runs the real inline.ts, engine.ts (with the autofill wasm) and store.ts.
import "../shared/uint8-polyfill.ts"; // Node 24 in CI
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parseFrameRequest, parsePageRequest } from "../shared/messages.ts";

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
      req.op === "matchUri" ? { ok: true, value: await new Promise((r) => (matched = r)) } : { ok: true, value: req.op === "vaultLoaded" ? true : null },
  },
  tabs: { query: async () => [], sendMessage: async (_tab: number, m: { type: string }) => void tabMessages.push(m.type), get: async () => ({ url: "https://evil.test/" }) },
};
const wasm = new URL("../../dist/wasm/autofill_core_bg.wasm", import.meta.url);
globalThis.fetch = (async () => new Response(readFileSync(wasm), { headers: { "content-type": "application/wasm" } })) as typeof fetch;

const { handleFrame, handlePage } = await import("./inline.ts");
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
  assert.deepEqual(await handleFrame(parseFrameRequest({ type: "inlineList", nonce: "n1" }), 1), { kind: "login", locked: true, items: [], passkey: false, create: false });
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
