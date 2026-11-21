// How a shown secret is told apart, character by character (colorize in vault-shared.ts, popup.css .pw).

/** A character's class: "d" digit, "s" symbol, "" letter or space. */
export const charKind = (c: string): "d" | "s" | "" => (/\d/.test(c) ? "d" : /[^\p{L}\s]/u.test(c) ? "s" : "");
