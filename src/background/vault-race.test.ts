// Vault writes against a lock, two syncs out of order, and a replacing passkey save the server answered no one.
// Runs the real vault.ts / passkey.ts / account.ts / lock.ts / store.ts against an in-memory chrome, a scripted
// crypto worker and a fetch whose answers the test gives by hand.
import "../shared/uint8-polyfill.ts"; // Node 24 in CI
import assert from "node:assert/strict";
import { test } from "node:test";

const session: Record<string, unknown> = {};
const local: Record<string, unknown> = {};
const area = (data: Record<string, unknown>) => ({
  get: async (key: string | null) => (key === null ? { ...data } : { [key]: data[key] }),
  set: async (values: Record<string, unknown>) => void Object.assign(data, structuredClone(values)),
  remove: async (keys: string | string[]) => {
    for (const k of [keys].flat()) delete data[k];
  },
  setAccessLevel: async () => undefined,
});

let offscreen = true;
const noop = async () => undefined;
/** The passkey approval window's url: it carries the request id. */
let windowUrl = "";
(globalThis as { chrome?: unknown }).chrome = {
  storage: { session: area(session), local: area(local) },
  alarms: { create: noop, clear: noop },
  tabs: { query: async () => [], sendMessage: noop, get: async () => ({ windowId: 1 }) },
  windows: { get: async () => ({}), create: async ({ url }: { url: string }) => ((windowUrl = url), { id: 9 }), remove: noop, update: noop },
  scripting: { unregisterContentScripts: noop },
  offscreen: {
    Reason: { WORKERS: "WORKERS", CLIPBOARD: "CLIPBOARD" },
    hasDocument: async () => offscreen,
    createDocument: async () => void (offscreen = true),
    closeDocument: async () => void (offscreen = false),
  },
  runtime: {
    id: "warren",
    // The crypto worker, scripted: one login with a passkey, replaced by a new one.
    sendMessage: async ({ req }: { req: { op: string; ids?: string[] } }) => {
      const value = (
        {
          vaultLoaded: true,
          matchUri: [{ id: "item-1", name: "a", sub: "u", hasPasskey: true }],
          cipherSummary: { id: "item-1" },
          passkeyCreate: { cipher: { id: "item-1", passkey: "new" }, response: { id: "cred-new" }, undo: { id: "item-1", passkey: "old" } },
          // The worker holds what the last sync loaded: the new passkey only once the server has it.
          passkeyCandidates: serverHasNew && req.ids?.includes("cred-new") ? [{ itemId: "item-1", credentialId: "cred-new" }] : [],
        } as Record<string, unknown>
      )[req.op];
      return { ok: true, value: value ?? null };
    },
  },
};

/** Every request that went out, and each one's answer, given by the test. */
const sent: { method: string; path: string; body: unknown }[] = [];
const waiting = new Map<string, ((r: Response | Error) => void)[]>();
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const path = new URL(url).pathname;
  sent.push({ method: init?.method ?? "GET", path, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body });
  const r = await new Promise<Response | Error>((resolve) => waiting.set(path, [...(waiting.get(path) ?? []), resolve]));
  if (r instanceof Error) throw r;
  return r;
}) as typeof fetch;
async function arrived(path: string) {
  for (let i = 0; i < 200 && !waiting.get(path)?.length; i++) await new Promise((r) => setTimeout(r, 5));
}
async function answer(path: string, body: unknown | Error) {
  await arrived(path);
  const next = waiting.get(path)?.shift();
  assert.ok(next, `no request to ${path}`);
  next(body instanceof Error ? body : new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
}
const syncBody = (ciphers: unknown[]) => ({ ciphers, folders: [], profile: {} });

let serverHasNew = false;
local.server = { url: "https://vault.test" };
local.account = { email: "a@b.test", userId: "user-a", kdf: { type: 0, iterations: 600_000, memory: 0, parallelism: 0 }, protectedUserKey: "2.k|k|k" };
session.session = { unlocked: true, accessToken: "token", accessExpiresAt: Date.now() + 3_600_000 };

const { putCipher, sync } = await import("./vault.ts");
const { lockNow } = await import("./lock.ts");
const { onPasskeyPort, passkeyDecision } = await import("./passkey.ts");

test("a save a lock overtook while the account and token were read is never sent", async () => {
  const saving = putCipher({ name: "2.enc" });
  void lockNow(); // lands while the save still reads the account and the token
  await assert.rejects(saving, /locked meanwhile/);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(!sent.some((r) => r.path.startsWith("/api/ciphers")), "the cipher never went out");
});

test("two syncs answered in reverse order keep the newer one", async () => {
  offscreen = true;
  session.session = { unlocked: true, accessToken: "token", accessExpiresAt: Date.now() + 3_600_000 };
  const older = sync(true);
  await answer("/api/accounts/revision-date", 1);
  await arrived("/api/sync");
  const newer = sync(true);
  await answer("/api/accounts/revision-date", 2);
  // The older request is still out when the newer one is answered and stored.
  await new Promise((r) => setTimeout(r, 10));
  waiting.get("/api/sync")!.reverse(); // answer the newer request first
  await answer("/api/sync", syncBody([{ id: "newer" }]));
  await newer;
  await answer("/api/sync", syncBody([{ id: "older" }]));
  await older;
  assert.deepEqual((local.vault as { ciphers: unknown[] }).ciphers, [{ id: "newer" }]);
});

test("a replacing passkey save without an answer puts the old passkey back once the server has the new one", async () => {
  local.vault = { revision: 2, syncedAt: 0, ciphers: [], folders: [], sends: [], orgKeys: {}, collections: [], orgs: [] };
  const posted: unknown[] = [];
  const listeners: ((m: unknown) => void)[] = [];
  onPasskeyPort({
    sender: { id: "warren", tab: { id: 1 }, frameId: 0, origin: "https://a.test" },
    onDisconnect: { addListener: () => undefined },
    onMessage: { addListener: (l: (m: unknown) => void) => listeners.push(l) },
    postMessage: (m: unknown) => posted.push(m),
    disconnect: () => undefined,
  } as unknown as chrome.runtime.Port);
  const user = { id: "dQ", name: "u", displayName: "u" };
  listeners[0]!({ kind: "create", options: { rpName: "a", user, challenge: "Y2hhbGxlbmdl", exclude: [], discoverable: true, userVerification: "discouraged" } });
  for (let i = 0; i < 200 && !windowUrl; i++) await new Promise((r) => setTimeout(r, 5));
  const id = new URL(windowUrl, "chrome-extension://warren/").searchParams.get("passkey")!;

  sent.length = 0;
  const deciding = passkeyDecision(id, "use", "item-1", undefined, true);
  // The server takes the replacement, but its answer never arrives.
  await answer("/api/ciphers/item-1", new TypeError("network down"));
  serverHasNew = true;
  await answer("/api/accounts/revision-date", 3);
  await answer("/api/sync", syncBody([{ id: "item-1", revisionDate: "rev-3" }]));
  await answer("/api/ciphers/item-1", { id: "item-1", revisionDate: "rev-4" });
  await deciding;

  const puts = sent.filter((r) => r.path === "/api/ciphers/item-1");
  assert.equal(puts.length, 2, "the replacement, then the undo");
  assert.equal((puts[1]!.body as { passkey?: string }).passkey, "old");
  assert.equal((puts[1]!.body as { lastKnownRevisionDate?: string }).lastKnownRevisionDate, "rev-3");
  assert.deepEqual(Object.keys(posted.at(-1) as object), ["error"], "the site gets no credential");
});
