// Page-load autofill and a page that never answers: what reaches a frame without a user gesture.
import "../shared/uint8-polyfill.ts"; // Node 24 in CI
import assert from "node:assert/strict";
import { test } from "node:test";

const local: Record<string, unknown> = { settings: { autofillOnPageLoad: true } };
const area = (data: Record<string, unknown>) => ({
  get: async (key: string | null) => (key === null ? { ...data } : { [key]: data[key] }),
  set: async (values: Record<string, unknown>) => void Object.assign(data, structuredClone(values)),
  remove: async () => undefined,
});
const session: Record<string, unknown> = {};
const noop = async () => undefined;
/** The tab resumeFill finds, and whether a fill began (it asks for the crypto document first). */
let tab: { id: number; url: string; active: boolean } | undefined;
let fillBegan = false;
(globalThis as { chrome?: unknown }).chrome = {
  storage: { session: area(session), local: area(local) },
  alarms: { create: noop, clear: noop },
  runtime: { id: "warren" },
  tabs: { get: async () => tab },
  offscreen: { hasDocument: async () => ((fillBegan = true), false), createDocument: async () => { throw new Error("no worker in this test"); } },
};

const { pageLoadFill, resumeFill } = await import("./autofill.ts");
const { pageDeadline } = await import("./engine.ts");

test("page-load fill refuses a frame of another origin than the tab", async () => {
  const frame = (top: string) => ({ tab: { id: 1, url: top }, frameId: 3, url: "https://victim.test/login" }) as chrome.runtime.MessageSender;
  assert.deepEqual(await pageLoadFill(frame("https://attacker.test/")), { filled: false, reason: "noMatch" });
  // Control: the same origin gets past the frame check (and stops at the locked vault).
  assert.deepEqual(await pageLoadFill(frame("https://victim.test/")), { filled: false, reason: "locked" });
});

test("page-load fill refuses a prerendered document", async () => {
  const sender = (documentLifecycle: string) => ({ tab: { id: 1, url: "https://victim.test/" }, frameId: 0, url: "https://victim.test/login", documentLifecycle }) as chrome.runtime.MessageSender;
  assert.deepEqual(await pageLoadFill(sender("prerender")), { filled: false, reason: "noFields" });
  assert.deepEqual(await pageLoadFill(sender("active")), { filled: false, reason: "locked" });
});

test("a page call that never settles gives up", async () => {
  await assert.rejects(pageDeadline(new Promise(() => undefined), 10), /did not answer/);
  assert.equal(await pageDeadline(Promise.resolve(1), 10), 1);
});

test("a fill asked for while locked runs after the unlock only in that tab, still active, on that site, within 2 minutes", async () => {
  const run = async (resume: Record<string, unknown>, shown: typeof tab) => {
    session.session = { unlocked: true, resume };
    tab = shown;
    fillBegan = false;
    await resumeFill();
    assert.equal((session.session as { resume?: unknown }).resume, undefined, "used once");
    return fillBegan;
  };
  const now = { tabId: 1, origin: "https://bank.test", at: Date.now() };
  assert.equal(await run(now, { id: 1, url: "https://evil.test/", active: true }), false, "the tab moved to another site");
  assert.equal(await run(now, { id: 1, url: "https://bank.test/login", active: false }), false, "the user left the tab");
  assert.equal(await run({ ...now, at: Date.now() - 3 * 60_000 }, { id: 1, url: "https://bank.test/login", active: true }), false, "too late");
  assert.equal(await run(now, { id: 1, url: "https://bank.test/login", active: true }), true, "control: the fill begins");
});
