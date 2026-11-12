// Vault orchestration in the service worker: encrypted cache in storage.local, sync, and writes.
// Decryption happens in the offscreen worker; the SW only moves encrypted JSON around.
import { CLEAR_CLIPBOARD_MS, PIN_KDF } from "../shared/constants.ts";
import { clipboardDigest } from "../shared/digest.ts";
import type { BreachResults, CoreRequest, ExportFormat, HistoryEntry, SendItem, VaultItem, VaultList } from "../shared/messages.ts";
import { safeKdf } from "./kdf.ts";
import { revisionDate } from "../transport/auth.ts";
import {
  addAttachment as apiAddAttachment,
  deleteAttachment as apiDeleteAttachment,
  createFileSend,
  createSend,
  deleteFolder as apiDeleteFolder,
  deleteSend as apiDeleteSend,
  downloadAttachment as apiDownloadAttachment,
  fullSync,
  importCiphers,
  purgeCipher,
  removeSendPassword as apiRemoveSendPassword,
  archiveCipher,
  emailBreaches,
  restoreCipher,
  saveCipher,
  saveFolder as apiSaveFolder,
  setCipherCollections,
  shareCipher,
  trashCipher,
  updateSend,
  uploadSendFile,
  verifyPassword,
} from "../transport/vault.ts";
import { ApiError } from "../transport/http.ts";
import { auth, UserError, verifyMasterPassword } from "./account.ts";
import { coreAlive, coreCall } from "./core.ts";
import { assertEpoch, lockEpoch, ownerEpoch } from "./lock.ts";
import { readPrivate, updatePrivate } from "./private.ts";
import { REPROMPT_MESSAGE, repromptPending } from "./reprompt.ts";
import { BLOCK, seal, unseal } from "./seal.ts";
import { getLocal, getSession, getSettings, removeLocal, setLocal, updateSession, type VaultCache } from "./store.ts";

export const CLIPBOARD_ALARM = "clipboard";

export const isUnlocked = async (): Promise<boolean> => (await getSession()).unlocked && (await coreAlive());

export async function requireUnlocked(): Promise<void> {
  if (!(await isUnlocked())) throw new UserError("wrongPhase", "The vault is locked");
}

async function server(): Promise<string> {
  const s = await getLocal("server");
  if (!s) throw new UserError("wrongPhase", "No server configured");
  return s.url;
}

/** Into the worker, only while `epoch` holds: after a lock it would land in a new, keyless worker as undecryptable items. */
const load = (c: VaultCache, epoch: number) =>
  coreCall(
    { op: "loadVault", ciphers: c.ciphers, folders: c.folders, sends: c.sends ?? [], orgKeys: c.orgKeys, collections: c.collections ?? [], orgs: c.orgs ?? [] },
    () => assertEpoch(epoch),
  );

/** Changes this browser made on the server, counted as each one is answered: a sync asked before one may lack it. */
let changes = 0;
let commits: Promise<unknown> = Promise.resolve();

/**
 * Every write to the vault cache and the worker's copy, one at a time and only in the session (`epoch`) it began
 * in: a read-then-write must not drop another write, and a lock or another account must not get it.
 */
function commit(epoch: number, run: (cache: VaultCache | undefined) => Promise<unknown>): Promise<void> {
  const step = async () => {
    const cache = await getLocal("vault");
    assertEpoch(epoch);
    await run(cache);
  };
  const done = commits.then(step, step);
  commits = done.catch(() => undefined);
  return done.then(() => undefined);
}

/**
 * After the server took a change: updating the local copy may fail (offline, locked meanwhile), but that must not
 * read as a failed change, or a retry would make it twice. The next sync catches up.
 */
const refreshAfter = (p: Promise<unknown>): Promise<void> => p.then(
  () => undefined,
  (e: unknown) => console.warn("refresh after a saved change", e),
);

/** Syncs in the order they began (a cache counter, see `changes`), and the last one stored. */
let syncsStarted = 0;
let syncStored = 0;

