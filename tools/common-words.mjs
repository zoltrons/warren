#!/usr/bin/env node
// Writes src/shared/common-words.json for the strength check: the letters-only base words (4+ letters) of SecLists'
// 10 000 most common passwords (MIT, see NOTICE), pinned to one commit so a rebuild gives the same file.
//   node tools/common-words.mjs
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const COMMIT = "913b327317496d062bcc7cace524aaad8a693be2";
const url = `https://raw.githubusercontent.com/danielmiessler/SecLists/${COMMIT}/Passwords/Common-Credentials/10k-most-common.txt`;
const res = await fetch(url);
if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
// Same normalization as passwordLevel: lowercase, letters only.
const words = [...new Set((await res.text()).split("\n").map((l) => l.toLowerCase().replace(/[^a-z]/g, "")))].filter((w) => w.length >= 4).sort();
if (words.length < 5000) throw new Error(`only ${words.length} words: the list changed shape`);
const out = join(dirname(fileURLToPath(import.meta.url)), "..", "src/shared/common-words.json");
writeFileSync(out, JSON.stringify(words) + "\n");
console.log(`${words.length} words -> ${out}`);
