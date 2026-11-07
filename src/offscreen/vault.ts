// Decrypted vault held in the crypto worker's memory. Dropped when the worker is terminated (lock).
import * as core from "../../dist/wasm/core_wasm.js";
import type { Collection, Folder, KdfParams, PasskeyCandidate, SendItem, VaultItem, VaultList } from "../shared/messages.ts";
import { csvToExport, itemsToCsv } from "../shared/csv.ts";
import { cardBrand } from "../shared/card.ts";
import { linkedValue } from "../shared/linked-fields.ts";
import { passwordLevel } from "../shared/strength.ts";
import { asObject as o, asString as s, ci } from "../shared/validate.ts";
import { Psl, uriMatches } from "../autofill/match.ts";
import { b64u } from "../shared/url.ts";
import * as fido2 from "./fido2.ts";
import { restorePasskeyKeys, withoutPasskeyKeys } from "./passkey-keys.ts";

type Json = Record<string, unknown>;

let ciphers: Map<string, Json> | undefined;
let folders: Folder[] = [];
/** Folders that did not decrypt: the list goes on without them, an export does not (see exportJson). */
let brokenFolders = 0;
let collections: Collection[] = [];
let organizations: Folder[] = [];
let sends = new Map<string, Json>();


/** Trashed items: shown only in the trash view, never matched or filled. */
let trash = new Map<string, Json>();

function put(c: Json): void {
  const id = s(ci(c, "id"));
  ciphers!.delete(id);
  trash.delete(id);
  (ci(c, "deletedDate") ? trash : ciphers!).set(id, c);
}

export function loadVault(encCiphers: unknown[], encFolders: unknown[], encSends: unknown[], orgKeys: Record<string, string>, encCollections: unknown[], orgs: Folder[]): void {
  // Organization keys are an extra: a key we cannot open (or an account without an RSA private key)
  // must leave the personal vault usable. Items under it are reported as undecryptable instead.
  if (Object.keys(orgKeys).length) {
    try {
      core.setOrgKeys(JSON.stringify(orgKeys));
    } catch {
      /* org items end up in `failed` below, everything else still decrypts */
    }
  }
  const r = JSON.parse(core.decryptCipherList(JSON.stringify(encCiphers))) as { ciphers: Json[]; failed: { id: string }[] };
  ciphers = new Map();
  trash = new Map();
  for (const c of r.ciphers) put(c);
  // Keep undecryptable items visible instead of silently hiding them.
  // `personal`: a live personal item, which an export must not leave out without saying so.
  const enc = new Map((encCiphers as Json[]).map((c) => [s(ci(c, "id")), c]));
  for (const f of r.failed) {
    const c = enc.get(f.id);
    ciphers.set(f.id, { id: f.id, type: 0, name: "", failed: true, personal: !ci(c, "organizationId") && !ci(c, "deletedDate") });
  }
  const fr = JSON.parse(core.decryptFolders(JSON.stringify(encFolders))) as { folders: Json[]; failed: unknown[] };
  brokenFolders = fr.failed.length;
  const sr = JSON.parse(core.decryptSendList(JSON.stringify(encSends))) as { sends: Json[]; failed: { id: string }[] };
  sends = new Map([...sr.sends, ...sr.failed.map((f) => ({ id: f.id, failed: true }))].map((x) => [s(ci(x, "id")), x]));
  const named = (r: { folders: Json[] }) => r.folders.map((f) => ({ id: s(ci(f, "id")), name: s(ci(f, "name")) })).sort((a, b) => a.name.localeCompare(b.name));
  folders = named(fr);
  // Collection names use their organization's key (decryptFolders picks it by organizationId).
  const decrypted = (JSON.parse(core.decryptFolders(JSON.stringify(encCollections))) as { folders: Json[] }).folders;
  const byId = new Map(decrypted.map((c) => [s(ci(c, "id")), c]));
  collections = named({ folders: decrypted }).map((c) => ({ ...c, organizationId: s(ci(byId.get(c.id), "organizationId")), readOnly: ci(byId.get(c.id), "readOnly") === true }));
  organizations = orgs;
}

