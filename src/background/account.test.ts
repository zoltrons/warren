// Races between a lock (or an account change) and work already in flight: the lock and the newer account win.
// Runs the real account.ts / lock.ts / store.ts against an in-memory chrome, a scripted offscreen worker and a
// fetch whose answers the test releases by hand.
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

let offscreen = false;
const coreOps: string[] = [];
const noop = async () => undefined;
(globalThis as { chrome?: unknown }).chrome = {
  storage: { session: area(session), local: area(local) },
  alarms: { create: noop, clear: noop },
  tabs: { query: async () => [], sendMessage: noop },
  offscreen: {
    Reason: { WORKERS: "WORKERS", CLIPBOARD: "CLIPBOARD" },
    hasDocument: async () => offscreen,
    createDocument: async () => void (offscreen = true),
    closeDocument: async () => void (offscreen = false),
  },
  runtime: {
    // The crypto worker, scripted: every op succeeds.
    sendMessage: async ({ req }: { req: { op: string } }) => {
      coreOps.push(req.op);
      const value = req.op === "prepareKey" ? { handle: 1, authHash: "hash" } : null;
      return { ok: true, value };
    },
  },
};

/** fetch answers per path, released by the test: each request waits for `answer(path, ...)`. */
const waiting = new Map<string, ((r: Response) => void)[]>();
globalThis.fetch = (async (url: string) => {
  const path = new URL(url).pathname;
  return new Promise<Response>((resolve) => waiting.set(path, [...(waiting.get(path) ?? []), resolve]));
}) as typeof fetch;
/** Resolves once a request to `path` is out. */
async function arrived(path: string) {
  for (let i = 0; i < 200 && !waiting.get(path)?.length; i++) await new Promise((r) => setTimeout(r, 5));
}
async function answer(path: string, body: unknown, status = 200) {
  await arrived(path);
  const next = waiting.get(path)?.shift();
  assert.ok(next, `no request to ${path}`);
  next(new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

const jwt = (sub: string) => `h.${Buffer.from(JSON.stringify({ sub, email: "a@b.test" })).toString("base64url")}.s`;
const tokens = (sub: string, refresh: string) => ({ access_token: jwt(sub), expires_in: 3600, refresh_token: refresh, Key: "2.k|k|k" });
const KDF = { kdf: 0, kdfIterations: 600_000 };

const { accessToken, confirmReprompt, login } = await import("./account.ts");
const { lockNow } = await import("./lock.ts");
const { repromptGranted } = await import("./reprompt.ts");

local.server = { url: "https://vault.test" };

test("a lock while a login waits for the server: the login does not unlock the vault", async () => {
  const running = login("a@b.test", "pw");
  await answer("/identity/accounts/prelogin", KDF);
  await lockNow(); // e.g. the system locked the screen
  await answer("/identity/connect/token", tokens("user-a", "r1"));
  await assert.rejects(running, /locked meanwhile/);
  assert.equal((session.session as { unlocked?: boolean }).unlocked, false);
  assert.equal(offscreen, false, "the worker that took the keys is gone again");
});

test("a login nothing interrupts unlocks", async () => {
  const running = login("a@b.test", "pw");
  await answer("/identity/accounts/prelogin", KDF);
  await answer("/identity/connect/token", tokens("user-a", "r1"));
  await running;
  assert.equal((session.session as { unlocked?: boolean }).unlocked, true);
});

test("a lock while the master password is being checked: no re-prompt grant", async () => {
  const running = confirmReprompt("cipher-1", "pw");
  await lockNow();
  // The vault is locked, but the check was already on its way.
  await answer("/api/accounts/verify-password", null);
  await assert.rejects(running, /locked meanwhile/);
  assert.equal(repromptGranted("cipher-1"), false);
});

test("a server that lowers the KDF gets no password hash", async () => {
  await lockNow();
  coreOps.length = 0;
  const running = login("a@b.test", "pw");
  await answer("/identity/accounts/prelogin", { kdf: 0, kdfIterations: 5000 });
  await assert.rejects(running, /too weak/);
  assert.ok(!coreOps.includes("prepareKey"), "no key derived, no hash made");
});

test("a refresh answer for an account that was replaced meanwhile is dropped", async () => {
  session.session = { ...(session.session as object), accessToken: "old", accessExpiresAt: 0 };
  local.account = { ...(local.account as object), refreshToken: "refresh-a" };
  const refreshing = accessToken();
  await arrived("/identity/connect/token");
  // Another account logs in while the refresh is out.
  local.account = { ...(local.account as object), refreshToken: "refresh-b" };
  session.session = { ...(session.session as object), accessToken: "token-b", accessExpiresAt: Date.now() + 3_600_000 };
  await answer("/identity/connect/token", tokens("user-a", "refresh-a2"));
  await assert.rejects(refreshing, /account changed/);
  assert.equal((local.account as { refreshToken?: string }).refreshToken, "refresh-b");
  assert.equal((session.session as { accessToken?: string }).accessToken, "token-b");
});

test("a refused refresh for a replaced account does not log the new one out", async () => {
  session.session = { ...(session.session as object), accessExpiresAt: 0 };
  const refreshing = accessToken();
  await arrived("/identity/connect/token");
  local.account = { ...(local.account as object), refreshToken: "refresh-c" };
  await answer("/identity/connect/token", { error: "invalid_grant" }, 400);
  await assert.rejects(refreshing);
  assert.ok(local.account, "still logged in");
  assert.equal((local.account as { refreshToken?: string }).refreshToken, "refresh-c");
});