/** Full sync when the server's revision date moved (or `force`). Returns true if data changed. */
export async function sync(force: boolean): Promise<boolean> {
  const epoch = lockEpoch();
  const seen = changes;
  const ticket = ++syncsStarted;
  const { base, token } = await auth();
  const cache = await getLocal("vault");
  const revision = await revisionDate(base, token);
  if (!force && cache && cache.revision >= revision) {
    await commit(epoch, async (c) => c && setLocal("vault", { ...c, syncedAt: Date.now() }));
    return false;
  }
  const r = await fullSync(base, token);
  const orgKeys = Object.fromEntries((r.profile.organizations ?? []).filter((o) => o.key).map((o) => [o.id, o.key!]));
  // shortcut: whole vault in one storage.local key (no quota: unlimitedStorage); move to IndexedDB if one set() of it gets slow.
  const orgs = (r.profile.organizations ?? []).map((o) => ({ id: o.id, name: o.name ?? "" }));
  const next: VaultCache = { revision, syncedAt: Date.now(), ciphers: r.ciphers, folders: r.folders, sends: r.sends ?? [], orgKeys, collections: r.collections ?? [], orgs };
  let again = false;
  await commit(epoch, async () => {
    // A change of ours was answered while this was out, and this answer may predate it: ask again, never undo it.
    if (changes !== seen) return void (again = true);
    // A sync that began after this one was stored already: its answer is the newer one.
    if (ticket < syncStored) return;
    syncStored = ticket;
    await setLocal("vault", next);
    await load(next, epoch);
  });
  if (again) return sync(true);
  // Forget fill and open stamps of items that no longer exist. Sync also runs locked (no key): skip then.
  const ids = new Set(r.ciphers.map((c) => (c as { id?: unknown }).id));
  const keep = <T>(m: Record<string, T>) => Object.fromEntries(Object.entries(m).filter(([id]) => ids.has(id)));
  if (await isUnlocked()) await updatePrivate((d) => ((d.lastUsed = keep(d.lastUsed)), (d.opened = keep(d.opened)))).catch(() => undefined);
  return true;
}

let loading: Promise<void> | undefined;

/**
 * Makes sure the worker holds the decrypted vault, without moving the whole list around. Callers at the
 * same time (the popup asks for the list and the site's matches at once) share one load.
 */
export function ensureLoaded(): Promise<void> {
  return (loading ??= (async () => {
    const epoch = lockEpoch();
    if (await coreCall<boolean>({ op: "vaultLoaded" })) return;
    const cache = await getLocal("vault");
    if (cache) await load(cache, epoch);
    else await sync(true);
  })().finally(() => (loading = undefined)));
}

export async function list(): Promise<VaultList> {
  await ensureLoaded();
  const l = await coreCall<VaultList>({ op: "listVault" });
  // Usage data that cannot be read is not worth failing the list over.
  return { ...l, syncedAt: (await getLocal("vault"))?.syncedAt, opened: await readPrivate().then((d) => d.opened, () => ({})) };
}

export const save = async (item: Record<string, unknown>, collectionIds?: string[]): Promise<VaultList> =>
  saveEncrypted(await coreCall<Record<string, unknown>>({ op: "prepareSave", item }), undefined, collectionIds);

export async function moveToOrg(id: string, organizationId: string, collectionIds: string[]): Promise<VaultList> {
  const epoch = lockEpoch();
  const account = await getLocal("account");
  if (!account?.userId) throw new UserError("sessionExpired", "Please log in again");
  const enc = await coreCall<Record<string, unknown>>({ op: "prepareShare", id, organizationId });
  return thenSync((b, t) => shareCipher(b, t, id, { ...enc, encryptedFor: account.userId }, collectionIds), epoch);
}

export const setCollections = (id: string, collectionIds: string[]) => thenSync((b, t) => setCipherCollections(b, t, id, collectionIds));

/**
 * Sends an item the worker already encrypted (prepareSave, preparePassword, passkeyCreate) and returns the
 * server's copy. `guard` runs right before the request and throws to call the save off (a cancelled passkey).
 */
