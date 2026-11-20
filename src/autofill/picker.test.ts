import assert from "node:assert/strict";
import { test } from "node:test";
import { looksGenerated } from "./picker.ts";

test("ids made up per page load are not used as a custom field's name", () => {
  for (const id of [":r3:", "«r1»", "_r_a_", "radix-:r5:", "mat-input-0", "headlessui-input-3", "react-aria-12", "downshift-0-input", "input-1234", "a1b2c3d4e5"])
    assert.equal(looksGenerated(id), true, id);
  for (const id of ["email", "username", "member_no", "address-line-1", "card-cvc", "otp"]) assert.equal(looksGenerated(id), false, id);
});
