// Vault search language: words, "quoted phrases", -exclusions and `qualifier:value` (title, username, url, ...).
// Only the qualifiers below are special, so a query like `https://github` is still plain text.

const FIELDS = ["title", "name", "username", "email", "url", "domain", "host", "folder", "type", "is"] as const;
type Field = (typeof FIELDS)[number];

export interface Clause {
  not: boolean;
  field?: Field;
  value: string;
}

/** What a clause can look at, already passed through `folded` (once per list, not once per keystroke). */
export interface Searchable {
  name: string;
  sub: string;
  uris: string[];
  folder: string;
  /** Names the type answers to (localised and English). */
  type: string[];
  flags: string[];
}

const TOKEN = /(-?)(?:([a-z]+):)?(?:"([^"]*)"|(\S+))/gi;

/**
 * Case-, accent- and dotted/dotless-i-blind form of a text for matching: "Zürich" and "zurich", "İstanbul" and
 * "istanbul", "KILIT" and "kılıt" all meet. NFD first, so "İ" splits into "I" plus a mark that is then dropped.
 */
export const fold = (s: string): string => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ı/g, "i");

/** An item's search text folded, for matchesQuery. */
export const folded = (i: Searchable): Searchable => ({ ...i, name: fold(i.name), sub: fold(i.sub), uris: i.uris.map(fold), folder: fold(i.folder), type: i.type.map(fold) });

export function parseQuery(query: string): Clause[] {
  const out: Clause[] = [];
  for (const m of query.matchAll(TOKEN)) {
    const field = m[2]?.toLowerCase() as Field | undefined;
    const known = field !== undefined && FIELDS.includes(field);
    const value = fold(m[3] ?? m[4] ?? "");
    // An unknown "word:" prefix belongs to the text (a URL scheme, a time like 10:30, ...).
    const text = known ? value : fold(`${m[2] ? `${m[2]}:` : ""}${m[3] ?? m[4] ?? ""}`);
    if (!text) continue;
    out.push({ not: m[1] === "-", ...(known ? { field } : {}), value: text });
  }
  return out;
}

const hostOf = (u: string): string => {
  try {
    return new URL(/^[a-z][\w+.-]*:/i.test(u) ? u : `https://${u}`).hostname.toLowerCase();
  } catch {
    return "";
  }
};

function clauseMatches(c: Clause, i: Searchable): boolean {
  const has = (s: string) => s.includes(c.value);
  switch (c.field) {
    case "title":
    case "name":
      return has(i.name);
    case "username":
      return has(i.sub);
    case "email":
      return i.sub.includes("@") && has(i.sub);
    case "url":
      return i.uris.some(has);
    case "domain":
    case "host":
      return i.uris.some((u) => hostOf(u).includes(c.value));
    case "folder":
      return has(i.folder);
    case "type":
      return i.type.some((n) => n.startsWith(c.value));
    case "is":
      return i.flags.includes(c.value);
    default:
      return [i.name, i.sub, ...i.uris].some(has);
  }
}

/** Every positive clause must match and no excluded clause may. */
export const matchesQuery = (clauses: Clause[], item: Searchable): boolean => clauses.every((c) => clauseMatches(c, item) !== c.not);

/**
 * Search results, best first: the name starting with the query, then a word of the name starting with it, then the
 * name containing it, then the rest (a username or website match). Ties keep the chosen sort order.
 */
export function byRelevance<T extends { name: string }>(items: T[], query: string): T[] {
  const q = fold(query.trim());
  const rank = (name: string) => {
    const n = fold(name);
    return n.startsWith(q) ? 0 : n.split(/[^\p{L}\p{N}]+/u).some((w) => w.startsWith(q)) ? 1 : n.includes(q) ? 2 : 3;
  };
  return items.map((i, at) => ({ i, at, r: rank(i.name) })).sort((a, b) => a.r - b.r || a.at - b.at).map((x) => x.i);
}
