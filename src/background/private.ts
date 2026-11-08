// Device data that tells what the user does: sites they never save on, which items they fill and open, and the
// generator's address. It is stored like the vault, encrypted with the user key (one EncString in
// storage.local "private"), so only an unlocked vault can read it. Every read and write needs the vault unlocked.
import { coreCall } from "./core.ts";
import { getLocal, removeLocal, setLocal, updateSettings } from "./store.ts";
import { BLOCK, seal, unseal } from "./seal.ts";

interface PrivateData {
  /** Hosts the save bar never asks about. */
  neverSave: string[];
  /** Hosts (and their subdomains) where the inline menu, page-load fill and passkey prompts stay away. */
  blocked: string[];
  /** cipher id -> epoch ms of the last user-gesture fill (page-load autofill prefers it, like the clients). */
  lastUsed: Record<string, number>;
  /** cipher id -> how often and when it was last opened in the popup ("Recently opened", "Most opened" sort). */
  opened: Record<string, { n: number; at: number }>;
  /**
   * Generator: its options (they tell how the user's passwords are built), the username generator's address
   * and catch-all domain, and how many words the custom passphrase list (storage.local "wordlist") has.
   */
  generator: { options: Record<string, string | number | boolean>; email: string; domain: string; wordlist: number };
}

/** What the generator screen gets: everything but the word list itself, which stays here. */
export type GeneratorPrefs = { options: Record<string, string | number | boolean>; email: string; domain: string; wordlist: number };

const MAX_NEVER_SAVE = 500;
const MAX_IDS = 500;

const empty = (): PrivateData => ({ neverSave: [], blocked: [], lastUsed: {}, opened: {}, generator: { options: {}, email: "", domain: "", wordlist: 0 } });

