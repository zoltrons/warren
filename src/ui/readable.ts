// How a shown secret is cut up for reading (colorize in vault-shared.ts draws it; popup.css .pw styles it).

/** A character's class: "d" digit, "s" symbol, "" letter or space. */
export const charKind = (c: string): "d" | "s" | "" => (/\d/.test(c) ? "d" : /[^\p{L}\s]/u.test(c) ? "s" : "");

/**
 * An unbroken value of 8+ characters in groups of four, for reading off and typing in elsewhere; anything else whole.
 * A value with its own breaks (spaces, words joined by - _ .) keeps them rather than get cut across.
 */
export function groupsOf(value: string): string[] {
  const chars = [...value];
  if (chars.length < 8 || /\s|\p{L}{2}[-_.]\p{L}{2}/u.test(value)) return [value];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += 4) out.push(chars.slice(i, i + 4).join(""));
  return out;
}
