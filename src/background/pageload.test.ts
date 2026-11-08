// Page-load autofill: what reaches a frame without a user gesture.
import "../shared/uint8-polyfill.ts"; // Node 24 in CI
import assert from "node:assert/strict";
import { test } from "node:test";

const local: Record<string, unknown> = { settings: { autofillOnPageLoad: true } };
const area = (data: Record<string, unknown>) => ({
  get: async (key: string | null) => (key === null ? { ...data } : { [key]: data[key] }),
  set: async (values: Record<string, unknown>) => void Object.assign(data, structuredClone(values)),
  remove: async () => undefined,
});
const noop = async () => undefined;
(globalThis as { chrome?: unknown }).chrome = {
  storage: { session: area({}), local: area(local) },
  alarms: { create: noop, clear: noop },
  runtime: { id: "warren" },
};

const { pageLoadFill } = await import("./autofill.ts");

test("page-load fill refuses a frame of another origin than the tab", async () => {
  const frame = (top: string) => ({ tab: { id: 1, url: top }, frameId: 3, url: "https://victim.test/login" }) as chrome.runtime.MessageSender;
  assert.deepEqual(await pageLoadFill(frame("https://attacker.test/")), { filled: false, reason: "noMatch" });
  // Control: the same origin gets past the frame check (and stops at the locked vault).
  assert.deepEqual(await pageLoadFill(frame("https://victim.test/")), { filled: false, reason: "locked" });
});
