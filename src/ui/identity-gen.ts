// Fake identities for sign-ups that ask for a name and a birthday they have no business knowing. Names and
// cities come from one country (identity-data.json, built by tools/identity-data.mjs from faker's locale
// data), so they fit together. Picks use crypto.getRandomValues, unbiased; nothing here is a secret.

interface CountryData {
  country: string;
  female: string[];
  male: string[];
  last: string[];
  /** Feminine family names where they differ (Polish), in the same order as `last`. */
  lastFemale?: string[];
  cities: string[];
}
/** By ISO country code. */
export type IdentityData = Record<string, CountryData>;

export interface FakeIdentity {
  firstName: string;
  lastName: string;
  /** YYYY-MM-DD */
  birthDate: string;
  age: number;
  username: string;
  city: string;
  country: string;
}

/** An unbiased integer in [0, n). */
function rand(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  do crypto.getRandomValues(buf);
  while (buf[0]! >= limit);
  return buf[0]! % n;
}

const pick = <T>(list: readonly T[]): T => list[rand(list.length)]!;

/** Lower-case ASCII letters for a username: "Çelik" → "celik", "Łukasz" → "lukasz", "Groß" → "gross". */
const ascii = (s: string) =>
  s
    .replace(/[ıİ]/g, "i")
    .replace(/[łŁ]/g, "l")
    .replace(/ß/g, "ss")
    .normalize("NFD")
    .toLowerCase()
    .replace(/[^a-z]/g, "");

/** Whole years from `birth` to `today` (UTC dates). */
export function ageOn(birth: Date, today: Date): number {
  const before = today.getUTCMonth() < birth.getUTCMonth() || (today.getUTCMonth() === birth.getUTCMonth() && today.getUTCDate() < birth.getUTCDate());
  return today.getUTCFullYear() - birth.getUTCFullYear() - (before ? 1 : 0);
}

/** A birth date that makes someone between `minAge` and `maxAge` (either order) today. */
function birthDate(minAge: number, maxAge: number, today: Date): Date {
  const age = Math.min(minAge, maxAge) + rand(Math.abs(maxAge - minAge) + 1);
  // The latest birthday that makes them `age` today; on Feb 29 a non-leap year has the 28th.
  const y = today.getUTCFullYear() - age;
  let latest = new Date(Date.UTC(y, today.getUTCMonth(), today.getUTCDate()));
  if (latest.getUTCMonth() !== today.getUTCMonth()) latest = new Date(Date.UTC(y, today.getUTCMonth() + 1, 0));
  // Up to 364 days earlier: still the same age (a year back would be one more).
  return new Date(latest.getTime() - rand(365) * 86_400_000);
}

/** A person of `code`'s country, or of a random one when `code` is not in `data`. */
export function fakeIdentity(data: IdentityData, code: string, minAge: number, maxAge: number, today = new Date()): FakeIdentity {
  const c = data[code] ?? data[pick(Object.keys(data))]!;
  const female = rand(2) === 0;
  const i = rand(c.last.length);
  const firstName = pick(female ? c.female : c.male);
  const lastName = (female && c.lastFemale?.[i]) || c.last[i]!;
  const birth = birthDate(minAge, maxAge, today);
  return {
    firstName,
    lastName,
    birthDate: birth.toISOString().slice(0, 10),
    age: ageOn(birth, today),
    username: `${ascii(firstName)}.${ascii(lastName)}${String(rand(100)).padStart(2, "0")}`,
    city: pick(c.cities),
    country: c.country,
  };
}
