// CSV exports of other password managers, read by their column names. The layouts are the managers' public export
// formats (a header row); nothing here is copied code. A file qualifies when it has a password column and something that
// names the site or the item. Everything becomes a login (or a secure note), like the Bitwarden CSV importer.
import { parseCsv } from "./csv.ts";

type Json = Record<string, unknown>;
export interface Imported {
  folders: { id: string; name: string }[];
  items: Json[];
}

/** Header names (lower case) each field may appear under. */
const COLUMNS = {
  name: ["name", "title", "item name"],
  url: ["url", "website", "website address", "web site", "login url", "login_uri", "site"],
  username: ["username", "login", "login name", "user name", "user", "login_username"],
  email: ["email", "e-mail"],
  password: ["password", "pwd", "pass", "login_password"],
  notes: ["notes", "note", "extra", "comments", "memo"],
  totp: ["totp", "otpauth", "otp", "one-time password", "totp secret", "login_totp"],
  folder: ["folder", "group", "grouping", "vault", "category"],
  favorite: ["fav", "favorite", "favourite"],
  kind: ["type", "item type", "kind"],
} as const;
type Field = keyof typeof COLUMNS;

/** The column index of each field in `header`. */
function mapColumns(header: string[]): Map<Field, number> {
  const names = header.map((h) => h.trim().toLowerCase());
  const at = (list: readonly string[]) => names.findIndex((n) => list.includes(n));
  const out = new Map<Field, number>();
  for (const f of Object.keys(COLUMNS) as Field[]) {
    const i = at(COLUMNS[f]);
    if (i >= 0) out.set(f, i);
  }
  // A "username" column beats "login" when a file has both.
  const user = names.indexOf("username");
  if (user >= 0) out.set("username", user);
  return out;
}

/** Whether `header` looks like a login export of another manager (used by csvToExport to choose). */
export const isOtherManagerCsv = (header: string[]): boolean => {
  const c = mapColumns(header);
  return c.has("password") && (c.has("url") || c.has("name"));
};

/** A login's host as a name, for exports that have no title column (Firefox). */
const hostName = (url: string): string => URL.parse(url)?.hostname || url;

export function otherCsvToExport(text: string): Imported {
  const [header, ...rows] = parseCsv(text);
  const c = header ? mapColumns(header) : new Map<Field, number>();
  if (!c.has("password") || !(c.has("url") || c.has("name"))) throw new Error("This CSV is not an export Warren knows: it needs a password column and a name or website column");
  const get = (r: string[], f: Field) => (c.has(f) ? (r[c.get(f)!] ?? "").trim() : "");
  const folders = new Map<string, string>();
  const items: Json[] = [];
  for (const r of rows) {
    if (r.every((v) => !v.trim())) continue;
    const kind = get(r, "kind").toLowerCase();
    const url = get(r, "url");
    // LastPass keeps a secure note as a row whose URL is http://sn; others say so in a type column.
    const note = url === "http://sn" || /\bnote\b/.test(kind);
    if (!note && /card|alias|identity|bank|passport|license/.test(kind) && !get(r, "password")) continue;
    const folder = get(r, "folder");
    if (folder && !folders.has(folder)) folders.set(folder, String(folders.size));
    const name = get(r, "name") || (url && url !== "http://sn" ? hostName(url) : "--");
    const common = { name, notes: get(r, "notes") || null, favorite: get(r, "favorite") === "1" || get(r, "favorite").toLowerCase() === "true", reprompt: 0, folderId: folder ? folders.get(folder) : null, fields: [] as unknown[] };
    items.push(
      note
        ? { ...common, type: 2, secureNote: { type: 0 } }
        : { ...common, type: 1, login: { username: get(r, "username") || get(r, "email") || null, password: get(r, "password") || null, totp: get(r, "totp") || null, uris: url ? [{ uri: url, match: null }] : [] } },
    );
  }
  return { folders: [...folders].map(([name, id]) => ({ id, name })), items };
}
