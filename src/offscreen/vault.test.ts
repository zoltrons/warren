// Pure parts of the worker's vault (the rest needs the crypto core with a session).
import assert from "node:assert/strict";
import { test } from "node:test";
import { sendEdit } from "./vault.ts";

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
