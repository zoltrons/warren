import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { offersTotp, setTotpSites } from "./totp-sites.ts";

test("a host matches its own domain and every parent, not a sibling or a bare suffix", () => {
  setTotpSites(["example.com", "shop.example.co.uk"]);
  assert.equal(offersTotp("example.com"), true);
  assert.equal(offersTotp("login.accounts.example.com"), true);
  assert.equal(offersTotp("EXAMPLE.com."), true);
  assert.equal(offersTotp("notexample.com"), false);
  assert.equal(offersTotp("shop.example.co.uk"), true);
  assert.equal(offersTotp("other.example.co.uk"), false);
  assert.equal(offersTotp("com"), false);
});

test("the shipped list is well formed", () => {
  const list = JSON.parse(readFileSync(new URL("./totp-sites.json", import.meta.url), "utf8")) as string[];
  assert.ok(list.length > 1000);
  assert.ok(list.every((d) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)));
  assert.ok(list.includes("github.com"));
});
