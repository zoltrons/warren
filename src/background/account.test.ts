// Races between a lock (or an account change) and work already in flight: the lock and the newer account win.
// Runs the real account.ts / lock.ts / store.ts against an in-memory chrome, a scripted offscreen worker and a
// fetch whose answers the test releases by hand.
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

let offscreen = false;
const coreOps: string[] = [];
const noop = async () => undefined;
(globalThis as { chrome?: unknown }).chrome = {
  storage: { session: area(session), local: area(local) },
  alarms: { create: noop, clear: noop },
  tabs: { query: async () => [], sendMessage: noop, remove: noop },
  scripting: { unregisterContentScripts: noop },
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
      const value = req.op === "prepareKey" ? { handle: 1, authHash: "hash" } : req.op === "encryptText" ? (req as { values?: string[] }).values : null;
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

const { auth, confirmReprompt, finishSso, login, logout, unlock, unlockWithBiometric } = await import("./account.ts");
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
  const account = local.account as { refreshToken?: string; refreshTokenEnc?: string };
  assert.equal(account.refreshToken, undefined, "no clear-text refresh token on disk");
  assert.ok(account.refreshTokenEnc, "the refresh token is sealed with the user key");
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

test("an unlock that a lock overtakes during its first read does not unlock", async () => {
  const account = local.account;
  local.biometric = { email: "a@b.test", credentialId: "c", prfSalt: "s", protectedUserKey: "2.k|k|k", createdAt: 0 };
  for (const start of [() => unlock("pw"), () => unlockWithBiometric("prf")]) {
    await lockNow();
    const running = start();
    // The lock comes while the unlock still reads the account: it must own the epoch from before that read.
    await lockNow();
    await assert.rejects(running, /locked meanwhile/);
    assert.equal((session.session as { unlocked?: boolean }).unlocked, false);
    assert.equal(offscreen, false);
  }
  assert.equal(local.account, account);
});

/** The account that logs in after a logout: what a login stores. */
function accountB() {
  local.account = { email: "b@b.test", userId: "user-b", kdf: { type: 0, iterations: 600_000, memory: 0, parallelism: 0 }, protectedUserKey: "2.k|k|k" };
  session.session = { unlocked: false, accessToken: "token-b", accessExpiresAt: Date.now() + 3_600_000, refreshToken: "refresh-b" };
}

test("a refresh answer for an account that was replaced meanwhile is dropped", async () => {
  session.session = { ...(session.session as object), accessToken: "old", accessExpiresAt: 0, refreshToken: "refresh-a" };
  const refreshing = auth();
  await arrived("/identity/connect/token");
  // Another account logs in while the refresh is out (every switch begins with a logout).
  await logout();
  accountB();
  await answer("/identity/connect/token", tokens("user-a", "refresh-a2"));
  await assert.rejects(refreshing, /account changed/);
  assert.equal((session.session as { refreshToken?: string }).refreshToken, "refresh-b");
  assert.equal((session.session as { accessToken?: string }).accessToken, "token-b");
});

test("a refused refresh for a replaced account does not log the new one out", async () => {
  session.session = { ...(session.session as object), accessExpiresAt: 0 };
  const refreshing = auth();
  await arrived("/identity/connect/token");
  await logout();
  accountB();
  session.session = { ...(session.session as object), refreshToken: "refresh-c" };
  await answer("/identity/connect/token", { error: "invalid_grant" }, 400);
  await assert.rejects(refreshing);
  assert.ok(local.account, "still logged in");
  assert.equal((session.session as { refreshToken?: string }).refreshToken, "refresh-c");
});

test("a server and a token are only handed out together, for one account", async () => {
  accountB();
  const reading = auth();
  // Logged out (and maybe pointed at another server) between reading the server and the token.
  void logout();
  await assert.rejects(reading, /account changed/);
});

test("an SSO callback that comes after a logout logs nobody in", async () => {
  await logout();
  session.session = { unlocked: false, sso: { state: "st:clientId=browser", verifier: "v", expiresAt: Date.now() + 60_000 } };
  await logout(); // e.g. the user gave up on SSO and logged out
  await finishSso("https://vault.test/sso-connector.html?code=c&state=st%3AclientId%3Dbrowser", 1);
  assert.equal(local.account, undefined);
  assert.match(String((session.session as { ssoError?: string }).ssoError), /expired/);
});

test("a lock that came while a login read the server ends that login", async () => {
  await logout();
  local.server = { url: "https://vault.test" };
  const running = login("a@b.test", "pw");
  void lockNow(); // lands while the login still reads the server
  await assert.rejects(running, /locked meanwhile/);
  assert.equal(waiting.get("/identity/accounts/prelogin")?.length ?? 0, 0, "nothing was sent");
});

test("an account stored with a too weak KDF sends no hash to confirm the master password", async () => {
  accountB();
  (local.account as { kdf: { iterations: number } }).kdf.iterations = 5000; // stored by a build before the floor
  coreOps.length = 0;
  await assert.rejects(confirmReprompt("cipher-1", "pw"), /too weak/);
  assert.ok(!coreOps.includes("prepareKey"));
});

test("a lock whose bookkeeping fails still shuts the worker down", async () => {
  offscreen = true;
  const set = chrome.storage.session.set;
  chrome.storage.session.set = async () => {
    throw new Error("quota");
  };
  try {
    await assert.rejects(lockNow(), /quota/);
  } finally {
    chrome.storage.session.set = set;
  }
  assert.equal(offscreen, false, "the worker and its keys are gone");
});

test("Duo: only Duo's authorize endpoint is opened, and the challenge carries its URL", async () => {
  const { duoUrl } = await import("./account.ts");
  const { parseTwoFactorChallenge } = await import("../transport/auth.ts");
  const ok = "https://api-1a2b3c.duosecurity.com/oauth/v1/authorize?client_id=x&request=y";
  assert.equal(duoUrl(ok), ok);
  for (const bad of [
    "http://api-1a2b3c.duosecurity.com/oauth/v1/authorize",
    "https://api-1a2b3c.duosecurity.com.evil.test/oauth/v1/authorize",
    "https://user:pw@api-1a2b3c.duosecurity.com/oauth/v1/authorize",
    "https://api-1a2b3c.duosecurity.com:8443/oauth/v1/authorize",
    "https://api-1a2b3c.duosecurity.com/elsewhere",
    "https://evil.test/oauth/v1/authorize",
  ])
    assert.throws(() => duoUrl(bad), /not Duo/);
  const c = parseTwoFactorChallenge({ TwoFactorProviders: [0, 6], TwoFactorProviders2: { "6": { AuthUrl: ok }, "0": null } });
  assert.deepEqual(c?.duo, { provider: 6, url: ok });
  assert.equal(parseTwoFactorChallenge({ TwoFactorProviders: [2], TwoFactorProviders2: { "2": {} } })?.duo, undefined);
});

test("Duo: the result is taken only from our tab, on the server's own connector page", async () => {
  const { duoTabUpdated } = await import("./account.ts");
  local.server = { url: "https://vault.example.test/vw" };
  const sess = () => (session.session ?? {}) as { duo?: unknown; ssoError?: string };
  session.session = { ...sess(), duo: { tabId: 7, provider: 2, remember: false } };
  const ok = "https://vault.example.test/vw/duo-redirect-connector.html?client=browser&code=c&state=s";
  // Another tab, another page, a missing state: ignored, the prompt keeps waiting.
  for (const [tab, url] of [
    [8, ok],
    [7, "https://vault.example.test/vw/elsewhere?code=c&state=s"],
    [7, "https://vault.example.test/vw/duo-redirect-connector.html?client=browser&code=c"],
  ] as const) {
    await duoTabUpdated(tab, url);
    assert.ok(sess().duo, `${tab} ${url}`);
  }
  // The connector on another address (DOMAIN differs): not used, but the popup is told why.
  await duoTabUpdated(7, "https://evil.test/vw/duo-redirect-connector.html?client=browser&code=c&state=s");
  assert.equal(sess().duo, undefined);
  assert.match(String(sess().ssoError), /DOMAIN/);
  session.session = { ...sess(), ssoError: undefined, duo: { tabId: 7, provider: 2, remember: false } };
  // The right page ends the wait; without a pending login the failure is kept for the popup.
  await duoTabUpdated(7, ok);
  assert.equal(sess().duo, undefined);
  assert.ok(sess().ssoError);
  delete sess().ssoError;
  delete local.server;
});
