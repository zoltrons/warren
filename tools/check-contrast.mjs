#!/usr/bin/env node
// WCAG contrast check for the brand palette and the popup theme tokens (src/ui/popup.css).
//   node tools/check-contrast.mjs
// Text pairs must reach 4.5:1 and UI (icons, borders) 3:1; translucent tokens are composited over the
// surface they sit on. Placeholders and disabled hints (`--faint`) are listed, not enforced.
// Exits 1 when an enforced pair fails or the two dark-theme blocks drift apart.
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

/** "#rgb", "#rrggbb", "rgb(a)(r g b / a)", "hsl(a)(h s% l% / a)" → [r, g, b, a] with r,g,b in 0..255. */
export function parse(c) {
  c = c.trim();
  if (c.startsWith("#")) {
    const h = c.length === 4 ? [...c.slice(1)].map((x) => x + x).join("") : c.slice(1);
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)).concat(1);
  }
  const m = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(c);
  if (!m) throw new Error(`unsupported color ${c}`);
  const [a, b, d, alpha = "1"] = m[2].split(/[\s,/]+/).filter(Boolean);
  const al = alpha.endsWith("%") ? parseFloat(alpha) / 100 : parseFloat(alpha);
  if (m[1].startsWith("rgb")) return [+a, +b, +d, al];
  const [h, s, l] = [parseFloat(a), parseFloat(b) / 100, parseFloat(d) / 100];
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return 255 * (l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1)));
  };
  return [f(0), f(8), f(4), al];
}

/** Paints `top` over an opaque `under`. */
const over = (top, under) => [0, 1, 2].map((i) => top[i] * top[3] + under[i] * (1 - top[3])).concat(1);

const lum = ([r, g, b]) => {
  const ch = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
};
export const ratio = (a, b) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

assert.equal(ratio(parse("#000"), parse("#fff")).toFixed(1), "21.0");
assert.deepEqual(parse("hsl(0 100% 50%)").map(Math.round), [255, 0, 0, 1]);
assert.equal(ratio(parse("#2a0a1a"), parse("#fff7f8")).toFixed(1), "17.2"); // the brand guide's own figure

const PALETTE = { pink: "#ff4f7b", raspberry: "#c2113f", cherry: "#2a0a1a", snow: "#fff7f8", blush: "#ffd3dc", gold: "#ffc83d", white: "#ffffff" };
// [fg, bg, rule]: "text" ≥ 4.5, "large" = decorative / large only (reported, not enforced), "never" = do not pair.
const BRAND = [
  ["cherry", "snow", "text"], ["cherry", "blush", "text"], ["cherry", "pink", "text"], ["snow", "raspberry", "text"],
  ["white", "raspberry", "text"], ["snow", "pink", "large"], ["cherry", "raspberry", "never"],
];

function tokens(css, selector) {
  const i = css.indexOf(selector);
  if (i < 0) throw new Error(`no ${selector} block`);
  const block = css.slice(css.indexOf("{", i) + 1, css.indexOf("}", i));
  return Object.fromEntries([...block.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
}

const css = readFileSync(new URL("../src/ui/popup.css", import.meta.url), "utf8");
const light = tokens(css, ":root {");
const darkVars = tokens(css, ':root[data-theme="dark"] {');
const darkMedia = tokens(css, ':root:not([data-theme="light"]) {');
const blackVars = tokens(css, ':root[data-theme="black"] {');
let failed = 0;
for (const k of new Set([...Object.keys(darkVars), ...Object.keys(darkMedia)]))
  if (darkVars[k] !== darkMedia[k]) (failed++, console.log(`DRIFT  --${k}: data-theme="${darkVars[k]}" vs media="${darkMedia[k]}"`));

const BGS = ["bg", "surface", "surface-sunken", "surface-raised"];
const PAIRS = [
  ...["text", "muted", "link", "success", "warning", "critical", "attention"].flatMap((fg) => BGS.map((bg) => [fg, bg, "text"])),
  ...["primary", "primary-hover", "primary-pressed"].map((bg) => ["on-primary", bg, "text"]),
  ["text", "selected", "text"], ["text", "pressed", "text"], ["link", "primary-weak", "text"], ["critical", "critical-weak", "text"],
  ...["primary", "favorite"].flatMap((fg) => ["bg", "surface"].map((bg) => [fg, bg, "ui"])),
  ...["bg", "surface"].map((bg) => ["faint", bg, "quiet"]),
];
const MIN = { text: 4.5, ui: 3 };

const rows = [];
for (const [name, t] of [["light", light], ["dark", { ...light, ...darkVars }], ["black", { ...light, ...darkVars, ...blackVars }]]) {
  const color = (k, under) => {
    const c = parse(t[k]);
    return c[3] < 1 ? over(c, under ?? color("surface")) : c;
  };
  for (const [fg, bg, rule] of PAIRS) {
    const b = color(bg, color("surface"));
    const r = ratio(color(fg, b), b);
    rows.push({ theme: name, pair: `--${fg} on --${bg}`, ratio: r, rule, ok: !MIN[rule] || r >= MIN[rule] });
  }
}
for (const [fg, bg, rule] of BRAND) {
  const r = ratio(parse(PALETTE[fg]), parse(PALETTE[bg]));
  rows.push({ theme: "brand", pair: `${fg} on ${bg}`, ratio: r, rule, ok: rule !== "text" || r >= 4.5 });
}

for (const r of rows) {
  const tag = !r.ok ? "FAIL " : r.ratio < 4.5 ? "below" : "ok   ";
  if (!r.ok) failed++;
  console.log(`${tag}  ${r.theme.padEnd(5)}  ${r.ratio.toFixed(2).padStart(5)}  ${r.rule.padEnd(5)}  ${r.pair}`);
}
const below = rows.filter((r) => r.ok && r.ratio < 4.5);
console.log(`\n${rows.length} pairs, ${failed} failing, ${below.length} below 4.5 by design (ui ≥ 3, placeholders, decorative-only brand pairs).`);
process.exit(failed ? 1 : 0);
