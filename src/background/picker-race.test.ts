// "Pick from page" against a lock (SECURITY.md invariant 8b): a lock while the picker starts or a pick comes back
// leaves no picker and no picked field behind. Runs the real picker.ts, engine.ts (with the autofill wasm), lock.ts
// and store.ts against a scripted browser whose slow steps the test releases by hand.
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

/** The step the test holds: the worker's stashDraft, or the autofill wasm download. */
let release: (() => void) | undefined;
const held = () => new Promise<void>((r) => (release = r));
const ops: string[] = [];
let offscreen = true;
const noop = async () => undefined;
(globalThis as { chrome?: unknown }).chrome = {
  storage: { session: area(session), local: area({}) },
  alarms: { create: noop, clear: noop },
  i18n: { getMessage: () => "" },
  action: { openPopup: noop },
  tabs: { query: async () => [{ id: 1, url: "https://a.test/" }], sendMessage: noop },
  offscreen: {
    Reason: { WORKERS: "WORKERS", CLIPBOARD: "CLIPBOARD" },
    hasDocument: async () => offscreen,
    createDocument: async () => void (offscreen = true),
    closeDocument: async () => void (offscreen = false),
  },
  runtime: {
    id: "warren",
    sendMessage: async (m: { req?: { op: string } }) => {
      if (m.req) ops.push(m.req.op);
      if (m.req?.op === "stashDraft") await held();
      return { ok: true, value: null };
    },
  },
};
const wasm = new URL("../../dist/wasm/autofill_core_bg.wasm", import.meta.url);
globalThis.fetch = (async () => {
  await held();
  return new Response(readFileSync(wasm), { headers: { "content-type": "application/wasm" } });
}) as typeof fetch;

const { finishFieldPicker, startFieldPicker } = await import("./picker.ts");
const { lockNow } = await import("./lock.ts");

const picker = () => (session.session as { picker?: unknown } | undefined)?.picker;
async function until(ready: () => boolean) {
  for (let i = 0; i < 200 && !ready(); i++) await new Promise((r) => setTimeout(r, 5));
  assert.ok(ready(), "the held step never started");
}

test("a lock while the draft goes to the worker: no picker is left running for it", async () => {
  const starting = startFieldPicker("draft", false);
  await until(() => ops.includes("stashDraft"));
  await lockNow();
  release!();
  await assert.rejects(starting, /locked meanwhile/);
  assert.equal(picker(), undefined);
});

test("a lock while the pick is analyzed: no picked field is stored for the popup", async () => {
  session.session = { unlocked: true, picker: { tabId: 1, panel: false } };
  release = undefined;
  const field = { fieldId: 1, formId: 1, type: "text", htmlName: "user", isActive: true, dataAttributes: {}, blockPath: [1] };
  const details = { origin: "https://a.test", forms: [{ formId: 1 }], fields: [field], buttons: [] };
  const finishing = finishFieldPicker(1, { name: "user", fieldType: "text", details } as Parameters<typeof finishFieldPicker>[1]);
  await until(() => !!release); // the engine is being downloaded
  await lockNow();
  release!();
  await finishing;
  assert.equal(picker(), undefined);
});
