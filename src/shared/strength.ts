// The words the most-breached passwords are built on: "Password123!" is one of them, whatever its length and classes say.
const COMMON = new Set(
  "password passwort parola sifre qwerty qwertz qwertyuiop azerty asdfgh asdfghjkl zxcvbn zxcvbnm qazwsx iloveyou admin administrator root welcome letmein login master monkey dragon sunshine princess football baseball superman batman shadow michael jordan trustno starwars hello freedom whatever secret summer winter abc abcd abcdef test guest changeme default pass passw".split(" "),
);

/**
 * Rough password strength 0..3 (weak, fair, strong, very strong) from length and character classes.
 * shortcut: a few dozen base words, not a dictionary; use zxcvbn-style matching if "strong" has to mean more.
 */
export function passwordLevel(pw: string): 0 | 1 | 2 | 3 {
  if (COMMON.has(pw.toLowerCase().replace(/[^a-z]/g, ""))) return 0;
  const pool = [/[a-z]/, /[A-Z]/, /\d/, /[^a-zA-Z\d]/].reduce((n, re, i) => n + (re.test(pw) ? [26, 26, 10, 33][i]! : 0), 0);
  const bits = pw.length * Math.log2(Math.max(pool, 2));
  return bits < 40 ? 0 : bits < 60 ? 1 : bits < 80 ? 2 : 3;
}
