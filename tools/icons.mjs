#!/usr/bin/env node
// Derives every logo and icon from the two masters, brand/icon.svg and brand/wordmark.svg:
// the icon variants and horizontal logos (brand/*.svg) and the extension's PNGs (src/icons/).
//   node tools/icons.mjs [--sheet <file.png>]   (--sheet also writes a contact sheet to check small sizes)
// Rasterized by Helium (HELIUM_PATH, else ~/Applications/Helium.app), else Playwright's Chromium.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";

const root = new URL("..", import.meta.url).pathname;
const brand = join(root, "brand");
const icon = readFileSync(join(brand, "icon.svg"), "utf8");
const wordmark = readFileSync(join(brand, "wordmark.svg"), "utf8");

const C = { cherry: "#2A0A1A", snow: "#FFF7F8", pink: "#FF4F7B" };
const recolor = (svg, map) => svg.replace(/#[0-9A-F]{6}/g, (c) => map[c] ?? c); // wordmark only
const inner = (svg) => svg.replace(/^<svg[^>]*>|<\/svg>\s*$/g, "").trim();
// The icon is colored only by its <style> block (classes bg, rabbit, inner, eye, lock, keyhole); variants swap it.
const paint = (p) => icon.replace(/<style>[\s\S]*?<\/style>/, `<style>${Object.entries(p).map(([k, v]) => `.${k}{fill:${v}}`).join("")}</style>`);
const gray = { bg: "#3B3337", rabbit: "#CFC7CA", inner: "#8E8388", eye: "#3B3337", lock: "#8E8388", keyhole: "#3B3337" };

const variants = {
  // On a pink ground the pink lock would vanish: the lock turns night cherry and its keyhole pink.
  "icon-light": paint({ bg: C.pink, rabbit: C.snow, inner: C.pink, eye: C.cherry, lock: C.cherry, keyhole: C.pink }),
  // Locked: gray tones of the same drawing. Logged out: the locked icon, faded.
  "icon-locked": paint(gray),
};
variants["icon-loggedout"] = variants["icon-locked"].replace(/(<svg[^>]*>)([\s\S]*)<\/svg>/, '$1<g opacity=".5">$2</g></svg>');

// Horizontal logo: the icon at 100 px, then the wordmark (238×48) at its natural size, centered.
const logo = (iconSvg, letters) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 368 100">
  <svg width="100" height="100" viewBox="0 0 128 128">${inner(iconSvg)}</svg>
  <svg x="124" y="26" width="238" height="48" viewBox="0 16 238 48">${inner(recolor(wordmark, { [C.snow]: letters }))}</svg>
</svg>
`;
const files = {
  ...variants,
  "logo-horizontal-dark": logo(icon, C.snow),
  "logo-horizontal-light": logo(variants["icon-light"], C.cherry),
};
for (const [name, svg] of Object.entries(files)) writeFileSync(join(brand, `${name}.svg`), svg);

// Manifest icons (16/32/48/128) plus the toolbar sizes (16/19/32/38) for each lock state.
const png = [
  ...[16, 19, 32, 38, 48, 128].map((s) => ["warren", icon, s]),
  ...[16, 19, 32, 38].flatMap((s) => [["locked", variants["icon-locked"], s], ["loggedout", variants["icon-loggedout"], s]]),
];

const helium = process.env.HELIUM_PATH ?? join(homedir(), "Applications/Helium.app/Contents/MacOS/Helium");
const browser = await chromium.launch({ executablePath: existsSync(helium) ? helium : chromium.executablePath() });
const page = await browser.newPage();
const src = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
const out = join(root, "src/icons");
mkdirSync(out, { recursive: true });
// At 19 px and below the pink inner ears blur into the white ones, so those sizes draw the plain silhouette.
const plain = (svg) => svg.replace(/\s*<rect class="inner"[^>]*\/>/g, "");
for (const [name, svg, size] of png) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>*{margin:0}</style><img src="${src(size <= 19 ? plain(svg) : svg)}" width="${size}" height="${size}">`);
  await page.locator("img").screenshot({ path: join(out, `${name}-${size}.png`), omitBackground: true });
}

const sheet = process.argv.indexOf("--sheet");
if (sheet > 0) {
  const sizes = [16, 32, 48, 128];
  const row = (svg) => sizes.map((s) => `<img src="${src(svg)}" width="${s}" height="${s}">`).join("");
  const band = (bg, fg) =>
    `<div style="background:${bg};color:${fg};padding:16px;display:grid;gap:12px">` +
    Object.entries({ icon, ...variants }).map(([n, svg]) => `<div style="display:flex;gap:20px;align-items:end"><span style="width:110px">${n}</span>${row(svg)}</div>`).join("") +
    `<img src="${src(files[bg === "#f1f3f4" ? "logo-horizontal-light" : "logo-horizontal-dark"])}" height="56"></div>`;
  await page.setViewportSize({ width: 520, height: 100 });
  await page.setContent(`<body style="margin:0;font:12px system-ui">${band("#f1f3f4", "#202124")}${band("#202124", "#e8eaed")}</body>`);
  await page.screenshot({ path: process.argv[sheet + 1], fullPage: true });
}
await browser.close();
console.log(`brand/: ${Object.keys(files).length} svg, src/icons/: ${png.length} png`);
