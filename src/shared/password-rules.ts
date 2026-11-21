// A site's `passwordrules` attribute (WHATWG proposal, https://github.com/whatwg/html/issues/3518), plus the password
// fields' minlength/maxlength, turned into generator options (crates/core-wasm generator.rs: `sets`, `length`,
// `maxConsecutive`). Page-controlled text: unknown properties and classes are ignored, numbers are bounded.

const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const LOWER = "abcdefghijklmnopqrstuvwxyz";
const DIGIT = "0123456789";
// "special" allows all ASCII punctuation; the generator's own subset is valid for it and easier to type.
const SPECIAL = "!@#$%^&*";
const CLASSES: Record<string, string> = {
  upper: UPPER,
  lower: LOWER,
  digit: DIGIT,
  special: SPECIAL,
  "ascii-printable": UPPER + LOWER + DIGIT + SPECIAL,
  unicode: UPPER + LOWER + DIGIT + SPECIAL,
};

export interface PasswordConstraints {
  rules?: string;
  minLength?: number;
  maxLength?: number;
}

export interface RuleOptions {
  length: number;
  sets?: { chars: string; min: number }[];
  maxConsecutive?: number;
}

/** The characters a `required:` / `allowed:` value names: class names and `[...]` custom classes. */
function classChars(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; ) {
    const c = value[i]!;
    if (c === "[") {
      // `]` right after `[` is a member, not the end (as in the proposal's grammar).
      const end = value.indexOf("]", i + 2);
      out += value.slice(i + 1, end < 0 ? value.length : end);
      i = end < 0 ? value.length : end + 1;
    } else if (c === "," || c === " " || c === "\t") {
      i++;
    } else {
      const m = /^[\w-]+/.exec(value.slice(i));
      if (!m) {
        i++;
        continue;
      }
      out += CLASSES[m[0].toLowerCase()] ?? "";
      i += m[0].length;
    }
  }
  return [...new Set(out)].filter((ch) => ch >= "!" && ch <= "~").join("");
}

const count = (v: string) => (/^\s*\d{1,4}\s*$/.test(v) ? Number(v) : undefined);

/**
 * Options for a password of about `length` characters that the site accepts; undefined when the page sets no
 * constraint (the user's own settings apply unchanged).
 */
export function ruleOptions(c: PasswordConstraints, length: number): RuleOptions | undefined {
  const required: string[] = [];
  let allowed = "";
  let min = c.minLength ?? 0;
  let max = c.maxLength ?? Infinity;
  let maxConsecutive: number | undefined;
  for (const part of (c.rules ?? "").split(";")) {
    const at = part.indexOf(":");
    if (at < 0) continue;
    const name = part.slice(0, at).trim().toLowerCase();
    const value = part.slice(at + 1);
    if (name === "required") {
      const chars = classChars(value);
      if (chars) required.push(chars);
    } else if (name === "allowed") allowed += classChars(value);
    else if (name === "minlength") min = Math.max(min, count(value) ?? 0);
    else if (name === "maxlength") max = Math.min(max, count(value) ?? Infinity);
    else if (name === "max-consecutive") maxConsecutive = count(value) || undefined;
  }
  // A set per required line, then the allowed ones (shortcut: at most 16, the generator's cap; real rules have two to four).
  const sets = [...required.map((chars) => ({ chars, min: 1 })), ...(allowed ? [{ chars: allowed, min: 0 }] : [])].slice(0, 16);
  if (!sets.length && !maxConsecutive && min === 0 && max === Infinity) return undefined;
  const len = Math.max(1, Math.min(Math.max(length, min), max, 128));
  return { length: len, ...(sets.length ? { sets } : {}), ...(maxConsecutive ? { maxConsecutive } : {}) };
}
