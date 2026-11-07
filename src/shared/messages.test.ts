// Boundary validation: anything a page, a server or a file controls is shape- and size-checked.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseCoreRequest, parseFrameRequest, parsePasskeyCall, parsePageRequest, parseRequest } from "./messages.ts";

const throws = (fn: () => unknown, what: RegExp) => assert.throws(fn, what);

test("core requests: a KDF reaches the worker only as values its u8/u32 parameters hold", () => {
  const prepare = (kdf: Record<string, number>) => parseCoreRequest({ op: "prepareKey", email: "a@b.test", password: "p", kdf: { type: 0, iterations: 600_000, memory: 0, parallelism: 0, ...kdf } });
  prepare({});
  for (const bad of [{ iterations: 2 ** 32 + 5000 }, { iterations: 1.5 }, { memory: -1 }, { type: 257 }]) throws(() => prepare(bad), /expected/);
});

test("page requests: a submitted login is size-capped", () => {
  const ok = parsePageRequest({ type: "loginSubmitted", username: "u", password: "p" });
  assert.deepEqual(ok, { type: "loginSubmitted", username: "u", password: "p" });
  throws(() => parsePageRequest({ type: "loginSubmitted", username: "u", password: "x".repeat(9000) }), /too long/);
  throws(() => parsePageRequest({ type: "loginSubmitted", username: "x".repeat(9000), password: "p" }), /too long/);
});

test("frame requests: inline actions need the nonce, bar actions need the save token", () => {
  assert.deepEqual(parseFrameRequest({ type: "inlineFill", id: "i", nonce: "n" }), { type: "inlineFill", id: "i", nonce: "n" });
  throws(() => parseFrameRequest({ type: "inlineFill", id: "i" }), /nonce/);
  throws(() => parseFrameRequest({ type: "inlineList" }), /nonce/);
  assert.deepEqual(parseFrameRequest({ type: "barAction", action: "save", token: "t" }), { type: "barAction", action: "save", token: "t" });
  throws(() => parseFrameRequest({ type: "barAction", action: "save" }), /token/);
  throws(() => parseFrameRequest({ type: "barInfo" }), /token/);
});

test("popup requests: unknown types, and new organization items without a collection, are refused", () => {
  throws(() => parseRequest({ type: "eval" }), /unknown message type/);
  throws(() => parseRequest({ type: "saveItem", item: { type: 1, name: "n", organizationId: "org" } }), /needs a collection/);
  parseRequest({ type: "saveItem", item: { type: 1, name: "n", organizationId: "org" }, collectionIds: ["c"] });
  throws(() => parseRequest({ type: "moveToOrg", id: "c1", organizationId: "org", collectionIds: [] }), /at least one/);
  throws(() => parseRequest({ type: "setCollections", id: "c1", collectionIds: [""] }), /collection ids/);
  parseRequest({ type: "saveItem", item: { id: "c1", type: 1, name: "n", organizationId: "org" } });
  throws(() => parseRequest({ type: "saveItem", item: { type: 9, name: "n" } }), /cannot be edited/);
  throws(() => parseRequest({ type: "saveItem", item: { type: 1, name: "  " } }), /required/);
  throws(() => parseRequest({ type: "setSettings", autoLockMinutes: 7 }), /not an allowed choice/);
});

test("popup requests: an import is size-capped", () => {
  assert.deepEqual(parseRequest({ type: "importVault", text: "{}" }), { type: "importVault", text: "{}", password: undefined });
  throws(() => parseRequest({ type: "importVault", text: "x".repeat(17 * 1024 * 1024) }), /too long/);
});

