import assert from "node:assert/strict";
import { test } from "node:test";
import { ageOn, fakeIdentity } from "./identity-gen.ts";

test("identity generator: the age is in range and matches the birth date, Feb 29 too", () => {
  for (const today of ["2026-11-03", "2028-02-29", "2027-03-01", "2026-12-31", "2027-01-01"].map((d) => new Date(`${d}T12:00:00Z`))) {
    for (let i = 0; i < 300; i++) {
      const p = fakeIdentity(18, 65, today);
      assert.ok(p.age >= 18 && p.age <= 65, `age ${p.age}`);
      assert.equal(ageOn(new Date(`${p.birthDate}T00:00:00Z`), today), p.age, `${p.birthDate} on ${today.toISOString()}`);
    }
  }
  assert.equal(fakeIdentity(30, 30).age, 30);
  assert.ok(fakeIdentity(40, 20).age >= 20); // either order
});

test("identity generator: the username is plain ASCII", () => {
  for (let i = 0; i < 200; i++) assert.match(fakeIdentity(18, 65).username, /^[a-z]+\.[a-z]+\d\d$/);
});
