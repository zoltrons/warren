import assert from "node:assert/strict";
import { test } from "node:test";
import { charKind, groupsOf } from "./readable.ts";

test("charKind: digits, symbols, letters of any script", () => {
  assert.deepEqual([..."a7#Ü ş"].map(charKind), ["", "d", "s", "", "", ""]);
});

test("groupsOf: random strings in fours, joined back to the same value", () => {
  assert.deepEqual(groupsOf("k7#Vm2qT!pR9zLd4Xw8b"), ["k7#V", "m2qT", "!pR9", "zLd4", "Xw8b"]);
  assert.deepEqual(groupsOf("12345678"), ["1234", "5678"]);
  assert.deepEqual(groupsOf("😀bc😀efgh9"), ["😀bc😀", "efgh", "9"]); // whole code points, not UTF-16 halves
});

test("groupsOf: short values and values with their own breaks stay whole", () => {
  for (const v of ["abc1234", "gh-secret-1", "Correct.Horse.Battery", "two words here", "4111 1111 1111 1111"]) assert.deepEqual(groupsOf(v), [v]);
});
