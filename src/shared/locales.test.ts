// Every locale carries every English key with the same placeholders, so no screen falls back to English or drops a value.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";

type Messages = Record<string, { message: string; placeholders?: Record<string, { content: string }> }>;
const dir = new URL("../_locales/", import.meta.url);
const load = (lang: string): Messages => JSON.parse(readFileSync(new URL(`${lang}/messages.json`, dir), "utf8")) as Messages;
const tokens = (s: string) => [...new Set([...s.matchAll(/\$([A-Za-z0-9_]+)\$/g)].map((m) => m[1]!.toLowerCase()))].sort();

test("every locale has every key, the same placeholders and its own uiLocale", () => {
  const en = load("en");
  for (const lang of readdirSync(dir).filter((d) => d !== "en")) {
    const other = load(lang);
    assert.deepEqual(Object.keys(other).sort(), Object.keys(en).sort(), lang);
    for (const [k, v] of Object.entries(en)) {
      assert.deepEqual(tokens(other[k]!.message), tokens(v.message), `${lang}: ${k}`);
      assert.deepEqual(other[k]!.placeholders, v.placeholders, `${lang}: ${k} placeholders`);
    }
    assert.equal(other.uiLocale!.message, lang);
  }
});
