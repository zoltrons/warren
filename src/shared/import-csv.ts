// CSV exports of other password managers, read by their column names. The layouts are the managers' public export
// formats (a header row); nothing here is copied code. A file qualifies when it has a password column and something that
// names the site or the item. Everything becomes a login (or a secure note), like the Bitwarden CSV importer; columns
// without a place of their own become custom fields.
import { parseCsv } from "./csv.ts";

type Json = Record<string, unknown>;
export interface Imported {
  folders: { id: string; name: string }[];
  items: Json[];
  /** Names of the items whose attached files the import cannot carry (KeePass and 1Password files). */
  attachmentsLeft?: string[];
}

/** Header names (lower case) each field may appear under. */
const COLUMNS = {
  name: ["name", "title", "item name"],
  url: ["url", "website", "website address", "web site", "login url", "login_uri", "site"],
  username: ["username", "login", "login name", "user name", "user", "login_username"],
  email: ["email", "e-mail"],
  password: ["password", "pwd", "pass", "login_password"],
  notes: ["notes", "note", "extra", "comments", "memo"],
  totp: ["totp", "otpauth", "otp", "one-time password", "totp secret", "login_totp", "otpsecret"],
  folder: ["folder", "group", "grouping", "vault", "category"],
  favorite: ["fav", "favorite", "favourite"],
  kind: ["type", "item type", "kind"],
} as const;
type Field = keyof typeof COLUMNS;
/** Columns whose value is a secret: their custom field is hidden. */
const SECRET = /pass|secret|cvc|cvv|card.?num|^pin|pin$|security/i;
/** Bookkeeping columns of known exports (Firefox, Proton Pass, KeePassXC, 1Password): not worth a custom field. */
const METADATA = new Set(["httprealm", "formactionorigin", "guid", "timecreated", "timelastused", "timepasswordchanged", "createtime", "modifytime", "last modified", "created", "icon", "archived"]);

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

/** A login's host as a name, for exports that have no title column (Firefox). */
const hostName = (url: string): string => URL.parse(url)?.hostname || url;

export function otherCsvToExport(text: string): Imported {
  const [header, ...rows] = parseCsv(text);
  const c = header ? mapColumns(header) : new Map<Field, number>();
  if (!c.has("password") || !(c.has("url") || c.has("name"))) throw new Error("This CSV is not an export Warren knows: it needs a password column and a name or website column");
  const raw = (r: string[], f: Field) => (c.has(f) ? (r[c.get(f)!] ?? "") : "");
  const get = (r: string[], f: Field) => raw(r, f).trim();
  // A password is kept exactly: a space at either end is part of it.
  const password = (r: string[]) => (raw(r, "password").trim() ? raw(r, "password") : "");
  const folders = new Map<string, string>();
  const items: Json[] = [];
  // Every other column with a value is kept as a custom field: nothing in the file is lost.
  const mapped = new Set(c.values());
  const extra = (header ?? []).flatMap((h, i) => (mapped.has(i) || METADATA.has(h.trim().toLowerCase()) ? [] : [i]));
  const fieldsOf = (r: string[], login: boolean) => {
    const out = extra.filter((i) => (r[i] ?? "").trim()).map((i) => ({ name: header![i]!.trim(), value: r[i]!, type: SECRET.test(header![i]!.trim()) ? 1 : 0 }));
    // An e-mail that is not the username (both columns filled, or a note) would otherwise be dropped.
    const email = get(r, "email");
    if (email && (!login || (get(r, "username") && get(r, "username") !== email))) out.unshift({ name: "email", value: email, type: 0 });
    // A note has no login to hold these: they become its fields (LastPass's http://sn only marks the note).
    if (!login) {
      const url = get(r, "url");
      out.unshift(
        ...(get(r, "username") ? [{ name: "username", value: get(r, "username"), type: 0 }] : []),
        ...(url && url !== "http://sn" ? [{ name: "url", value: url, type: 0 }] : []),
        ...(get(r, "totp") ? [{ name: "totp", value: get(r, "totp"), type: 1 }] : []),
      );
    }
    return out;
  };
  for (const r of rows) {
    if (r.every((v) => !v.trim())) continue;
    const kind = get(r, "kind").toLowerCase();
    const url = get(r, "url");
    // LastPass keeps a secure note as a row whose URL is http://sn; others say so in a type column. A card or
    // identity without a password (NordPass, Proton Pass) is a note too: its columns become its fields.
    const note = url === "http://sn" || /\bnote\b/.test(kind) || (/card|alias|identity|bank|passport|license/.test(kind) && !get(r, "password"));
    const folder = get(r, "folder");
    if (folder && !folders.has(folder)) folders.set(folder, String(folders.size));
    const name = get(r, "name") || (url && url !== "http://sn" ? hostName(url) : "--");
    const common = { name, notes: get(r, "notes") || null, favorite: get(r, "favorite") === "1" || get(r, "favorite").toLowerCase() === "true", reprompt: 0, folderId: folder ? folders.get(folder) : null, fields: fieldsOf(r, !note) };
    items.push(
      note
        ? { ...common, type: 2, secureNote: { type: 0 } }
        : { ...common, type: 1, login: { username: get(r, "username") || get(r, "email") || null, password: password(r) || null, totp: get(r, "totp") || null, uris: url ? [{ uri: url, match: null }] : [] } },
    );
  }
  return { folders: [...folders].map(([name, id]) => ({ id, name })), items };
}
