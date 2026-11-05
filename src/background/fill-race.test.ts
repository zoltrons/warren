// A lock that comes while a fill or a save bar is under way: no frame gets a value, no typed password comes back.
// Runs the real engine.ts (with the autofill wasm), inline.ts, lock.ts and store.ts against a scripted browser.
import "../shared/uint8-polyfill.ts"; // Node 24 in CI
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const session: Record<string, unknown> = {};
const area = (data: Record<string, unknown>) => ({
  get: async (key: string | null) => (key === null ? { ...data } : { [key]: data[key] }),
  set: async (values: Record<string, unknown>) => void Object.assign(data, structuredClone(values)),
  remove: async (keys: string | string[]) => {
    for (const k of [keys].flat()) delete data[k];
  },
});

/** Each page call waits until the test releases it; `calls` records what reached a frame. */
const calls: string[] = [];
let release: (() => void) | undefined;
const held = () => new Promise<void>((r) => (release = r));
const tabMessages: string[] = [];
const noop = async () => undefined;
(globalThis as { chrome?: unknown }).chrome = {
  storage: { session: area(session), local: area({}) },
  alarms: { create: noop, clear: noop },
  offscreen: { hasDocument: async () => false },
  tabs: {
    query: async () => [],
    get: async () => (await held(), { url: "https://a.test/after-login" }),
    sendMessage: async (_tab: number, msg: { type: string }) => void tabMessages.push(msg.type),
  },
  scripting: {
    executeScript: async ({ args }: { args: [string, unknown] }) => {
      const [name] = args;
      calls.push(name);
      if (name !== "collect") return [{ frameId: 0, documentId: "d", result: { value: { filled: true } } }];
      await held();
      const field = (fieldId: number, type: string) => ({ fieldId, formId: 1, type, htmlName: type === "password" ? "password" : "username", dataAttributes: {}, blockPath: [1] });
      return [{ frameId: 0, documentId: "d", result: { value: { origin: "https://a.test", forms: [{ formId: 1 }], fields: [field(1, "text"), field(2, "password")], buttons: [] } } }];
    },
  },
};
// The autofill wasm (needs `npm run build:wasm`), asked for next to the bundle like in the extension.
const wasm = new URL("../../dist/wasm/autofill_core_bg.wasm", import.meta.url);
globalThis.fetch = (async () => new Response(readFileSync(wasm), { headers: { "content-type": "application/wasm" } })) as typeof fetch;

const { fillInFrames } = await import("./engine.ts");
const { showBar } = await import("./inline.ts");
const { lockEpoch, lockNow } = await import("./lock.ts");

test("a lock while the page is collected stops the values before any frame gets them", async () => {
  const req = { mode: "login", origin: "https://a.test", username: "u", password: "secret", epoch: lockEpoch() } as const;
  const filling = fillInFrames(1, { frameIds: [0] }, req);
  await new Promise((r) => setTimeout(r, 10));
  await lockNow();
  release!();
  await assert.rejects(filling, /locked meanwhile/);
  assert.deepEqual(calls, ["collect"], "execute never went out");
});

test("a fill nothing interrupts reaches the frame", async () => {
  calls.length = 0;
  const filling = fillInFrames(1, { frameIds: [0] }, { mode: "login", origin: "https://a.test", username: "u", password: "secret", epoch: lockEpoch() });
  await new Promise((r) => setTimeout(r, 10));
  release!();
  assert.equal((await filling)[0]?.result.filled, true);
  assert.deepEqual(calls, ["collect", "execute"]);
});

test("a lock while the save bar looks at the tab does not bring the typed password back", async () => {
  session["save:1"] = { kind: "add", url: "https://a.test/login", username: "u", password: "typed", token: "", expiresAt: Date.now() + 60_000 };
  const showing = showBar(1);
  await new Promise((r) => setTimeout(r, 10));
  await lockNow(); // clears every pending save
  release!();
  await showing;
  assert.equal(session["save:1"], undefined);
  assert.ok(!tabMessages.includes("barShow"));
});
