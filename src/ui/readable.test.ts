import assert from "node:assert/strict";
import { test } from "node:test";
import { charKind } from "./readable.ts";

test("charKind: digits, symbols, letters of any script", () => {
  assert.deepEqual([..."a7#Ü ş"].map(charKind), ["", "d", "s", "", "", ""]);
});
