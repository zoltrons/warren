import assert from "node:assert/strict";
import { test } from "node:test";
import { isPadded, pad, unpad } from "./seal.ts";

const bytes = (s: string) => new TextEncoder().encode(s).length;

test("padding hides the length and round-trips", () => {
  for (const v of ["1234", "123456", "k7#Vm2qT!pR9zLd4Xw8b", "şifre-çok-gizli ✓ 🔑", ""]) {
    const p = pad(v, 512);
    assert.equal(bytes(p), 512); // the same size whatever the value, also for multi-byte characters
    assert.equal(unpad(p), v);
    assert.ok(isPadded(p));
  }
  assert.equal(bytes(pad("x".repeat(600), 512)), 1024);
});

test("values written before padding read back unchanged", () => {
  assert.equal(unpad("old-password  "), "old-password  ");
  assert.equal(unpad("123"), "123");
  assert.equal(isPadded("123"), false);
});
