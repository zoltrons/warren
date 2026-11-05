// The KDF downgrade guard: a server cannot make the master password hash cheap to crack.
import assert from "node:assert/strict";
import { test } from "node:test";
import { kdfDowngrade, pinOnlyStrong, raiseFloor, safeKdf, tooWeak } from "./kdf.ts";

const pbkdf2 = (iterations: number) => ({ type: 0, iterations, memory: 0, parallelism: 0 });
const argon = (memory: number, iterations: number) => ({ type: 1, iterations, memory, parallelism: 4 });

test("a weaker KDF than the account used is refused unless it is still safe", () => {
  assert.equal(kdfDowngrade(pbkdf2(5000), undefined), false, "first login: nothing to compare");
  assert.equal(kdfDowngrade(pbkdf2(5000), argon(64, 3)), true, "Argon2id -> cheap PBKDF2");
  assert.equal(kdfDowngrade(pbkdf2(5000), pbkdf2(600_000)), true);
  assert.equal(kdfDowngrade(argon(16, 2), argon(64, 3)), true);
  assert.equal(kdfDowngrade(pbkdf2(600_000), argon(256, 4)), false, "a safe setting the user chose");
  assert.equal(kdfDowngrade(argon(64, 3), argon(1024, 10)), false);
  assert.equal(kdfDowngrade(argon(16, 2), pbkdf2(600_000)), false, "PBKDF2 -> Argon2id is an upgrade");
});

test("PBKDF2 under 100 000 iterations is never used; under 600 000 it is flagged", () => {
  assert.equal(tooWeak(pbkdf2(5000)), true);
  assert.equal(tooWeak(pbkdf2(99_999)), true);
  assert.equal(tooWeak(pbkdf2(100_000)), false);
  assert.equal(tooWeak(argon(16, 2)), false, "the server-side range check covers Argon2id");
  assert.equal(safeKdf(pbkdf2(100_000)), false);
  assert.equal(safeKdf(pbkdf2(600_000)), true);
  assert.equal(safeKdf(argon(32, 3)), false);
});

test("the floor only goes up", () => {
  assert.deepEqual(raiseFloor(pbkdf2(600_000), undefined), pbkdf2(600_000));
  assert.deepEqual(raiseFloor(argon(64, 3), pbkdf2(600_000)), argon(64, 3));
  assert.deepEqual(raiseFloor(pbkdf2(600_000), argon(64, 3)), argon(64, 3));
});

test("a PIN that unlocks alone after a restart is not a short number", () => {
  for (const pin of ["123456", "12345678901234", "abc12", ""]) assert.equal(pinOnlyStrong(pin), false, pin);
  for (const pin of ["1234567a", "correct horse", "şifre-123"]) assert.equal(pinOnlyStrong(pin), true, pin);
});
