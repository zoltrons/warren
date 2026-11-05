// The popup never holds a passkey's private key, and an edit does not lose it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { restorePasskeyKeys, withoutPasskeyKeys } from "./passkey-keys.ts";

const stored = { id: "a", name: "n", login: { username: "u", fido2Credentials: [{ credentialId: "c1", rpId: "x.test", keyValue: "SECRET" }] } };

test("the item the popup gets has no passkey private key", () => {
  const shown = withoutPasskeyKeys(stored);
  assert.ok(!JSON.stringify(shown).includes("SECRET"));
  assert.equal(stored.login.fido2Credentials[0]!.keyValue, "SECRET", "the worker's copy is untouched");
  assert.deepEqual(withoutPasskeyKeys({ id: "b", login: { username: "u" } }), { id: "b", login: { username: "u" } });
  // Vaultwarden may send PascalCase.
  assert.ok(!JSON.stringify(withoutPasskeyKeys({ Login: { Fido2Credentials: [{ CredentialId: "c", KeyValue: "SECRET" }] } })).includes("SECRET"));
});

test("a save gets the key back from the same item only; a clone loses the passkey", () => {
  const edited = { ...withoutPasskeyKeys(stored), name: "renamed" } as typeof stored;
  assert.equal(restorePasskeyKeys(edited, stored).login.fido2Credentials[0]!.keyValue, "SECRET");
  const other = { id: "b", login: { fido2Credentials: [{ credentialId: "c9", keyValue: "OTHER" }] } };
  assert.deepEqual((restorePasskeyKeys(edited, other) as typeof stored).login.fido2Credentials, [], "never a key from another item");
  assert.deepEqual((restorePasskeyKeys({ ...edited, id: undefined }, undefined) as typeof stored).login.fido2Credentials, []);
  // A new passkey (made in the worker, with its key) passes through.
  const fresh = { login: { fido2Credentials: [{ credentialId: "n1", keyValue: "NEW" }] } };
  assert.deepEqual(restorePasskeyKeys(fresh, stored), fresh);
});