/** Generator options are flat: short names, short values, a bounded count. */
function options(v: unknown): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  if (!isObj(v)) return out;
  for (const [k, x] of Object.entries(v).slice(0, 40)) {
    if (!/^[A-Za-z]{1,32}$/.test(k) || k === "email" || k === "domain" || k === "wordlist") continue;
    if (typeof x === "boolean" || (typeof x === "number" && Number.isFinite(x)) || (typeof x === "string" && x.length <= 64)) out[k] = x;
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Keeps only well-formed entries: the record is ours, but a damaged one must not break the callers. */
export function sanitize(v: unknown): PrivateData {
  const d = empty();
  if (!isObj(v)) return d;
  // Without a trailing dot, as hostOf gives them: older builds stored "example.com." as typed, and could not remove it.
  const hosts = (l: unknown) =>
    Array.isArray(l) ? [...new Set(l.filter((h): h is string => typeof h === "string" && !!h).map((h) => h.replace(/\.$/, "")).filter(Boolean))].slice(-MAX_NEVER_SAVE) : [];
  // The save bar of older builds stored the host with its port; the list holds host names (see hostOf).
  d.neverSave = hosts(Array.isArray(v.neverSave) ? v.neverSave.map((h) => (typeof h === "string" ? h.replace(/:\d+$/, "") : h)) : []);
  d.blocked = hosts(v.blocked);
  if (isObj(v.lastUsed)) for (const [id, at] of Object.entries(v.lastUsed)) if (typeof at === "number" && Number.isFinite(at)) d.lastUsed[id] = at;
  if (isObj(v.opened))
    for (const [id, o] of Object.entries(v.opened))
      if (isObj(o) && typeof o.n === "number" && typeof o.at === "number" && Number.isFinite(o.n) && Number.isFinite(o.at)) d.opened[id] = { n: o.n, at: o.at };
  if (isObj(v.generator)) {
    const n = v.generator.wordlist;
    d.generator = { options: options(v.generator.options), email: str(v.generator.email), domain: str(v.generator.domain), wordlist: typeof n === "number" && n > 0 ? Math.floor(n) : 0 };
  }
  // Bounded like the other per-item maps: the newest entries win.
  const newest = <T>(m: Record<string, T>, at: (x: T) => number) => Object.fromEntries(Object.entries(m).sort((a, b) => at(b[1]) - at(a[1])).slice(0, MAX_IDS));
  d.lastUsed = newest(d.lastUsed, (x) => x);
  d.opened = newest(d.opened, (x) => x.at);
  return d;
}

export async function readPrivate(): Promise<PrivateData> {
  const enc = await getLocal("private");
  if (!enc) return empty();
  const [json] = await unseal([enc]);
  // An unreadable record must not be taken as empty and then written over: that would lose it.
  if (!json) throw new Error("private data could not be decrypted");
  try {
    return sanitize(JSON.parse(json));
  } catch {
    throw new Error("private data is damaged");
  }
}

/** Writes run one at a time, so two quick changes (two "never save" clicks) cannot undo each other. */
let writes: Promise<unknown> = Promise.resolve();

export function updatePrivate(change: (d: PrivateData) => void): Promise<PrivateData> {
  const write = async () => {
    const d = await readPrivate();
    change(d);
    const next = sanitize(d);
    const [enc] = await seal([JSON.stringify(next)], BLOCK.record);
    if (!enc) throw new Error("private data could not be encrypted");
    await setLocal("private", enc);
    return next;
  };
  const result = writes.then(write, write);
  writes = result.catch(() => undefined);
  return result;
}

/** After an unlock: moves what older builds kept in clear text (never-save hosts, last-used stamps) in here. */
export async function migratePrivate(): Promise<void> {
  const settings = (await getLocal("settings")) as ({ neverSave?: unknown } & Record<string, unknown>) | undefined;
  const legacyHosts = Array.isArray(settings?.neverSave) ? (settings.neverSave as unknown[]).filter((h): h is string => typeof h === "string") : [];
  const legacyUsed = (await chrome.storage.local.get("lastUsed")).lastUsed as Record<string, number> | undefined;
  if (!settings?.neverSave && !legacyUsed) return;
  await updatePrivate((d) => {
    d.neverSave = [...d.neverSave, ...legacyHosts];
    d.lastUsed = { ...(isObj(legacyUsed) ? legacyUsed : {}), ...d.lastUsed };
  });
  // Only once the encrypted copy is written does the clear-text one go.
  // Through the settings queue (which drops neverSave): a raw write could undo a settings change made meanwhile.
  if (settings?.neverSave) await updateSettings(() => ({}));
  if (legacyUsed) await chrome.storage.local.remove("lastUsed");
}

// ---------- site lists ----------

/** What the user typed ("example.com", a full URL) as a lower-case host name, or undefined if it is none. */
export function hostOf(input: string): string | undefined {
  const s = input.trim();
  if (!s || s.length > 253) return undefined;
  try {
    const u = new URL(/^[a-z][\w+.-]*:\/\//i.test(s) ? s : `https://${s}`);
    // "example.com." is example.com (the URI matcher agrees): the dot must not slip past the blocked list.
    const host = u.hostname.toLowerCase().replace(/\.$/, "");
    return /^https?:$/.test(u.protocol) && (host.includes(".") || host === "localhost") ? host : undefined;
  } catch {
    return undefined;
  }
}

/** Blocked hosts cover their subdomains. */
export const blockedHost = (host: string, blocked: string[]) => blocked.some((b) => host === b || host.endsWith(`.${b}`));

/**
 * Is the page's site blocked? The list is encrypted, so a locked vault cannot tell: then false, and the
 * caller offers no more than an unlock (which reveals nothing).
 */
export async function isBlocked(url: string, unlocked: boolean): Promise<boolean> {
  if (!unlocked) return false;
  const host = hostOf(url);
  return !!host && blockedHost(host, await readPrivate().then((d) => d.blocked, () => []));
}

// ---------- generator ----------

const MIN_WORDS = 100;
const MAX_WORDS = 100_000;

export const generatorPrefs = async (): Promise<GeneratorPrefs> => (await readPrivate()).generator;

export async function setGeneratorPrefs(change: { options?: Record<string, unknown>; email?: string; domain?: string }): Promise<GeneratorPrefs> {
  const d = await updatePrivate((d) => {
    if (change.options) d.generator.options = options(change.options);
    if (change.email !== undefined) d.generator.email = change.email;
    if (change.domain !== undefined) d.generator.domain = change.domain;
  });
  return d.generator;
}

/** Saves (or with "" removes) the custom passphrase list: one word per line, already cleaned by the popup. */
export async function setWordlist(text: string): Promise<GeneratorPrefs> {
  const words = [...new Set(text.split("\n").map((w) => w.trim()).filter((w) => w && w.length <= 24))].slice(0, MAX_WORDS);
  if (words.length && words.length < MIN_WORDS) throw new Error(`a word list needs at least ${MIN_WORDS} words`);
  if (words.length) {
    const [enc] = await seal([words.join("\n")], BLOCK.wordlist);
    if (!enc) throw new Error("the word list could not be encrypted");
    await setLocal("wordlist", enc);
  } else await removeLocal("wordlist");
  return (await updatePrivate((d) => (d.generator.wordlist = words.length))).generator;
}

/** Generator options for the worker, with the custom word list for a passphrase. */
export async function withWordlist(o: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (o.type !== "passphrase") return o;
  const enc = await getLocal("wordlist");
  if (!enc) return o;
  const [text] = await unseal([enc]);
  const words = (text ?? "").split("\n").filter(Boolean);
  return words.length >= MIN_WORDS ? { ...o, wordlist: words } : o;
}