export function upsertCipher(enc: Json): void {
  if (!ciphers) throw new Error("vault not loaded");
  put(JSON.parse(core.decryptCipher(JSON.stringify(enc))) as Json);
}

export const loaded = (): boolean => ciphers !== undefined;

function summary(c: Json): VaultItem {
  const type = Number(ci(c, "type"));
  const login = o(ci(c, "login"));
  const sub =
    type === 1 ? s(ci(login, "username"))
    : type === 3 ? s(ci(o(ci(c, "card")), "cardholderName"))
    : type === 4 ? [ci(o(ci(c, "identity")), "firstName"), ci(o(ci(c, "identity")), "lastName")].map(s).join(" ").trim()
    : type === 5 ? s(ci(o(ci(c, "sshKey")), "keyFingerprint"))
    : "";
  const uris = (Array.isArray(ci(login, "uris")) ? (ci(login, "uris") as unknown[]) : []).map((u) => s(ci(u, "uri"))).filter(Boolean);
  const time = (v: unknown) => {
    const n = Date.parse(s(v));
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    id: s(ci(c, "id")),
    type,
    name: s(ci(c, "name")),
    sub,
    uris,
    folderId: s(ci(c, "folderId")) || undefined,
    favorite: ci(c, "favorite") === true,
    readOnly: ci(c, "edit") === false,
    hasTotp: !!s(ci(login, "totp")),
    ...(type === 1 && !s(ci(login, "password")) ? { noPassword: true } : {}),
    ...(Array.isArray(ci(login, "fido2Credentials")) && (ci(login, "fido2Credentials") as unknown[]).length ? { hasPasskey: true } : {}),
    ...(Number(ci(c, "reprompt")) === 1 ? { reprompt: true } : {}),
    ...(typeof ci(login, "autofillOnPageLoad") === "boolean" ? { autofillOnPageLoad: ci(login, "autofillOnPageLoad") as boolean } : {}),
    revisionDate: time(ci(c, "revisionDate")),
    creationDate: time(ci(c, "creationDate")),
    ...(type === 3 ? { brand: s(ci(o(ci(c, "card")), "brand")) || cardBrand(s(ci(o(ci(c, "card")), "number"))) } : {}),
    ...(c.failed ? { failed: true } : {}),
  };
}

