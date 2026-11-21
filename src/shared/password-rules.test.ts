import assert from "node:assert/strict";
import { test } from "node:test";
import { ruleOptions } from "./password-rules.ts";

test("password rules: required, allowed, custom classes and lengths", () => {
  assert.deepEqual(ruleOptions({ rules: "minlength: 8; maxlength: 12; required: lower; required: upper; required: digit; required: [-().&@?'#,/+]; allowed: ascii-printable; max-consecutive: 2;" }, 20), {
    length: 12,
    sets: [
      { chars: "abcdefghijklmnopqrstuvwxyz", min: 1 },
      { chars: "ABCDEFGHIJKLMNOPQRSTUVWXYZ", min: 1 },
      { chars: "0123456789", min: 1 },
      { chars: "-().&@?'#,/+", min: 1 },
      { chars: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*", min: 0 },
    ],
    maxConsecutive: 2,
  });
  // `]` first in a custom class is a member; case and spacing do not matter; unknown parts are ignored.
  assert.deepEqual(ruleOptions({ rules: " Allowed : DIGIT,[]_é ]; colour: red; required:" }, 14), { length: 14, sets: [{ chars: "0123456789]_", min: 0 }] });
  // The field's own maxlength caps the length; the rule's minlength raises it.
  assert.deepEqual(ruleOptions({ maxLength: 10 }, 20), { length: 10 });
  assert.deepEqual(ruleOptions({ rules: "minlength: 24", maxLength: 64 }, 20), { length: 24 });
  assert.equal(ruleOptions({ rules: "maxlength: lots; minlength: -3" }, 20), undefined);
  assert.equal(ruleOptions({}, 20), undefined);
});
