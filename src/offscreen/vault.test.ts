// Pure parts of the worker's vault (the rest needs the crypto core with a session).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { passkeyAssert, passkeyCreate, sendEdit } from "./vault.ts";

test("a send edit replaces stored fields in any casing and never sends the stored password hash back", () => {
  const stored = { Id: "s", Key: "wrapped", Name: "old", Text: { Text: "old", Hidden: false }, Password: "server-hash" };
  assert.deepEqual(sendEdit(stored, { id: "s", name: "new", text: { text: "new", hidden: true } }), {
    Key: "wrapped",
    id: "s",
    name: "new",
    text: { text: "new", hidden: true },
  });
  assert.deepEqual(sendEdit({ password: "server-hash", key: "k" }, { password: "typed" }), { key: "k", password: "typed" });
});

test("passkeys: the worker checks the RP ID against the origin before it signs or creates", async () => {
  // Needs dist/psl.json (node tools/fetch-psl.mjs), asked for next to the bundle like in the extension.
  globalThis.fetch = (async () => new Response(readFileSync(new URL("../../dist/psl.json", import.meta.url)))) as typeof fetch;
  await assert.rejects(passkeyAssert("item", "cred", "bank.test", "https://evil.test", "Y2g", false), /SecurityError/);
  const user = { id: "dQ", name: "u", displayName: "u" };
  await assert.rejects(passkeyCreate({ origin: "https://evil.test", rpId: "bank.test", rpName: "b", challenge: "Y2g", user, discoverable: true, uv: false }), /SecurityError/);
});