export function listVault(): VaultList | null {
  if (!ciphers) return null;
  const sorted = (m: Map<string, Json>) => [...m.values()].map(summary).sort((a, b) => a.name.localeCompare(b.name));
  // Reuse and weakness are worked out here so the list can flag them without ever receiving a password.
  const passwordOf = (c: Json) => (Number(ci(c, "type")) === 1 ? s(ci(o(ci(c, "login")), "password")) : "");
  const uses = new Map<string, number>();
  for (const c of ciphers.values()) uses.set(passwordOf(c), (uses.get(passwordOf(c)) ?? 0) + 1);
  const items = [...ciphers.values()]
    .map((c) => {
      const pw = passwordOf(c);
      const item = summary(c);
      if (!pw) return item;
      return { ...item, ...(uses.get(pw)! > 1 ? { reused: uses.get(pw)! } : {}), ...(passwordLevel(pw) === 0 ? { weak: true } : {}) };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  return { items, folders, trash: sorted(trash), organizations, collections };
}

function get(id: string): Json {
  const c = ciphers?.get(id) ?? trash.get(id);
  if (!c) throw new Error("item not found");
  return c;
}

/** An item that may be filled or signed with: never one in the trash. */
function live(id: string): Json {
  const c = ciphers?.get(id);
  if (!c) throw new Error("item not found");
  return c;
}

/**
 * Full decrypted item for the item view / edit form, minus each passkey's private key: nothing outside this worker
 * signs, so it never leaves. prepareSave puts it back from the worker's copy.
 */
export const getCipher = (id: string): Json => withoutPasskeyKeys(get(id));

export const cipherSummary = (id: string): VaultItem => summary(get(id));

/**
 * Encrypts an edited/new personal Login or Note. Mirrors the official clients: a changed password is
 * pushed to passwordHistory (max 5), and edits carry lastKnownRevisionDate so the server refuses
 * to overwrite a newer copy.
 */
export function prepareSave(input: Json): Json {
  const id = s(input.id);
  const existing = id ? get(id) : undefined;
  const item = restorePasskeyKeys(input, existing);
  if (existing && summary(existing).readOnly) throw new Error("item is read-only");
  // An edit never moves an item between vaults (that is prepareShare). A new one may be created in an organization
  // the user can add to (the server checks the collections).
  if (existing) item.organizationId = ci(existing, "organizationId") ?? null;
  else if (ci(item, "organizationId") && !collections.some((c) => c.organizationId === ci(item, "organizationId") && !c.readOnly))
    throw new Error("You cannot add items to this organization");
  if (existing && Number(item.type) === 1) {
    const oldPw = s(ci(o(ci(existing, "login")), "password"));
    const login = o(item.login);
    if (login && oldPw && oldPw !== s(login.password)) {
      const now = new Date().toISOString();
      const history = Array.isArray(ci(existing, "passwordHistory")) ? (ci(existing, "passwordHistory") as unknown[]) : [];
      item.passwordHistory = [{ password: oldPw, lastUsedDate: now }, ...history].slice(0, 5);
      login.passwordRevisionDate = now;
    }
  }
  // A new item (also a clone or a passkey's new login) gets its own key, which binds its URIs to it (cipher.rs).
  const enc = JSON.parse(core.encryptCipher(JSON.stringify(item), !existing)) as Json;
  // The revision the draft was read at, not the worker's: a sync since then must make the server refuse a stale draft.
  if (existing) enc.lastKnownRevisionDate = ci(item, "revisionDate") ?? ci(existing, "revisionDate");
  return enc;
}

/** A personal item, encrypted for organization `orgId` (its own key re-wrapped), for PUT /ciphers/{id}/share. */
export function prepareShare(id: string, orgId: string): Json {
  const c = get(id);
  if (ci(c, "organizationId")) throw new Error("The item already belongs to an organization");
  if (!organizations.some((o) => o.id === orgId)) throw new Error("Unknown organization");
  // The worker's own copy: it still holds the passkey private keys the popup never sees.
  const enc = JSON.parse(core.moveCipherToOrg(JSON.stringify(c), orgId)) as Json;
  enc.lastKnownRevisionDate = ci(c, "revisionDate");
  return enc;
}

/**
 * Any text sealed with the user key: folder names, and every `encryptText` caller (seal.ts: PIN, private records,
 * generator history). Never give it an item key: nothing would store that key, and the text could not be read again.
 */
export const encryptName = (name: string): string => s(o(JSON.parse(core.encryptCipher(JSON.stringify({ type: 2, name }), false)))?.name);

/**
 * Save bar: the item with a new password, encrypted for the server, as of the revision the prompt was made for. A
 * copy that changed since (a sync, an edit elsewhere) is not overwritten, here or on the server (lastKnownRevisionDate).
 */
export function preparePassword(id: string, password: string, revisionDate: number | undefined): Json {
  const item = getCipher(id);
  if (summary(item).revisionDate !== revisionDate) throw new Error("This login changed after the prompt was shown, so nothing was saved");
  return prepareSave({ ...item, login: { ...o(item.login), password } });
}

/** The current code, and the next one so a code about to expire is not a race. */
export function totp(id: string): { code: string; next: string; period: number; remaining: number } {
  const secret = s(ci(o(ci(get(id), "login")), "totp"));
  if (!secret) throw new Error("item has no TOTP");
  const now = Date.now();
  const cur = JSON.parse(core.totp(secret, now)) as { code: string; period: number; remaining: number };
  // remaining is in whole seconds to the boundary, so this lands inside the next period.
  return { ...cur, next: (JSON.parse(core.totp(secret, now + cur.remaining * 1000)) as { code: string }).code };
}

const gen = (options: Json) => core.generatePassword(JSON.stringify(options));
/** `n` random characters from a-z0-9 (or 0-9), from the core CSPRNG generator (minimum length 5). */
const randomChars = (n: number, digitsOnly = false) =>
  gen({ length: Math.max(n, 5), lowercase: !digitsOnly, uppercase: false, numbers: true, special: false, minNumber: 0 }).slice(0, n);

/** Uniform integer in `0..n` (rejection sampling, no modulo bias). */
function randBelow(n: number): number {
  const zone = 2 ** 32 - (2 ** 32 % n);
  const b = new Uint32Array(1);
  do crypto.getRandomValues(b);
  while (b[0]! >= zone);
  return b[0]! % n;
}

/** A passphrase from the user's own list (core only knows the EFF list). */
function customPassphrase(o: Json, words: string[]): string {
  const n = Math.min(Math.max(Number(o.numWords) || 5, 3), 20);
  const picked = Array.from({ length: n }, () => words[randBelow(words.length)]!);
  const cased = o.capitalize === true ? picked.map((w) => w.charAt(0).toUpperCase() + w.slice(1)) : picked;
  if (o.includeNumber === true) cased[randBelow(n)] += String(randBelow(10));
  return cased.join(s(o.wordSeparator));
}

/** Passwords and passphrases come from core; PINs and usernames (word / plus / catch-all / subdomain) are built on it. */
export function generate(o: Json): string {
  if (o.type === "pin") return randomChars(Math.min(Math.max(Number(o.length) || 4, 3), 12), true);
  if (o.type === "passphrase" && Array.isArray(o.wordlist) && o.wordlist.length >= 100) return customPassphrase(o, o.wordlist.filter((w): w is string => typeof w === "string" && !!w));
  if (o.type !== "username") return gen(o);
  if (o.usernameType === "subdomain") {
    const email = s(o.email).trim();
    const at = email.lastIndexOf("@");
    if (at < 1 || at === email.length - 1) throw new Error("Enter an email address");
    return `${email.slice(0, at)}@${randomChars(8)}.${email.slice(at + 1)}`;
  }
  if (o.usernameType === "plus") {
    const email = s(o.email).trim();
    const at = email.lastIndexOf("@");
    if (at < 1 || at === email.length - 1) throw new Error("Enter an email address");
    return `${email.slice(0, at)}+${randomChars(8)}${email.slice(at)}`;
  }
  if (o.usernameType === "catchall") {
    const domain = s(o.domain).trim().replace(/^@/, "");
    if (!domain) throw new Error("Enter a domain");
    return `${randomChars(8)}@${domain}`;
  }
  // Space never occurs in the EFF word list, so the first word comes out whole.
  const word = gen({ type: "passphrase", numWords: 3, wordSeparator: " ", capitalize: o.capitalize === true }).split(" ")[0]!;
  return o.includeNumber === true ? word + randomChars(4, true) : word;
}

let psl: Psl | undefined;

// Loaded on first use only: ~170 KB of rules that the worker otherwise never needs.
async function getPsl(): Promise<Psl> {
  psl ??= new Psl((await (await fetch(new URL("psl.json", import.meta.url))).json()) as string[]);
  return psl;
}

/** Personal and org logins whose URIs match `url`; `defaultMatch` applies to URIs without one. */
export async function matchUri(url: string, defaultMatch: number): Promise<VaultItem[]> {
  if (!ciphers) throw new Error("vault not loaded");
  await getPsl();
  const page = new URL(url);
  return [...ciphers.values()]
    .filter((c) => Number(ci(c, "type")) === 1)
    .filter((c) => {
      const uris = ci(o(ci(c, "login")), "uris");
      return Array.isArray(uris) && uris.some((u) => uriMatches(s(ci(u, "uri")), ci(u, "match") as number | null, page, psl!, defaultMatch, core.regexTest));
    })
    .map(summary)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** User-key strings (a failed one comes back empty). */
export function decryptText(values: string[]): string[] {
  const r = JSON.parse(core.decryptFolders(JSON.stringify(values.map((name, i) => ({ id: String(i), name }))))) as { folders: Json[] };
  const plain = new Map(r.folders.map((f) => [s(ci(f, "id")), s(ci(f, "name"))]));
  return values.map((_, i) => plain.get(String(i)) ?? "");
}

/** `totp` is the current code, for copying after the fill. */
export function fillData(id: string): { username: string; password: string; totp?: string } {
  const login = o(ci(live(id), "login"));
  const secret = s(ci(login, "totp"));
  return { username: s(ci(login, "username")), password: s(ci(login, "password")), ...(secret ? { totp: JSON.parse(core.totp(secret, Date.now())).code as string } : {}) };
}

/** An unsaved item editor, while the user picks a field on the page (background/picker.ts). */
let stashedDraft: string | undefined;

export function stashDraft(draft: string): void {
  stashedDraft = draft;
}

export function takeDraft(): string | null {
  const draft = stashedDraft ?? null;
  stashedDraft = undefined;
  return draft;
}

const LINKED_OBJECT: Record<number, string> = { 1: "login", 3: "card", 4: "identity" };

/** The item's custom fields as a fill uses them, in order: an empty name matches nothing and keeps its place. */
export function customFieldValues(id: string): { name: string; value: string }[] {
  const c = live(id);
  const type = Number(ci(c, "type"));
  const fields = ci(c, "fields");
  return (Array.isArray(fields) ? (fields as Json[]) : []).map((f) => {
    const kind = Number(ci(f, "type"));
    const value = kind === 3 ? linkedValue(type, ci(f, "linkedId"), o(ci(c, LINKED_OBJECT[type] ?? ""))) : s(ci(f, "value")) || (kind === 2 ? "false" : "");
    return { name: s(ci(f, "name")), value };
  });
}

// ---------- Import / export (Bitwarden's unencrypted JSON format) ----------

const EXPORT_KEYS = ["id", "folderId", "type", "reprompt", "name", "notes", "favorite", "login", "secureNote", "card", "identity", "sshKey", "bankAccount", "driversLicense", "passport", "fields", "passwordHistory", "revisionDate", "creationDate"];

/**
 * Personal items (not the trash, not organization items) and folders, like the official individual export: Bitwarden
 * JSON, CSV (logins and notes only, like upstream), or JSON protected by a file password.
 */
export function exportVault(format: "json" | "csv" | "encrypted", password?: string, kdf?: KdfParams): string {
  const plain = exportJson();
  if (format === "json") return plain;
  if (format === "csv") {
    const data = JSON.parse(plain) as { folders: Folder[]; items: Json[] };
    return itemsToCsv(data.items, (id) => data.folders.find((f) => f.id === id)?.name ?? "").csv;
  }
  if (!password || !kdf) throw new Error("A file password is needed");
  return core.passwordProtectExport(plain, password, kdf.type, kdf.iterations, kdf.memory, kdf.parallelism);
}

function exportJson(): string {
  if (!ciphers) throw new Error("vault not loaded");
  const broken = [...ciphers.values()].filter((c) => c.failed && c.personal).length;
  if (broken) throw new Error(`${broken} item(s) could not be decrypted, so the export would be incomplete. Nothing was exported.`);
  // Items would keep a folderId the export has no folder for: the backup would lose names and grouping.
  if (brokenFolders) throw new Error(`${brokenFolders} folder(s) could not be decrypted, so the export would be incomplete. Nothing was exported.`);
  const items = [...ciphers.values()]
    .filter((c) => !c.failed && !ci(c, "organizationId"))
    .map((c) => ({ ...Object.fromEntries(EXPORT_KEYS.map((k) => [k, ci(c, k) ?? null])), organizationId: null, collectionIds: null, deletedDate: null }));
  return JSON.stringify({ encrypted: false, folders, items }, null, 2);
}

interface ImportRequest {
  ciphers: Json[];
  folders: { name: string }[];
  folderRelationships: { key: number; value: number }[];
  skipped: number;
}

/**
 * Parses a Bitwarden JSON export (unencrypted, or password protected with `password`) or a Bitwarden CSV, and
 * encrypts it for POST /api/ciphers/import.
 */
export function prepareImport(text: string, password?: string): ImportRequest {
  let data: Json | undefined;
  if (!text.trimStart().startsWith("{")) data = csvToExport(text);
  else
    try {
      data = o(JSON.parse(text));
      if (data?.passwordProtected === true) {
        if (!password) throw new Error("This export is protected by a file password");
        data = o(JSON.parse(core.passwordOpenExport(text, password)));
      }
    } catch (e) {
      if (e instanceof SyntaxError) data = undefined;
      else throw e;
    }
  if (!data || data.encrypted === true || !Array.isArray(data.items))
    throw new Error(data?.encrypted === true ? "Account-encrypted exports cannot be imported here; export with a file password instead" : "This is not a Bitwarden JSON or CSV export");
  const srcFolders = (Array.isArray(data.folders) ? data.folders : []).map(o).filter((f): f is Json => typeof f?.name === "string");
  const folderIndex = new Map(srcFolders.map((f, i) => [s(f.id), i]));
  const out: ImportRequest = { ciphers: [], folders: srcFolders.map((f) => ({ name: encryptName(s(f.name)) })), folderRelationships: [], skipped: 0 };
  for (const raw of data.items) {
    const item = o(raw);
    const type = Number(item?.type);
    // bitwarden-vault CipherType: login 1 ... SSH key 5, bank account 6, driver's license 7, passport 8.
    if (!item || !(Number.isInteger(type) && type >= 1 && type <= 8) || typeof item.name !== "string") {
      out.skipped++;
      continue;
    }
    // Server-assigned fields are dropped; the item lands in the personal vault.
    const { id: _id, folderId, organizationId: _org, collectionIds: _coll, revisionDate: _rev, creationDate: _cr, deletedDate: _del, attachments: _att, key: _key, ...rest } = item;
    const fi = folderIndex.get(s(folderId));
    if (fi !== undefined) out.folderRelationships.push({ key: out.ciphers.length, value: fi });
    out.ciphers.push(JSON.parse(core.encryptCipher(JSON.stringify({ ...rest, type }), true)) as Json);
  }
  return out;
}

// ---------- Attachments ----------

/** The file and its name: the service worker never needs the item for it. */
export function decryptAttachment(cipherId: string, attachmentId: string, data: string): { fileName: string; data: string } {
  const c = get(cipherId);
  const att = (ci(c, "attachments") as Json[] | undefined)?.find((a) => ci(a, "id") === attachmentId);
  if (!att) throw new Error("Attachment not found");
  return { fileName: s(ci(att, "fileName")) || "attachment", data: core.decryptAttachment(JSON.stringify(c), attachmentId, Uint8Array.fromBase64(data)).toBase64() };
}

/** Editable items only, like editing. Result: { key, fileName, data } for the upload. */
export function encryptAttachment(cipherId: string, fileName: string, data: string): Json {
  const c = get(cipherId);
  if (summary(c).readOnly) throw new Error("item is read-only");
  return JSON.parse(core.encryptAttachment(JSON.stringify(c), fileName, Uint8Array.fromBase64(data))) as Json;
}

// ---------- Send ----------

type SendEntry = Omit<SendItem, "link"> & { accessId: string; urlKey: string };

/** List entries without the text/file content. The service worker turns accessId + urlKey into the link. */
export function listSends(): SendEntry[] {
  return [...sends.values()]
    .map((x) => ({
      id: s(ci(x, "id")),
      type: Number(ci(x, "type")),
      name: s(ci(x, "name")),
      accessId: s(ci(x, "accessId")),
      urlKey: s(ci(x, "urlKey")),
      deletionDate: s(ci(x, "deletionDate")),
      hasPassword: !!ci(x, "password"),
      disabled: ci(x, "disabled") === true,
      accessCount: Number(ci(x, "accessCount") ?? 0),
      maxAccessCount: typeof ci(x, "maxAccessCount") === "number" ? (ci(x, "maxAccessCount") as number) : undefined,
      ...(x.failed ? { failed: true } : {}),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The edit `send` on top of the stored send `cur`. `cur.password` is the server's own hash and the server hashes
 * whatever `password` it receives, so sending it back would double-hash it and lock everyone out. Leaving
 * `password` out keeps the stored one (vaultwarden `update_send_from_data`); only a newly typed password is sent,
 * hashed by the core. Keys compare case-insensitively: the stored send keeps the server's casing (`Password`,
 * `Text`), and the core takes either spelling, so a stored one next to the edit's could win.
 */
export function sendEdit(cur: Json, send: Json): Json {
  const edited = new Set(Object.keys(send).map((k) => k.toLowerCase()));
  const kept = Object.entries(cur).filter(([k]) => k.toLowerCase() !== "password" && !edited.has(k.toLowerCase()));
  return { ...Object.fromEntries(kept), ...send };
}

/** A send with an `id` is an edit: the changes go on top of the stored send, with its key (the link stays). */
export function prepareSend(send: Json): Json {
  const id = s(ci(send, "id"));
  let plain = send;
  if (id) {
    const cur = sends.get(id);
    if (!cur || cur.failed) throw new Error("send not found");
    plain = sendEdit(cur, send);
  }
  return JSON.parse(core.encryptSend(JSON.stringify(plain))) as Json;
}

export const encryptSendFile = (key: string, data: string): string => core.encryptSendFile(key, Uint8Array.fromBase64(data)).toBase64();

/** The full decrypted send, for editing (never leaves the popup). */
export function getSend(id: string): Json {
  const send = sends.get(id);
  if (!send || send.failed) throw new Error("send not found");
  return send;
}

export function upsertSend(enc: Json): void {
  const r = JSON.parse(core.decryptSendList(JSON.stringify([enc]))) as { sends: Json[] };
  for (const x of r.sends) sends.set(s(ci(x, "id")), x);
}

export const removeSend = (id: string): void => void sends.delete(id);

// ---------- Passkeys ----------

/** Page-supplied allowCredentials can be arbitrarily long: only this many are considered. */
const MAX_ALLOW_IDS = 64;

const checkRp = async (rpId: string, origin: string) => {
  const p = await getPsl();
  fido2.checkRpId(rpId, origin, (d) => p.isPublicSuffix(d));
};

/** A stored credential's id as base64url, or undefined when it is malformed (it then matches nothing). */
function credentialId(cred: unknown): string | undefined {
  try {
    return b64u(fido2.credentialIdBytes(s(ci(cred, "credentialId"))));
  } catch {
    return undefined;
  }
}

/** Stored passkeys for `rpId`; with `ids` (base64url) only those, otherwise only discoverable ones. */
export async function passkeyCandidates(rpId: string, origin: string, ids: string[]): Promise<PasskeyCandidate[]> {
  if (!ciphers) throw new Error("vault not loaded");
  await checkRp(rpId, origin);
  // `ids` comes from the page's allowCredentials: bound the work it can ask for.
  const allow = ids.slice(0, MAX_ALLOW_IDS);
  const out: PasskeyCandidate[] = [];
  for (const c of ciphers.values()) {
    const creds = ci(o(ci(c, "login")), "fido2Credentials");
    if (Number(ci(c, "type")) !== 1 || !Array.isArray(creds)) continue;
    for (const cred of creds) {
      if (s(ci(cred, "rpId")) !== rpId) continue;
      const id = credentialId(cred);
      if (id === undefined) continue;
      if (allow.length ? !allow.includes(id) : s(ci(cred, "discoverable")) === "false") continue;
      out.push({ itemId: s(ci(c, "id")), name: s(ci(c, "name")), userName: s(ci(cred, "userName")), credentialId: id });
    }
  }
  return out;
}

export async function passkeyAssert(itemId: string, wanted: string, rpId: string, origin: string, challenge: string, uv: boolean) {
  await checkRp(rpId, origin);
  const creds = ci(o(ci(live(itemId), "login")), "fido2Credentials");
  // A malformed sibling credential must not break the one the user picked.
  const cred = (Array.isArray(creds) ? creds : []).find((x) => s(ci(x, "rpId")) === rpId && credentialId(x) === wanted);
  if (!cred) throw new Error("passkey not found");
  return fido2.assert(cred as Json, origin, challenge, uv);
}

/**
 * A new passkey, saved into the login `itemId` (replacing its passkey) or a new login, and encrypted here: the
 * private key goes to the server only inside the item's ciphertext, never to the service worker. Replacing one also
 * gives `undo`, the item as it is now: if the site never gets the new passkey, the old one goes back.
 */
export async function passkeyCreate(input: fido2.CreateInput, itemId?: string): Promise<{ cipher: Json; response: Json; undo?: Json }> {
  await checkRp(input.rpId, input.origin);
  const base: Json = itemId ? getCipher(itemId) : { type: 1, name: input.rpName || input.rpId, login: { username: input.user.name, uris: [{ uri: input.origin, match: null }] } };
  const { fido2Credential, response } = await fido2.createCredential(input);
  const cipher = prepareSave({ ...base, login: { ...o(base.login), fido2Credentials: [fido2Credential] } });
  return { cipher, response, ...(itemId && summary(get(itemId)).hasPasskey ? { undo: prepareSave(base) } : {}) };
}

// ---------- card / identity fill ----------

/** Values keyed by HTML autocomplete token, for fillForm in the page. */
export function formValues(id: string): Record<string, string> {
  const c = live(id);
  const type = Number(ci(c, "type"));
  const f = (k: string, obj: Json | undefined) => s(ci(obj, k));
  if (type === 3) {
    const card = o(ci(c, "card"));
    const mm = f("expMonth", card).padStart(2, "0");
    const yyyy = f("expYear", card);
    return {
      "cc-name": f("cardholderName", card),
      "cc-number": f("number", card),
      "cc-csc": f("code", card),
      "cc-type": f("brand", card),
      "cc-exp-month": f("expMonth", card) ? mm : "",
      "cc-exp-year": yyyy,
      "cc-exp": f("expMonth", card) && yyyy ? `${mm}/${yyyy.slice(-2)}` : "",
    };
  }
  if (type === 4) {
    const i = o(ci(c, "identity"));
    const lines = ["address1", "address2", "address3"].map((k) => f(k, i)).filter(Boolean);
    return {
      name: [f("firstName", i), f("middleName", i), f("lastName", i)].filter(Boolean).join(" "),
      "given-name": f("firstName", i),
      "additional-name": f("middleName", i),
      "family-name": f("lastName", i),
      email: f("email", i),
      tel: f("phone", i),
      organization: f("company", i),
      username: f("username", i),
      "street-address": lines.join("\n"),
      "address-line1": f("address1", i),
      "address-line2": f("address2", i),
      "address-line3": f("address3", i),
      "address-level2": f("city", i),
      "address-level1": f("state", i),
      "postal-code": f("postalCode", i),
      country: f("country", i),
      "country-name": f("country", i),
    };
  }
  throw new Error("not a card or identity");
}
