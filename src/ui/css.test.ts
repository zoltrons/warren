import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const css = readFileSync(new URL("popup.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** A compound starting with html, body, #app or .page (not .page-title) that carries :has() anywhere in it. */
const ROOT_HAS = String.raw`(?:^|[\s,{}>+~])(?:html|body|#app|\.page)(?![\w-])[^\s,{]*:has\(`;

test("popup.css: no :has() on html, body, #app or .page (each DOM change re-checked the whole vault list)", () => {
  const bad = css.match(new RegExp(ROOT_HAS, "gm")) ?? [];
  assert.deepEqual(bad, [], "set a class from popup.ts render instead (see html.centered, #app.has-nav)");
});

test("popup.css guard: the pattern catches the forms that caused the slowdown", () => {
  const re = new RegExp(ROOT_HAS, "m");
  for (const bad of ["html:not(.frame):has(.page.center) {", "body:has(.x) {", "#app:has(.nav) .page {", ".page:has(.empty) {", "html:not(.frame):not(:has(body.panel)) {"]) assert.ok(re.test(bad), bad);
  for (const ok of [".row:has(> .row-main:hover) {", ".tile:has(img) {", ".page-title:has(x) {", "body.frame .row .tile:not(:has(img)) {"]) assert.ok(!re.test(ok), ok);
});

test("popup.css: no viewport-size @media (the popup's auto-sizing flips them, re-checking every element twice)", () => {
  const bad = css.match(/@media[^{]*\b(?:(?:min-|max-)?(?:width|height|aspect-ratio)|orientation)\b[^{]*/g) ?? [];
  assert.deepEqual(bad, [], "use @container on body instead");
});
