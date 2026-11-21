import assert from "node:assert/strict";
import { test } from "node:test";
import { cardBrand, groupCardNumber, luhnValid, shownBrand, storableBrand } from "./card.ts";

test("Luhn accepts the standard test numbers and rejects a typo", () => {
  assert.equal(luhnValid("4111 1111 1111 1111"), true);
  assert.equal(luhnValid("378282246310005"), true);
  assert.equal(luhnValid("4111 1111 1111 1112"), false);
  assert.equal(luhnValid("1234"), false);
});

test("brand from the prefix", () => {
  assert.equal(cardBrand("4111111111111111"), "Visa");
  assert.equal(cardBrand("5555555555554444"), "Mastercard");
  assert.equal(cardBrand("2223000048400011"), "Mastercard");
  assert.equal(cardBrand("378282246310005"), "Amex");
  assert.equal(cardBrand("6011111111111117"), "Discover");
  assert.equal(cardBrand("3530111333300000"), "JCB");
  assert.equal(cardBrand("6759649826438453"), "Maestro");
  assert.equal(cardBrand("6521000000000000"), "RuPay");
  assert.equal(cardBrand("6500000000000002"), "Discover");
  assert.equal(cardBrand("6200000000000005"), "UnionPay");
  assert.equal(cardBrand("9792000000000001"), "Troy");
  assert.equal(cardBrand("6501739600000000"), "Troy");
  assert.equal(cardBrand("6573660000000000"), "Troy");
  assert.equal(cardBrand("9000200000000000"), "Troy");
  assert.equal(cardBrand("6501700000000000"), "Discover");
  assert.equal(cardBrand("9792900000000000"), undefined);
  assert.equal(cardBrand("9"), undefined);
});

test("shown brand: stored wins unless unset or Other, a Troy number beats a stored Discover; Troy is never stored", () => {
  assert.equal(shownBrand("Visa", "9792000000000001"), "Visa");
  assert.equal(shownBrand("Other", "9792000000000001"), "Troy");
  assert.equal(shownBrand("", "9792000000000001"), "Troy");
  assert.equal(shownBrand("Other", "1"), "Other");
  assert.equal(shownBrand("Discover", "6501739600000000"), "Troy");
  assert.equal(shownBrand("Discover", "6011111111111117"), "Discover");
  assert.equal(storableBrand("Troy"), undefined);
  assert.equal(storableBrand("Visa"), "Visa");
});

test("grouping: 4-4-4-4, Amex 4-6-5, leaves odd input alone", () => {
  assert.equal(groupCardNumber("4111111111111111"), "4111 1111 1111 1111");
  assert.equal(groupCardNumber("378282246310005"), "3782 822463 10005");
  assert.equal(groupCardNumber("ab12"), "ab12");
});
