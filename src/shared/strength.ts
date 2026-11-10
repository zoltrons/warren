// The words the most-breached passwords are built on: "Password123!" is one of them, whatever its length and classes say.
const COMMON = new Set(
  "password passwort parola sifre qwerty qwertz qwertyuiop azerty asdfgh asdfghjkl zxcvbn zxcvbnm qazwsx iloveyou admin administrator root welcome letmein login master monkey dragon sunshine princess football baseball superman batman shadow michael jordan trustno starwars hello freedom whatever secret summer winter abc abcd abcdef test guest changeme default pass passw".split(" "),
);

let full: Promise<void> | undefined;

/**
 * Adds the base words of the 10 000 most common passwords (common-words.json, tools/common-words.mjs) to the check.
 * Until it has loaded, or if it cannot load, the built-in list above is used.
 */
export function loadCommonWords(): Promise<void> {
  return (full ??= fetch(new URL("common-words.json", import.meta.url))
    .then((r) => r.json() as Promise<string[]>)
    .then((words) => void words.forEach((w) => COMMON.add(w)))
    .catch(() => void (full = undefined)));
}

/**
 * Rough password strength 0..3 (weak, fair, strong, very strong) from length, character classes and common base words.
 * shortcut: whole base words only (no leet, keyboard walks, dates or word pairs); use zxcvbn-style matching if "strong"
 * has to mean more.
 */
export function passwordLevel(pw: string): 0 | 1 | 2 | 3 {
  if (COMMON.has(pw.toLowerCase().replace(/[^a-z]/g, ""))) return 0;
  const pool = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].reduce((n, re, i) => n + (re.test(pw) ? [26, 26, 10, 33][i]! : 0), 0);
  const bits = pw.length * Math.log2(Math.max(pool, 2));
  return bits < 40 ? 0 : bits < 60 ? 1 : bits < 80 ? 2 : 3;
}
