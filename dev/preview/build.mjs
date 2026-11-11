#!/usr/bin/env node
// Builds the UI preview: the real popup/menu/bar code on top of a Chrome API stub.
//   node dev/preview/build.mjs        -> dev/preview/out
import { copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "../..");
const out = join(here, "out");

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await esbuild.build({
  absWorkingDir: root,
  entryPoints: {
    popup: "dev/preview/popup.entry.ts",
    menu: "dev/preview/menu.entry.ts",
    bar: "dev/preview/bar.entry.ts",
  },
  outdir: out,
  entryNames: "[name]",
  bundle: true,
  format: "esm",
  target: "chrome120",
  sourcemap: "inline",
  logLevel: "warning",
});

copyFileSync(join(root, "src/ui/popup.css"), join(out, "popup.css"));
copyFileSync(join(root, "src/ui/identity-data.json"), join(out, "identity-data.json"));
cpSync(join(root, "src/icons"), join(out, "icons"), { recursive: true });

copyFileSync(join(here, "inline.html"), join(out, "inline.html"));

const shell = readFileSync(join(root, "src/ui/popup.html"), "utf8");
for (const [file, entry, body] of [
  ["index.html", "popup", "<body>"],
  ["menu.html", "menu", '<body class="frame">'],
  ["bar.html", "bar", '<body class="frame">'],
]) {
  // The frames carry html.frame too, as src/ui/menu.html and bar.html do (popup.css keys their sizes on it).
  const html = body.includes("frame") ? '<html lang="en" class="frame">' : '<html lang="en">';
  writeFileSync(join(out, file), shell.replace('<html lang="en">', html).replace("<body>", body).replace("popup.js", `${entry}.js`));
}
console.log(`preview built: ${out}`);
