// "Hide passwords" collections: the popup never gets the password, hidden fields or history, and a save keeps them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { restoreHiddenPasswords, withoutHiddenPasswords } from "./hidden-passwords.ts";

const stored = {
  id: "a",
  viewPassword: false,
  login: { username: "u", password: "SECRET" },
  passwordHistory: [{ password: "OLD", lastUsedDate: "2026-01-01" }],
  fields: [
    { name: "pin", value: "HIDDEN", type: 1 },
    { name: "note", value: "plain", type: 0 },
  ],
};

test("the popup's copy holds no password, hidden field or history", () => {
  const shown = withoutHiddenPasswords(stored);
  for (const secret of ["SECRET", "OLD", "HIDDEN"]) assert.ok(!JSON.stringify(shown).includes(secret), secret);
  assert.deepEqual(shown.fields, [{ name: "note", value: "plain", type: 0 }]);
  assert.equal(stored.login.password, "SECRET", "the worker's copy is untouched");
  const open = { ...stored, viewPassword: true };
  assert.equal(withoutHiddenPasswords(open), open);
  // Vaultwarden may send PascalCase.
  assert.ok(!JSON.stringify(withoutHiddenPasswords({ ViewPassword: false, Login: { Password: "SECRET" } })).includes("SECRET"));
});

test("a save puts the stored secrets back, whatever the popup sent", () => {
  const edited = { ...withoutHiddenPasswords(stored), name: "renamed" } as Record<string, unknown>;
  (edited.login as Record<string, unknown>).password = "TYPED";
  edited.fields = [...(edited.fields as unknown[]), { name: "new", value: "N", type: 1 }];
  const saved = restoreHiddenPasswords(edited, stored) as typeof stored & { name: string };
  assert.equal(saved.name, "renamed");
  assert.equal(saved.login.password, "SECRET");
  assert.deepEqual(saved.passwordHistory, stored.passwordHistory);
  assert.deepEqual(saved.fields, [stored.fields[0], stored.fields[1], { name: "new", value: "N", type: 1 }]);
  // A new item, or one the user may read, passes through.
  assert.equal(restoreHiddenPasswords(edited, undefined), edited);
  assert.equal(restoreHiddenPasswords(edited, { ...stored, viewPassword: true }), edited);
});
