// What "Use a strong password" generates for: the constraints analyzeFocus reads, with the real autofill wasm.
import "../shared/uint8-polyfill.ts"; // Node 24 in CI
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { parsePageDetails } from "../shared/messages.ts";

const wasm = new URL("../../dist/wasm/autofill_core_bg.wasm", import.meta.url);
globalThis.fetch = (async () => new Response(readFileSync(wasm), { headers: { "content-type": "application/wasm" } })) as typeof fetch;
const { analyzeFocus } = await import("./engine.ts");

const field = (fieldId: number, extra: Record<string, unknown>) => ({ fieldId, formId: 1, type: "password", dataAttributes: {}, blockPath: [1], ...extra });

test("password constraints: only the new-password fields size the password, a PIN box does not", async () => {
  const details = parsePageDetails({
    origin: "https://site.test",
    forms: [{ formId: 1, htmlName: "signup", action: "/register" }],
    fields: [
      field(1, { type: "email", htmlName: "email", autocompleteType: "email", isActive: true }),
      field(2, { htmlName: "password", autocompleteType: "new-password", maxLength: 32, minLength: 10, passwordRules: "required: digit; allowed: lower" }),
      field(3, { htmlName: "confirm", autocompleteType: "new-password", maxLength: 24 }),
      field(4, { htmlName: "pin", autocompleteType: "one-time-code", maxLength: 4 }),
      field(5, { htmlName: "other-form", formId: 2, autocompleteType: "new-password", maxLength: 8 }),
    ],
    buttons: [],
  });
  assert.deepEqual((await analyzeFocus(details)).password, { rules: "required: digit; allowed: lower", minLength: 10, maxLength: 24 });
});

test("password constraints: passwordrules count on any password field, lengths only on new-password ones", async () => {
  const details = parsePageDetails({
    origin: "https://site.test",
    forms: [{ formId: 1 }],
    fields: [field(1, { htmlName: "code", autocompleteType: "one-time-code", maxLength: 1, isActive: true }), field(2, { htmlName: "x", passwordRules: "minlength: 12", autocompleteType: "one-time-code" })],
    buttons: [],
  });
  assert.deepEqual((await analyzeFocus(details)).password, { rules: "minlength: 12" });
});
