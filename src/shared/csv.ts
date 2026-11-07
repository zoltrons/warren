// Bitwarden's individual CSV format (clients: libs/vault-export, libs/importer bitwarden-csv-importer): logins and
// secure notes only, one row each. Columns as upstream writes them.
export const CSV_COLUMNS = ["folder", "favorite", "type", "name", "notes", "fields", "reprompt", "login_uri", "login_username", "login_password", "login_totp"] as const;

type Json = Record<string, unknown>;
const s = (v: unknown) => (typeof v === "string" ? v : "");
const o = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

/** RFC 4180: quoted fields may hold commas, quotes ("") and line breaks; CRLF or LF ends a row. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (quoted) {
      if (c === '"' && t[i + 1] === '"') (field += '"'), i++;
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") row.push(field), (field = "");
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++;
      row.push(field), rows.push(row), (row = []), (field = "");
    } else field += c;
  }
  if (field !== "" || row.length) row.push(field), rows.push(row);
  return rows.filter((r) => r.some((f) => f !== ""));
}

const quote = (v: string) => (/[",\r\n]/.test(v) || /^\s|\s$/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
export const toCsv = (rows: string[][]): string => rows.map((r) => r.map(quote).join(",")).join("\n");

/** Decrypted items (Bitwarden JSON shape) and folder names to the CSV rows; other item types are left out. */
export function itemsToCsv(items: Json[], folderName: (id: string) => string): { csv: string; skipped: number } {
  const rows: string[][] = [[...CSV_COLUMNS]];
  let skipped = 0;
  for (const item of items) {
    const type = Number(item.type);
    if (type !== 1 && type !== 2) {
      skipped++;
      continue;
    }
    const login = o(item.login);
    const fields = (Array.isArray(item.fields) ? item.fields : []).map(o).filter((f) => Number(f.type) !== 3);
    rows.push([
      folderName(s(item.folderId)),
      item.favorite ? "1" : "",
      type === 1 ? "login" : "note",
      s(item.name),
      s(item.notes),
      fields.map((f) => `${s(f.name)}: ${s(f.value)}`).join("\n"),
      String(Number(item.reprompt) || 0),
      type === 1 ? (Array.isArray(login.uris) ? login.uris : []).map((u) => s(o(u).uri)).filter(Boolean).join(",") : "",
      type === 1 ? s(login.username) : "",
      type === 1 ? s(login.password) : "",
      type === 1 ? s(login.totp) : "",
    ]);
  }
  return { csv: toCsv(rows), skipped };
}

/** A Bitwarden CSV as the JSON export shape prepareImport takes: { folders: [{id, name}], items }. */
export function csvToExport(text: string): { folders: { id: string; name: string }[]; items: Json[] } {
  const [header, ...rows] = parseCsv(text);
  const col = new Map((header ?? []).map((h, i) => [h.trim().toLowerCase(), i]));
  if (!col.has("name") || !col.has("type")) throw new Error("This is not a Bitwarden CSV export (needs at least the name and type columns)");
  const get = (r: string[], k: string) => r[col.get(k) ?? -1] ?? "";
  const folders = new Map<string, string>();
  const items = rows.map((r): Json => {
    const folder = get(r, "folder").trim();
    if (folder && !folders.has(folder)) folders.set(folder, String(folders.size));
    const note = get(r, "type").trim().toLowerCase() === "note";
    const fields = get(r, "fields")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf(": ");
        return at < 0 ? { name: line, value: "", type: 0 } : { name: line.slice(0, at), value: line.slice(at + 2), type: 0 };
      });
    const uris = get(r, "login_uri").split(",").map((u) => u.trim()).filter(Boolean).map((uri) => ({ uri, match: null }));
    return {
      type: note ? 2 : 1,
      name: get(r, "name") || "--",
      notes: get(r, "notes") || null,
      favorite: get(r, "favorite") === "1",
      reprompt: get(r, "reprompt") === "1" ? 1 : 0,
      folderId: folder ? folders.get(folder) : null,
      fields,
      ...(note
        ? { secureNote: { type: 0 } }
        : { login: { username: get(r, "login_username") || null, password: get(r, "login_password") || null, totp: get(r, "login_totp") || null, uris } }),
    };
  });
  return { folders: [...folders].map(([name, id]) => ({ id, name })), items };
}
