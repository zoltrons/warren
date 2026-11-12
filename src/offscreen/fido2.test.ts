import "../shared/uint8-polyfill.ts"; // Node 24 in CI
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { Psl } from "../autofill/match.ts";
import { assert as sign, checkRpId, createCredential } from "./fido2.ts";

// Needs dist/psl.json (node tools/fetch-psl.mjs).
const psl = new Psl(JSON.parse(readFileSync(new URL("../../dist/psl.json", import.meta.url), "utf8")) as string[]);
const ok = (rpId: string, origin: string) => checkRpId(rpId, origin, (d) => psl.isPublicSuffix(d));

test("passkey RP ID: the origin's host or a registrable parent of it", () => {
  ok("example.com", "https://example.com");
  ok("example.com", "https://login.example.com");
  ok("login.example.com", "https://login.example.com:8443");
  ok("localhost", "http://localhost:8099");
  ok("127.0.0.1", "http://127.0.0.1:8099");
});

test("passkey RP ID: refused for other sites, public suffixes and insecure origins", () => {
  assert.throws(() => ok("example.com", "https://evil.com"), /SecurityError/);
  assert.throws(() => ok("example.com", "https://example.com.evil.net"), /SecurityError/);
  assert.throws(() => ok("example.com", "https://evilexample.com"), /SecurityError/); // a suffix, not a parent
  assert.throws(() => ok("login.example.com", "https://example.com"), /SecurityError/); // child of the origin
  assert.throws(() => ok("com", "https://example.com"), /SecurityError/);
  assert.throws(() => ok("github.io", "https://alice.github.io"), /SecurityError/); // private-section suffix
  assert.throws(() => ok("github.io", "https://github.io"), /SecurityError/); // ...also for its own host
  assert.throws(() => ok("example.com", "http://example.com"), /SecurityError/);
  // An IP address is only ever its own RP ID: its tail is shared by unrelated hosts.
  ok("192.168.1.1", "https://192.168.1.1");
  assert.throws(() => ok("1.1", "https://192.168.1.1"), /SecurityError/);
  assert.throws(() => ok("168.1.1", "https://192.168.1.1"), /SecurityError/);
  // A trailing dot is not a way around the suffix list.
  assert.throws(() => ok("com.", "https://example.com."), /SecurityError/);
  assert.throws(() => ok("co.uk.", "https://shop.co.uk."), /SecurityError/);
  assert.throws(() => ok("github.io.", "https://alice.github.io."), /SecurityError/);
  assert.throws(() => ok("example.com.", "https://example.com."), /SecurityError/);
  assert.throws(() => ok("example..com", "https://a.example..com"), /SecurityError/);
});

test("passkeys: the UV flag is set only for a verified user", async () => {
  const flagsOf = (authenticatorData: unknown) => Uint8Array.fromBase64(String(authenticatorData), { alphabet: "base64url" })[32]!;
  const input = { origin: "https://example.com", rpId: "example.com", rpName: "E", challenge: "Yw", user: { id: "dQ", name: "u", displayName: "U" }, discoverable: true };
  const made = await createCredential({ ...input, uv: false });
  assert.equal(flagsOf(made.response.authenticatorData) & 0x04, 0);
  assert.equal(flagsOf(made.response.authenticatorData) & 0x01, 0x01, "user presence");
  assert.equal(flagsOf((await createCredential({ ...input, uv: true })).response.authenticatorData) & 0x04, 0x04);
  const cred = made.fido2Credential as Record<string, unknown>;
  assert.equal(flagsOf((await sign(cred, input.origin, "Yw", false)).authenticatorData) & 0x04, 0);
  assert.equal(flagsOf((await sign(cred, input.origin, "Yw", true)).authenticatorData) & 0x04, 0x04);
});

test("passkeys: a new credential carries Bitwarden's AAGUID", async () => {
  const made = await createCredential({ origin: "https://example.com", rpId: "example.com", rpName: "E", challenge: "Yw", user: { id: "dQ", name: "u", displayName: "U" }, discoverable: true, uv: false });
  // authData: rpIdHash (32) | flags (1) | counter (4) | AAGUID (16) | ...
  const data = Uint8Array.fromBase64(String(made.response.authenticatorData), { alphabet: "base64url" });
  assert.equal(data.subarray(37, 53).toHex(), "d548826e79b4db40a3d811116f7e8349");
});

test("passkeys: a conditional create sets neither UP nor UV", async () => {
  const made = await createCredential({ origin: "https://example.com", rpId: "example.com", rpName: "E", challenge: "Yw", user: { id: "dQ", name: "u", displayName: "U" }, discoverable: true, uv: false, up: false });
  const flagsByte = Uint8Array.fromBase64(String(made.response.authenticatorData), { alphabet: "base64url" })[32]!;
  assert.equal(flagsByte & 0x05, 0);
  assert.equal(flagsByte & 0x40, 0x40, "attested credential data");
});
