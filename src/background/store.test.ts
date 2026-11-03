import assert from "node:assert/strict";
import { test } from "node:test";

const session: Record<string, unknown> = {};
const local: Record<string, unknown> = {};
const area = (data: Record<string, unknown>) => ({
  // Real storage calls are async, so overlapping read-then-write calls can interleave.
  get: async (key: string | null) => {
    await new Promise((r) => setTimeout(r));
    return key === null ? { ...data } : { [key]: data[key] };
  },
  set: async (values: Record<string, unknown>) => {
    await new Promise((r) => setTimeout(r));
    Object.assign(data, values);
  },
  remove: async (keys: string[]) => {
    for (const k of keys) delete data[k];
  },
});
(globalThis as { chrome?: unknown }).chrome = { storage: { session: area(session), local: area(local) } };

const { clearPendingSaves, getSettings, updateSession } = await import("./store.ts");

test("overlapping session writes keep every change", async () => {
  await updateSession({ unlocked: true });
  await Promise.all([updateSession({ unlocked: false }), updateSession({ accessToken: "t" })]);
  assert.deepEqual(session.session, { unlocked: false, accessToken: "t" });
});

test("a failed write does not block the next one", async () => {
  const set = (globalThis as any).chrome.storage.session.set;
  (globalThis as any).chrome.storage.session.set = async () => {
    throw new Error("quota");
  };
  await assert.rejects(updateSession({ accessToken: "lost" }));
  (globalThis as any).chrome.storage.session.set = set;
  assert.equal((await updateSession({ accessToken: "kept" })).accessToken, "kept");
});

test("clearPendingSaves removes only waiting logins", async () => {
  Object.assign(session, { "save:1": {}, "save:2": {}, "inline:1": {} });
  await clearPendingSaves();
  assert.deepEqual(Object.keys(session).sort(), ["inline:1", "session"]);
});

test("the removed 10 and 20 second clipboard delays become 30 seconds", async () => {
  for (const old of ["tenSeconds", "twentySeconds"]) {
    local.settings = { clearClipboardDelay: old };
    assert.equal((await getSettings()).clearClipboardDelay, "thirtySeconds");
  }
  local.settings = { clearClipboardDelay: "oneMinute" };
  assert.equal((await getSettings()).clearClipboardDelay, "oneMinute");
});

test("overlapping settings writes keep every change, and never store the never-save list", async () => {
  const { updateSettings } = await import("./store.ts");
  local.settings = {};
  await Promise.all([updateSettings(() => ({ favicons: false })), updateSettings(() => ({ autosubmit: true }))]);
  const saved = local.settings as Record<string, unknown>;
  assert.equal(saved.favicons, false);
  assert.equal(saved.autosubmit, true);
  assert.equal("neverSave" in saved, false);
});

test("with 'log out' as timeout action the refresh token is kept in memory only, and moves back", async () => {
  (globalThis as any).chrome.offscreen = { hasDocument: async () => true };
  const { relocateRefreshToken } = await import("./account.ts");
  local.account = { email: "a@b.c", refreshToken: "rt" };
  local.settings = { timeoutAction: "logout" };
  await relocateRefreshToken();
  assert.equal((local.account as Record<string, unknown>).refreshToken, undefined);
  assert.equal((session.session as Record<string, unknown>).refreshToken, "rt");
  local.settings = { timeoutAction: "lock" };
  await relocateRefreshToken();
  assert.equal((local.account as Record<string, unknown>).refreshToken, "rt");
  assert.equal((session.session as Record<string, unknown>).refreshToken, undefined);
});

test("a missing refresh token logs out only when it was meant to be in memory", async () => {
  const { accessToken } = await import("./account.ts");
  (globalThis as any).chrome.alarms = { clear: async () => true };
  (globalThis as any).chrome.offscreen.hasDocument = async () => false;
  (globalThis as any).chrome.tabs = { query: async () => [] };
  local.server = { url: "https://vault.example", version: "1", name: "t" };
  local.account = { email: "a@b.c" };
  session.session = { unlocked: true };
  local.settings = { timeoutAction: "lock" };
  await assert.rejects(accessToken(), /log in again/);
  assert.ok(local.account, "an account without a stored token (lock action) must stay");
  local.settings = { timeoutAction: "logout" };
  await assert.rejects(accessToken(), /log in again/);
  assert.equal(local.account, undefined);
});
