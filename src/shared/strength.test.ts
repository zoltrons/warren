import assert from "node:assert/strict";
import { test } from "node:test";
import { loadCommonWords, passwordLevel } from "./strength.ts";

test("short and plain is weak, long and mixed is very strong", () => {
  assert.equal(passwordLevel("password"), 0);
  assert.equal(passwordLevel("Tr0ub4dor&3"), 2);
  assert.equal(passwordLevel("correct-Horse-battery-9-staple"), 3);
  assert.equal(passwordLevel(""), 0);
});

test("a common word with digits and symbols around it is weak", () => {
  for (const pw of ["Password123!", "Qwerty123456", "iloveyou2024!"]) assert.equal(passwordLevel(pw), 0);
});

test("the loaded common-words list makes a name or club with digits weak", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(["charlie", "liverpool"]))) as typeof fetch;
  try {
    assert.equal(passwordLevel("Liverpool1!"), 2); // built-in list only: strong
    await loadCommonWords();
    for (const pw of ["Charlie99", "Liverpool1!"]) assert.equal(passwordLevel(pw), 0);
    assert.equal(passwordLevel("correct-Horse-battery-9-staple"), 3);
  } finally {
    globalThis.fetch = real;
  }
});