export async function putCipher(enc: Record<string, unknown>, guard?: () => void, collectionIds?: string[]): Promise<Record<string, unknown>> {
  const epoch = lockEpoch();
  const owner = ownerEpoch();
  const account = await getLocal("account");
  if (!account?.userId) throw new UserError("sessionExpired", "Please log in again");
  // The item, the account it is for and the token are one account's (auth checks `owner` once all are read).
  const { base, token } = await auth(owner);
  // Right before the request, with no await in between: a change a lock overtook is never sent.
  assertEpoch(epoch);
  guard?.();
  const saved = await saveCipher(base, token, { ...enc, encryptedFor: account.userId }, collectionIds);
  changes++;
  await refreshAfter(
    commit(epoch, async (cache) => {
      if (cache) await setLocal("vault", { ...cache, ciphers: [...cache.ciphers.filter((c) => (c as { id?: unknown }).id !== saved.id), saved] });
      await coreCall({ op: "upsertCipher", cipher: saved }, () => assertEpoch(epoch));
    }),
  );
  return saved;
}

export async function saveEncrypted(enc: Record<string, unknown>, guard?: () => void, collectionIds?: string[]): Promise<VaultList> {
  await putCipher(enc, guard, collectionIds);
  return list();
}

/** Trash, restore, permanent delete and folder changes re-sync instead of patching the cache by hand. */
async function thenSync(change: (base: string, token: string) => Promise<void>, epoch = lockEpoch()): Promise<VaultList> {
  const { base, token } = await auth();
  assertEpoch(epoch);
  await change(base, token);
  changes++;
  await refreshAfter(sync(true));
  return list();
}

export const trash = (id: string) => thenSync((b, t) => trashCipher(b, t, id));
export const restore = (id: string) => thenSync((b, t) => restoreCipher(b, t, id));
export const archive = (id: string, archived: boolean) => thenSync((b, t) => archiveCipher(b, t, id, archived));
export const purge = (id: string) => thenSync((b, t) => purgeCipher(b, t, id));
export const deleteFolder = (id: string) => thenSync((b, t) => apiDeleteFolder(b, t, id));

export async function saveFolder(name: string, id?: string): Promise<VaultList> {
  const epoch = lockEpoch();
  // Folder names are encrypted with the user key, like a personal cipher name.
  const [enc] = await coreCall<string[]>({ op: "encryptText", values: [name] });
  return thenSync((b, t) => apiSaveFolder(b, t, enc!, id), epoch);
}

/** Arms the clipboard clear according to the user's "Clear clipboard" setting (never = cancel). */
export async function scheduleClipboardClear(hash: string): Promise<void> {
  const { clearClipboardDelay } = await getSettings();
  const ms = CLEAR_CLIPBOARD_MS[clearClipboardDelay] ?? CLEAR_CLIPBOARD_MS.oneMinute;
  if (!ms) return void (await chrome.alarms.clear(CLIPBOARD_ALARM));
  await updateSession({ clipboardHash: hash });
  await chrome.alarms.create(CLIPBOARD_ALARM, { delayInMinutes: ms / 60_000 });
}

/** Puts `text` on the clipboard from the offscreen document and arms the clear only if that worked. */
export async function copyToClipboard(text: string): Promise<boolean> {
  const ok = await coreCall<boolean>({ op: "writeClipboard", text });
  // A failed write must not arm the clear: it would wipe whatever the user has on the clipboard.
  if (ok) await scheduleClipboardClear(await clipboardDigest(text));
  return ok;
}

/** Records a user-gesture fill; page-load autofill prefers the login last used for the site. */
export async function markUsed(id: string): Promise<void> {
  // Best effort: a stamp that cannot be written must not turn a done fill into an error.
  await updatePrivate((d) => (d.lastUsed[id] = Date.now())).catch(() => undefined);
}

/** The full decrypted send (for the edit form). */
export const getSend = (id: string) => coreCall<Record<string, unknown>>({ op: "getSend", id });

export async function clearClipboard(): Promise<void> {
  // Close the document only if this call opened it: an open one may hold a pending 2FA key or an unlock in progress.
  const wasAlive = await coreAlive();
  // Only what we copied: something the user copied since stays. Without a hash (session gone) it clears as before.
  const { clipboardHash } = await getSession();
  await coreCall({ op: "clearClipboard", ...(clipboardHash ? { hash: clipboardHash } : {}) });
  await updateSession({ clipboardHash: undefined });
  if (!wasAlive) await chrome.offscreen.closeDocument().catch(() => undefined);
}

// ---------- Import / export ----------

