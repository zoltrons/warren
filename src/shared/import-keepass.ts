// KeePass 2 XML exports (KeePass, KeePassXC, KeeWeb: "Export to XML"). The layout is KeePass's public file format;
// nothing here is copied code. Groups become folders ("Email/Work"), the recycle bin and entry histories are left
// out, strings beyond the standard five become custom fields (hidden when KeePass protects them), and a field
// referencing another entry's ({REF:P@I:...}) gets that entry's value.
import type { Imported } from "./import-csv.ts";
import { child, children, parseXml, type XmlNode } from "./xml.ts";

type Json = Record<string, unknown>;

const STANDARD = new Set(["Title", "UserName", "Password", "URL", "Notes"]);
/** KeePass 2.47+'s secret, in the first encoding the entry has. */
const SECRETS = ["TimeOtp-Secret-Base32", "TimeOtp-Secret-Hex", "TimeOtp-Secret-Base64", "TimeOtp-Secret"];
const HASH: Record<string, string> = { "HMAC-SHA-256": "SHA256", "HMAC-SHA-512": "SHA512", SHA256: "SHA256", SHA512: "SHA512" };

/**
 * The entry's authenticator as Warren stores it (a Base32 secret, or a URI when it is not the default 6 digits every
 * 30 s with SHA-1), and the strings it was read from, which then do not become custom fields. "otp" holds an
 * otpauth:// URI (KeePassXC) or "key=...&size=...&step=..." (the KeeOtp plugin); KeePass 2.47+ keeps a secret under
 * "TimeOtp-Secret[-Hex|-Base32|-Base64]" with "TimeOtp-Length", "-Period" and "-Algorithm"; the KeeTrayTOTP plugin
 * "TOTP Seed" with "TOTP Settings" ("period;digits", digits "S" for Steam). Anything else (an HOTP counter, a
 * secret that does not decode) stays a custom field, as written.
 */
export function keepassTotp(get: (key: string) => string): { totp: string | null; used: string[] } {
  const otp = get("otp").trim();
  if (/^otpauth:\/\//i.test(otp)) return { totp: otp, used: ["otp"] };
  if (otp) {
    const q = new URLSearchParams(otp);
    const key = (q.get("key") ?? "").replace(/\s+/g, "").toUpperCase();
    if (key && (q.get("type") ?? "totp").toLowerCase() === "totp" && (q.get("encoding") ?? "base32").toLowerCase() === "base32")
      return { totp: otpauth(key, q.get("size") || "6", q.get("step") || "30", HASH[(q.get("otpHashMode") ?? "").toUpperCase()] ?? "SHA1"), used: ["otp"] };
  }
  const kp = SECRETS.find((k) => get(k));
  if (kp) {
    const raw = get(kp).replace(/\s+/g, "");
    let secret: string;
    try {
      secret = kp.endsWith("Base32") ? raw.toUpperCase() : base32(kp.endsWith("Hex") ? hexBytes(raw) : kp.endsWith("Base64") ? b64Bytes(raw) : new TextEncoder().encode(get(kp)));
    } catch {
      return { totp: null, used: [] };
    }
    const used = [...SECRETS, "TimeOtp-Length", "TimeOtp-Period", "TimeOtp-Algorithm"].filter((k) => get(k));
    return { totp: otpauth(secret, get("TimeOtp-Length") || "6", get("TimeOtp-Period") || "30", HASH[get("TimeOtp-Algorithm")] ?? "SHA1"), used };
  }
  if (get("TOTP Seed")) {
    const seed = get("TOTP Seed").replace(/\s+/g, "").toUpperCase();
    const [period = "30", digits = "6"] = get("TOTP Settings").split(";").map((x) => x.trim());
    const used = ["TOTP Seed", "TOTP Settings"].filter((k) => get(k));
    return { totp: digits.toUpperCase() === "S" ? `steam://${seed}` : otpauth(seed, digits || "6", period || "30", "SHA1"), used };
  }
  return { totp: null, used: [] };
}

const otpauth = (secret: string, digits: string, period: string, algorithm: string) =>
  digits === "6" && period === "30" && algorithm === "SHA1" ? secret : `otpauth://totp/?secret=${secret}&digits=${encodeURIComponent(digits)}&period=${encodeURIComponent(period)}&algorithm=${algorithm}`;

function base32(bytes: Uint8Array): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let out = "";
  let bits = 0;
  let acc = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    for (; bits >= 5; bits -= 5) out += A[(acc >>> (bits - 5)) & 31];
  }
  return bits ? out + A[(acc << (5 - bits)) & 31] : out;
}
function hexBytes(h: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})+$/i.test(h)) throw new Error("not hex");
  return Uint8Array.from(h.match(/../g)!, (x) => parseInt(x, 16));
}
const b64Bytes = (b: string) => Uint8Array.from(atob(b), (c) => c.charCodeAt(0));

