import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ageOn, fakeIdentity, type IdentityData } from "./identity-gen.ts";

const data = JSON.parse(readFileSync(new URL("./identity-data.json", import.meta.url), "utf8")) as IdentityData;

test("identity generator: the age is in range and matches the birth date, Feb 29 too", () => {
  for (const today of ["2026-11-03", "2028-02-29", "2027-03-01", "2026-12-31", "2027-01-01"].map((d) => new Date(`${d}T12:00:00Z`))) {
    for (let i = 0; i < 300; i++) {
      const p = fakeIdentity(data, "", 18, 65, today);
      assert.ok(p.age >= 18 && p.age <= 65, `age ${p.age}`);
      assert.equal(ageOn(new Date(`${p.birthDate}T00:00:00Z`), today), p.age, `${p.birthDate} on ${today.toISOString()}`);
    }
  }
  assert.equal(fakeIdentity(data, "TR", 30, 30).age, 30);
  assert.ok(fakeIdentity(data, "TR", 40, 20).age >= 20); // either order
});

test("identity generator: name, city and country come from the same country", () => {
  for (const [code, c] of Object.entries(data)) {
    for (let i = 0; i < 50; i++) {
      const p = fakeIdentity(data, code, 18, 65);
      assert.equal(p.country, c.country);
      assert.ok(c.female.includes(p.firstName) || c.male.includes(p.firstName), `${code} first ${p.firstName}`);
      assert.ok(c.last.includes(p.lastName) || !!c.lastFemale?.includes(p.lastName), `${code} last ${p.lastName}`);
      assert.ok(c.cities.includes(p.city), `${code} city ${p.city}`);
      assert.match(p.username, /^[a-z]+\.[a-z]+\d\d$/, `${code} username ${p.username}`);
    }
  }
  // A Polish woman gets the feminine family name.
  for (let i = 0; i < 100; i++) {
    const p = fakeIdentity(data, "PL", 18, 65);
    if (data.PL!.female.includes(p.firstName) && !data.PL!.male.includes(p.firstName)) assert.doesNotMatch(p.lastName, /(ski|cki|dzki)$/);
  }
});
