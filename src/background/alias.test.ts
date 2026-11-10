import "../shared/uint8-polyfill.ts"; // Node 24 in CI
import assert from "node:assert/strict";
import { test } from "node:test";

const local: Record<string, unknown> = {};
const enc = (s: string) => `2.${Buffer.from(s).toString("base64")}`;
const dec = (s: string) => (s.startsWith("2.") ? Buffer.from(s.slice(2), "base64").toString() : "");
const noop = async () => undefined;
(globalThis as { chrome?: unknown }).chrome = {
  i18n: { getMessage: () => "" },
  alarms: { create: noop, clear: noop },
  offscreen: { hasDocument: async () => true },
  runtime: {
    sendMessage: async ({ req }: { req: { op: string; values: string[] } }) => ({ ok: true, value: req.values.map(req.op === "encryptText" ? enc : dec) }),
  },
  storage: {
    session: { get: async () => ({}), set: noop, remove: noop, setAccessLevel: noop },
    local: {
      get: async (key: string) => ({ [key]: local[key] }),
      set: async (v: Record<string, unknown>) => void Object.assign(local, v),
      remove: noop,
      setAccessLevel: noop,
    },
  },
};

const { getAliasSettings, saveAliasSettings } = await import("./alias.ts");

test("a bad base URL is reported, but the key saved with it is kept", async () => {
  const settings = { vendor: "simplelogin" as const, token: "secret-key", baseUrl: "not a url", domain: "", prefix: false };
  await assert.rejects(saveAliasSettings(settings), /./);
  assert.equal((await getAliasSettings("simplelogin")).token, "secret-key");
});