export function keepassXmlToExport(text: string): Imported {
  const file = parseXml(text);
  const root = child(child(file, "Root"), "Group");
  if (file.name !== "KeePassFile" || !root) throw new Error("This is not a KeePass XML export");
  const recycleBin = child(child(file, "Meta"), "RecycleBinUUID")?.text.trim();
  const folders = new Map<string, string>();
  const items: Json[] = [];
  const attachmentsLeft: string[] = [];
  // Every entry by its UUID, the recycle bin's too: a field may reference another entry's ({REF:P@I:<uuid>}).
  const byUuid = new Map<string, XmlNode>();
  const index = (group: XmlNode) => {
    for (const entry of children(group, "Entry")) byUuid.set(uuidHex(child(entry, "UUID")?.text ?? ""), entry);
    children(group, "Group").forEach(index);
  };
  index(root);
  const walk = (group: XmlNode, path: string) => {
    for (const entry of children(group, "Entry")) {
      const it = item(entry, path ? folderId(folders, path) : null, byUuid);
      items.push(it);
      // An import carries no attached files: the user is told which items had them.
      if (children(entry, "Binary").length) attachmentsLeft.push(String(it.name));
    }
    for (const sub of children(group, "Group")) {
      if (recycleBin && child(sub, "UUID")?.text.trim() === recycleBin) continue;
      const name = child(sub, "Name")?.text.trim() || "--";
      walk(sub, path ? `${path}/${name}` : name);
    }
  };
  walk(root, ""); // the root group is the database itself, not a folder
  return { folders: [...folders].map(([name, id]) => ({ id, name })), items, attachmentsLeft };
}

function folderId(folders: Map<string, string>, path: string): string {
  if (!folders.has(path)) folders.set(path, String(folders.size));
  return folders.get(path)!;
}

function stringsOf(entry: XmlNode): Map<string, { value: string; hidden: boolean }> {
  const strings = new Map<string, { value: string; hidden: boolean }>();
  for (const s of children(entry, "String")) {
    const key = child(s, "Key")?.text ?? "";
    const v = child(s, "Value");
    if (key) strings.set(key, { value: v?.text ?? "", hidden: v?.attrs.ProtectInMemory === "True" || v?.attrs.Protected === "True" });
  }
  return strings;
}

/** KeePass's UUIDs are Base64 in the XML and hex in a reference. */
function uuidHex(b64: string): string {
  try {
    return Array.from(atob(b64.trim()), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  } catch {
    return "";
  }
}

const REF_FIELD: Record<string, string> = { T: "Title", U: "UserName", P: "Password", A: "URL", N: "Notes" };

/** `value` with its references to another entry's field by UUID filled in, up to a few levels deep, and whether one
 * of them was secret (a password or a protected string), so the field stays hidden. Other kinds (search by title,
 * ...) and a reference to nothing stay as written. */
function resolveRefs(value: string, byUuid: Map<string, XmlNode>, depth = 0): { value: string; hidden: boolean } {
  let hidden = false;
  if (depth > 4 || !value.includes("{REF:")) return { value, hidden };
  const out = value.replace(/\{REF:([TUPAN])@I:([0-9a-f]{32})\}/gi, (ref, field: string, uuid: string) => {
    const target = byUuid.get(uuid.toLowerCase());
    const hit = target && stringsOf(target).get(REF_FIELD[field.toUpperCase()]!);
    if (!hit) return ref;
    const r = resolveRefs(hit.value, byUuid, depth + 1);
    hidden ||= field.toUpperCase() === "P" || hit.hidden || r.hidden;
    return r.value;
  });
  return { value: out, hidden };
}

function item(entry: XmlNode, folder: string | null, byUuid: Map<string, XmlNode>): Json {
  const strings = stringsOf(entry);
  for (const v of strings.values()) {
    const r = resolveRefs(v.value, byUuid);
    v.value = r.value;
    v.hidden ||= r.hidden;
  }
  const get = (k: string) => strings.get(k)?.value ?? "";
  const { totp, used } = keepassTotp(get);
  const fields = [...strings]
    .filter(([k, v]) => !STANDARD.has(k) && !used.includes(k) && v.value)
    .map(([name, v]) => ({ name, value: v.value, type: v.hidden ? 1 : 0 }));
  const url = get("URL").trim();
  const common = { name: get("Title") || url || "--", notes: get("Notes") || null, favorite: false, reprompt: 0, folderId: folder, fields };
  // An entry with nothing to sign in with is a note, like the other importers.
  if (!get("UserName") && !get("Password") && !url && !totp) return { ...common, type: 2, secureNote: { type: 0 } };
  return {
    ...common,
    type: 1,
    login: { username: get("UserName") || null, password: get("Password") || null, totp, uris: url ? [{ uri: url, match: null }] : [] },
  };
}
