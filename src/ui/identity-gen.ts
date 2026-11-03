// Fake identities for sign-ups that ask for a name and a birthday they have no business knowing.
// Random picks (crypto.getRandomValues, unbiased) from short built-in lists; nothing here is a secret.

const FIRST = [
  "Ada", "Alex", "Amelia", "Arda", "Aylin", "Baran", "Bora", "Can", "Clara", "Daniel", "Defne", "Deniz", "Derin", "Ece",
  "Efe", "Elif", "Emma", "Emre", "Eren", "Eva", "Felix", "Hannah", "Henry", "Ilgaz", "Ipek", "Jonas", "Julia", "Kaan",
  "Kerem", "Lara", "Leo", "Lina", "Lucas", "Maya", "Mert", "Mia", "Nehir", "Nora", "Oliver", "Oscar", "Ozan", "Selin",
  "Sofia", "Tuna", "Yaren", "Zeynep",
] as const;
const LAST = [
  "Acar", "Akın", "Aksoy", "Arslan", "Aydın", "Baker", "Bauer", "Berg", "Çelik", "Coleman", "Demir", "Doğan", "Ellis",
  "Erdem", "Fischer", "Foster", "Güneş", "Hansen", "Hayes", "Kaya", "Keller", "Koç", "Kurt", "Lambert", "Moreau",
  "Novak", "Öztürk", "Parker", "Reed", "Şahin", "Silva", "Taylor", "Tekin", "Vogel", "Walsh", "Yıldız", "Yılmaz",
] as const;
const PLACES = [
  ["Istanbul", "Türkiye"], ["Ankara", "Türkiye"], ["Izmir", "Türkiye"], ["Eskişehir", "Türkiye"], ["Berlin", "Germany"],
  ["Hamburg", "Germany"], ["Amsterdam", "Netherlands"], ["Lisbon", "Portugal"], ["Dublin", "Ireland"],
  ["Toronto", "Canada"], ["Melbourne", "Australia"], ["Austin", "United States"],
] as const;

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

/** Lower-case ASCII for a username: "Çelik" → "celik", "Yıldız" → "yildiz". */
const ascii = (s: string) => s.replace(/ı/g, "i").replace(/İ/g, "I").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** Whole years from `birth` to `today` (UTC dates). */
export function ageOn(birth: Date, today: Date): number {
  const before = today.getUTCMonth() < birth.getUTCMonth() || (today.getUTCMonth() === birth.getUTCMonth() && today.getUTCDate() < birth.getUTCDate());
  return today.getUTCFullYear() - birth.getUTCFullYear() - (before ? 1 : 0);
}

/** Someone between `minAge` and `maxAge` years old today (either order). */
export function fakeIdentity(minAge: number, maxAge: number, today = new Date()): FakeIdentity {
  const lo = Math.min(minAge, maxAge);
  const age = lo + rand(Math.abs(maxAge - minAge) + 1);
  // The latest birthday that makes them `age` today; on Feb 29 a non-leap year has the 28th.
  const y = today.getUTCFullYear() - age;
  let latest = new Date(Date.UTC(y, today.getUTCMonth(), today.getUTCDate()));
  if (latest.getUTCMonth() !== today.getUTCMonth()) latest = new Date(Date.UTC(y, today.getUTCMonth() + 1, 0));
  // Up to 364 days earlier: still the same age (a year back would be one more).
  const birth = new Date(latest.getTime() - rand(365) * 86_400_000);
  const firstName = pick(FIRST);
  const lastName = pick(LAST);
  const [city, country] = pick(PLACES);
  return {
    firstName,
    lastName,
    birthDate: birth.toISOString().slice(0, 10),
    age: ageOn(birth, today),
    username: `${ascii(firstName)}.${ascii(lastName)}${String(rand(100)).padStart(2, "0")}`,
    city,
    country,
  };
}
