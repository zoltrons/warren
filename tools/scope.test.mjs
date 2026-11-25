import assert from "node:assert/strict";
import { test } from "node:test";
import { scope } from "./scope.mjs";

const none = { rust: false, ext: false, e2e: false };
const every = { rust: true, ext: true, e2e: true };

test("docs, site and non-ci workflows need no build or test", () => {
  assert.deepEqual(scope(["README.md", "docs/SECURITY.md", "site/index.html", "brand/icon.svg", ".github/workflows/release.yml"]), none);
  assert.deepEqual(scope([]), none);
});

test("TypeScript runs the extension job and e2e, not Rust", () => {
  assert.deepEqual(scope(["src/ui/popup.css"]), { rust: false, ext: true, e2e: true });
});

test("a unit test or a smoke tool alone skips e2e", () => {
  assert.deepEqual(scope(["src/shared/csv.test.ts", "tools/smoke-fill.mjs"]), { rust: false, ext: true, e2e: false });
});

test("a crate runs everything: its wasm goes into the extension", () => {
  assert.deepEqual(scope(["crates/autofill-clue/src/lib.rs"]), every);
  assert.deepEqual(scope(["Cargo.lock"]), every);
});

test("the check definitions and unknown files run everything that applies", () => {
  assert.deepEqual(scope([".github/workflows/ci.yml"]), every);
  assert.deepEqual(scope(["tools/verify.mjs"]), every);
  assert.deepEqual(scope(["crates/README.md"]), every);
  assert.deepEqual(scope(["something-new.yaml"]), { rust: false, ext: true, e2e: true });
});