test("passkey calls: page-supplied options are bounded", () => {
  const base = { kind: "get", conditional: false, options: { challenge: "c", allow: [] } };
  assert.deepEqual(parsePasskeyCall(base), { ...base, options: { ...base.options, rpId: undefined, userVerification: "preferred" } });
  // The RP's userVerification is carried; an unknown value means "preferred", as in WebAuthn.
  const uv = (userVerification: unknown) => parsePasskeyCall({ ...base, options: { ...base.options, userVerification } }).options.userVerification;
  assert.equal(uv("required"), "required");
  assert.equal(uv("discouraged"), "discouraged");
  assert.equal(uv("bogus"), "preferred");
  // A huge challenge or an endless allowCredentials list would otherwise be page-controlled work.
  throws(() => parsePasskeyCall({ ...base, options: { challenge: "x".repeat(64 * 1024 + 1), allow: [] } }), /too long/);
  // Google's "Verify it's you" sends a challenge of about 14 000 characters: it must not be refused.
  parsePasskeyCall({ ...base, options: { challenge: "x".repeat(14_367), allow: [] } });
  throws(() => parsePasskeyCall({ ...base, options: { challenge: "c", allow: Array.from({ length: 65 }, (_, i) => `id${i}`) } }), /too many/);
  throws(() => parsePasskeyCall({ ...base, options: { challenge: "c", allow: [], rpId: "a".repeat(300) } }), /too long/);
  throws(
    () => parsePasskeyCall({ kind: "create", options: { rpName: "r", user: { id: "i", name: "n".repeat(2000), displayName: "d" }, challenge: "c", exclude: [], discoverable: true } }),
    /too long/,
  );
});

test("popup requests: alias generation names a known service and caps its settings", () => {
  assert.deepEqual(parseRequest({ type: "generateAlias", vendor: "fastmail" }), { type: "generateAlias", vendor: "fastmail" });
  throws(() => parseRequest({ type: "generateAlias", vendor: "sendgrid" }), /vendor/);
  const ok = { type: "setAliasSettings", settings: { vendor: "addyio", token: "t", baseUrl: "https://a.example", domain: "example.com", prefix: false } };
  assert.deepEqual(parseRequest(ok), ok);
  throws(() => parseRequest({ ...ok, settings: { ...ok.settings, token: "x".repeat(2000) } }), /too long/);
  throws(() => parseRequest({ ...ok, settings: { ...ok.settings, baseUrl: "x".repeat(600) } }), /too long/);
  throws(() => parseRequest({ type: "aliasSettings", vendor: "nope" }), /vendor/);
});

const details = { origin: "https://a.test", forms: [], fields: [{ fieldId: 1, type: "text", dataAttributes: {}, blockPath: [] }], buttons: [] };

test("inlineFocus carries bounded page details", () => {
  const parsed = parsePageRequest({ type: "inlineFocus", nonce: "n", details }) as { details: { fields: { fieldId: number }[] } };
  assert.equal(parsed.details.fields[0]!.fieldId, 1);
  throws(() => parsePageRequest({ type: "inlineFocus", details }), /nonce/);
  throws(() => parsePageRequest({ type: "inlineFocus", nonce: "n" }), /details/);
  const big = (field: object) => ({ type: "inlineFocus", nonce: "n", details: { ...details, fields: [{ ...details.fields[0], ...field }] } });
  throws(() => parsePageRequest(big({ label: "x".repeat(301) })), /too long/);
  throws(() => parsePageRequest(big({ blockPath: Array(33).fill(1) })), /too many/);
  throws(() => parsePageRequest(big({ dataAttributes: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`k${i}`, "v"])) })), /too many/);
  throws(() => parsePageRequest(big({ dataAttributes: { a: 1 } })), /string/);
  throws(() => parsePageRequest({ type: "inlineFocus", nonce: "n", details: { ...details, fields: Array(257).fill(details.fields[0]) } }), /too many/);
});

test("page and frame requests: unknown types are refused, also inherited names", () => {
  for (const type of ["nope", "toString", "__proto__", "constructor", undefined]) {
    throws(() => parsePageRequest({ type }), /unknown message type/);
    throws(() => parseFrameRequest({ type, nonce: "n" }), /unknown message type/);
  }
  throws(() => parsePageRequest(null), /unknown message type/);
});