export async function exportVault(password: string, format: ExportFormat, filePassword?: string): Promise<string> {
  // The whole vault in clear text: ask the server to confirm the master password first, like the official clients.
  await verifyMasterPassword(password);
  if (format === "encrypted" && !filePassword) throw new UserError("invalid", "Enter a file password");
  await ensureLoaded();
  // A file can be attacked offline: it gets the account's KDF only when that is a strong one.
  const account = await getLocal("account");
  const kdf = account && safeKdf(account.kdf) ? account.kdf : { ...PIN_KDF };
  return coreCall<string>({ op: "exportVault", format, ...(format === "encrypted" ? { password: filePassword, kdf } : {}) });
}

export async function importVault(text: string, password?: string): Promise<{ imported: number; skipped: number }> {
  const epoch = lockEpoch();
  const owner = ownerEpoch();
  const account = await getLocal("account");
  if (!account?.userId) throw new UserError("sessionExpired", "Please log in again");
  await ensureLoaded();
  const r = await coreCall<{ ciphers: Record<string, unknown>[]; folders: unknown[]; folderRelationships: unknown[]; skipped: number }>({ op: "prepareImport", text, ...(password ? { password } : {}) }).catch((e: unknown) => {
    throw new UserError("invalid", (e as Error).message);
  });
  if (!r.ciphers.length) throw new UserError("invalid", "Nothing to import");
  const ciphers = r.ciphers.map((c) => ({ ...c, encryptedFor: account.userId }));
  const { base, token } = await auth(owner);
  assertEpoch(epoch);
  await importCiphers(base, token, { ciphers, folders: r.folders, folderRelationships: r.folderRelationships });
  changes++;
  // Imported is imported: a failed refresh must not invite a second import of the same items.
  await refreshAfter(sync(true));
  return { imported: ciphers.length, skipped: r.skipped };
}

// ---------- Attachments ----------
// Bodies travel base64 through the message hops like Send files (same size cap).

export async function downloadAttachment(cipherId: string, attachmentId: string): Promise<{ fileName: string; data: string }> {
  if (repromptPending(await coreCall<VaultItem>({ op: "cipherSummary", id: cipherId }))) throw new UserError("reprompt", REPROMPT_MESSAGE);
  const { base, token } = await auth();
  const body = await apiDownloadAttachment(base, token, cipherId, attachmentId);
  return coreCall<{ fileName: string; data: string }>({ op: "decryptAttachment", cipherId, attachmentId, data: body.toBase64() });
}

export async function addAttachment(cipherId: string, file: { name: string; data: string }): Promise<VaultList> {
  if ((file.data.length * 3) / 4 > MAX_SEND_FILE_BYTES) throw new UserError("invalid", "The file is too large (max 25 MB)");
  const epoch = lockEpoch();
  const enc = await coreCall<{ key: string; fileName: string; data: string }>({ op: "encryptAttachment", cipherId, fileName: file.name, data: file.data });
  return thenSync((b, t) => apiAddAttachment(b, t, cipherId, { key: enc.key, fileName: enc.fileName }, Uint8Array.fromBase64(enc.data)), epoch);
}

export async function deleteAttachment(cipherId: string, attachmentId: string): Promise<VaultList> {
  return thenSync((b, t) => apiDeleteAttachment(b, t, cipherId, attachmentId));
}

// ---------- Generator history ----------

const HISTORY_MAX = 100;

export async function generatorHistory(): Promise<HistoryEntry[]> {
  const h = (await getLocal("genHistory")) ?? [];
  const values = await unseal(h.map((e) => e.value));
  return h.map((e, i) => ({ date: e.date, value: values[i] ?? "" }));
}

export async function addGeneratorHistory(value: string): Promise<null> {
  const [enc] = await seal([value], BLOCK.secret);
  await setLocal("genHistory", [{ date: Date.now(), value: enc! }, ...((await getLocal("genHistory")) ?? [])].slice(0, HISTORY_MAX));
  return null;
}

export const clearGeneratorHistory = () => removeLocal("genHistory").then(() => null);

// ---------- Send ----------

type Json = Record<string, unknown>;
// shortcut: file content travels base64 through two message hops (64 MiB limit); stream it if bigger files are needed.
export const MAX_SEND_FILE_BYTES = 25 * 1024 * 1024;

export async function sendList(): Promise<SendItem[]> {
  await ensureLoaded(); // the vault and its sends
  const base = await server();
  const entries = await coreCall<(Omit<SendItem, "link"> & { accessId: string; urlKey: string })[]>({ op: "listSends" });
  return entries.map(({ accessId, urlKey, ...e }) => ({ ...e, link: `${base}/#/send/${accessId}/${urlKey}` }));
}

