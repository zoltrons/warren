// KeePass 2 XML exports (KeePass, KeePassXC, KeeWeb: "Export to XML"). The layout is KeePass's public file format;
// nothing here is copied code. Groups become folders ("Email/Work"), the recycle bin and entry histories are left
// out, and strings beyond the standard five become custom fields (hidden when KeePass protects them).
import type { Imported } from "./import-csv.ts";
import { child, children, parseXml, type XmlNode } from "./xml.ts";

type Json = Record<string, unknown>;

const STANDARD = new Set(["Title", "UserName", "Password", "URL", "Notes"]);
/** KeePassXC keeps the authenticator as an otpauth:// URI under "otp"; older plugins use "TOTP Seed". */
const TOTP_KEYS = ["otp", "TOTP Seed"];

export function keepassXmlToExport(text: string): Imported {
  const file = parseXml(text);
  const root = child(child(file, "Root"), "Group");
  if (file.name !== "KeePassFile" || !root) throw new Error("This is not a KeePass XML export");
  const recycleBin = child(child(file, "Meta"), "RecycleBinUUID")?.text.trim();
  const folders = new Map<string, string>();
  const items: Json[] = [];
  const walk = (group: XmlNode, path: string) => {
    for (const entry of children(group, "Entry")) items.push(item(entry, path ? folderId(folders, path) : null));
    for (const sub of children(group, "Group")) {
      if (recycleBin && child(sub, "UUID")?.text.trim() === recycleBin) continue;
      const name = child(sub, "Name")?.text.trim() || "--";
      walk(sub, path ? `${path}/${name}` : name);
    }
  };
  walk(root, ""); // the root group is the database itself, not a folder
  return { folders: [...folders].map(([name, id]) => ({ id, name })), items };
}

function folderId(folders: Map<string, string>, path: string): string {
  if (!folders.has(path)) folders.set(path, String(folders.size));
  return folders.get(path)!;
}

function item(entry: XmlNode, folder: string | null): Json {
  const strings = new Map<string, { value: string; hidden: boolean }>();
  for (const s of children(entry, "String")) {
    const key = child(s, "Key")?.text ?? "";
    const v = child(s, "Value");
    if (key) strings.set(key, { value: v?.text ?? "", hidden: v?.attrs.ProtectInMemory === "True" || v?.attrs.Protected === "True" });
  }
  const get = (k: string) => strings.get(k)?.value ?? "";
  const totpKey = TOTP_KEYS.find((k) => get(k));
  const fields = [...strings]
    .filter(([k, v]) => !STANDARD.has(k) && k !== totpKey && v.value)
    .map(([name, v]) => ({ name, value: v.value, type: v.hidden ? 1 : 0 }));
  const url = get("URL").trim();
  const common = { name: get("Title") || url || "--", notes: get("Notes") || null, favorite: false, reprompt: 0, folderId: folder, fields };
  // An entry with nothing to sign in with is a note, like the other importers.
  if (!get("UserName") && !get("Password") && !url && !totpKey) return { ...common, type: 2, secureNote: { type: 0 } };
  return {
    ...common,
    type: 1,
    login: { username: get("UserName") || null, password: get("Password") || null, totp: totpKey ? get(totpKey) : null, uris: url ? [{ uri: url, match: null }] : [] },
  };
}
