#!/usr/bin/env node
// Writes src/ui/identity-data.json for the generator's fake identities: per country, given names (female and
// male), family names and real city names, picked from @faker-js/faker's locale data (MIT, see NOTICE). The
// popup loads the file only when the identity generator opens; faker itself is a dev dependency, not shipped.
//   node tools/identity-data.mjs
import * as F from "@faker-js/faker";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// [code, country, locale with the names, locale with the cities]
const COUNTRIES = [
  ["TR", "Türkiye", F.tr, F.tr],
  ["US", "United States", F.en, F.en],
  ["CA", "Canada", F.en, F.en_CA],
  ["DE", "Germany", F.de, F.de],
  ["AT", "Austria", F.de_AT, F.de_AT],
  ["CH", "Switzerland", F.de_CH, F.de_CH],
  ["FR", "France", F.fr, F.fr],
  ["IT", "Italy", F.it, F.it],
  ["ES", "Spain", F.es, F.es],
  ["PT", "Portugal", F.pt_PT, F.pt_PT],
  ["PL", "Poland", F.pl, F.pl],
];

/** Evenly spread picks: a smaller file without favouring the start of the alphabet. */
const spread = (list, n) => {
  const unique = [...new Set(list)].filter((s) => s && !/[\d()]/.test(s));
  return unique.length <= n ? unique : Array.from({ length: n }, (_, i) => unique[Math.floor((i * unique.length) / n)]);
};
const names = (v) => (Array.isArray(v) ? v : (v.generic ?? Object.values(v).flat()));

const out = {};
for (const [code, country, people, places] of COUNTRIES) {
  const first = people.person.first_name;
  const last = spread(names(people.person.last_name), 150);
  out[code] = {
    country,
    female: spread(first.female, 120),
    male: spread(first.male, 120),
    last,
    // Polish family names take a feminine ending (Kowalski → Kowalska); the locale lists the masculine form.
    ...(code === "PL" ? { lastFemale: last.map((n) => n.replace(/(ski|cki|dzki)$/, (m) => `${m.slice(0, -1)}a`)) } : {}),
    cities: spread(places.location.city_name, 60),
  };
  for (const [k, v] of Object.entries(out[code])) if (Array.isArray(v) && !v.length) throw new Error(`${code}: no ${k}`);
}
writeFileSync(join(root, "src/ui/identity-data.json"), `${JSON.stringify(out)}\n`);
console.log(`identity-data.json: ${Object.keys(out).length} countries`);