/** After the server took a send change: the cache and the worker follow, best effort (see refreshAfter). */
function cacheSends(epoch: number, update: (sends: unknown[]) => unknown[], worker: CoreRequest): Promise<void> {
  changes++;
  return refreshAfter(
    commit(epoch, async (cache) => {
      if (cache) await setLocal("vault", { ...cache, sends: update(cache.sends ?? []) });
      await coreCall(worker, () => assertEpoch(epoch));
    }),
  );
}

/** Creates a text send, or a file send when `file` is given (content base64); a send with an id is edited. */
export async function saveSend(send: Json, file?: { name: string; data: string }): Promise<SendItem[]> {
  const epoch = lockEpoch();
  const { base, token } = await auth();
  let saved: Json;
  if (typeof send.id === "string") {
    const enc = await coreCall<Json>({ op: "prepareSend", send });
    assertEpoch(epoch);
    saved = await updateSend(base, token, send.id, enc);
    await cacheSends(epoch, (s) => s.map((x) => ((x as Json).id === saved.id ? saved : x)), { op: "upsertSend", send: saved });
    return sendList();
  }
  if (file) {
    if ((file.data.length * 3) / 4 > MAX_SEND_FILE_BYTES) throw new UserError("invalid", "The file is too large (max 25 MB)");
    const enc = await coreCall<Json>({ op: "prepareSend", send: { ...send, type: 1, text: undefined, file: { fileName: file.name } } });
    const body = Uint8Array.fromBase64(await coreCall<string>({ op: "encryptSendFile", key: String(enc.key), data: file.data }));
    assertEpoch(epoch);
    saved = await createFileSend(base, token, { ...enc, fileLength: body.length });
    const f = saved.file as Json | undefined;
    // Without its file the send is useless to a recipient: remove it again if the upload fails.
    await uploadSendFile(base, token, String(saved.id), String(f?.id), String(f?.fileName), body).catch(async (e: unknown) => {
      await apiDeleteSend(base, token, String(saved.id)).catch(() => undefined);
      throw e;
    });
  } else {
    const enc = await coreCall<Json>({ op: "prepareSend", send: { ...send, type: 0 } });
    assertEpoch(epoch);
    saved = await createSend(base, token, enc);
  }
  await cacheSends(epoch, (s) => [...s, saved], { op: "upsertSend", send: saved });
  return sendList();
}

/** Removes the access password in place; the link and the content stay the same. */
export async function removeSendPassword(id: string): Promise<SendItem[]> {
  const epoch = lockEpoch();
  const { base, token } = await auth();
  assertEpoch(epoch);
  const saved = await apiRemoveSendPassword(base, token, id);
  await cacheSends(epoch, (s) => s.map((x) => ((x as Json).id === saved.id ? saved : x)), { op: "upsertSend", send: saved });
  return sendList();
}

export async function deleteSend(id: string): Promise<SendItem[]> {
  const epoch = lockEpoch();
  const { base, token } = await auth();
  assertEpoch(epoch);
  await apiDeleteSend(base, token, id);
  await cacheSends(epoch, (s) => s.filter((x) => (x as { id?: unknown }).id !== id), { op: "removeSend", id });
  return sendList();
}

const MAX_BREACH_EMAILS = 40;

/**
 * Asks the user's own server (which asks HIBP) about each address, one at a time; stops when the server has no key or
 * throttles. Past MAX_BREACH_EMAILS the answer is `stopped`, so the report never calls unchecked addresses clean.
 */
export async function breachEmails(emails: string[]): Promise<BreachResults> {
  const { base, token } = await auth();
  const results: BreachResults["results"] = [];
  const unique = [...new Set(emails)];
  for (const email of unique.slice(0, MAX_BREACH_EMAILS)) {
    try {
      const r = await emailBreaches(base, token, email);
      if (r.status === "unconfigured") return { unconfigured: true, results: [] };
      if (r.status === "found") results.push({ email, names: r.names });
    } catch {
      return { results, stopped: true };
    }
  }
  return unique.length > MAX_BREACH_EMAILS ? { results, stopped: true } : { results };
}
