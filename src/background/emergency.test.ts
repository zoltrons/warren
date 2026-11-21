// Emergency access refuses what a server could slip in: a grantee key whose phrase the user did not see, a takeover
// under a weak KDF, and a takeover of a grant that is not approved. Nothing is wrapped or sent then.
import "../shared/uint8-polyfill.ts"; // Node 24 in CI
import assert from "node:assert/strict";
import { test } from "node:test";
import { i18n } from "./i18n-stub.test.ts";

const area = (data: Record<string, unknown>) => ({
  get: async (key: string | null) => (key === null ? { ...data } : { [key]: data[key] }),
  set: async (values: Record<string, unknown>) => void Object.assign(data, structuredClone(values)),
  remove: async () => undefined,
  setAccessLevel: async () => undefined,
});
const noop = async () => undefined;
const coreOps: string[] = [];
(globalThis as { chrome?: unknown }).chrome = {
  i18n,
  storage: {
    session: area({ session: { unlocked: true, accessToken: "tok", accessExpiresAt: Date.now() + 3_600_000 } }),
    local: area({ server: { url: "https://vault.test" } }),
  },
  alarms: { create: noop, clear: noop },
  offscreen: { Reason: { WORKERS: "WORKERS", CLIPBOARD: "CLIPBOARD" }, hasDocument: async () => true, createDocument: noop, closeDocument: noop },
  runtime: {
    // The crypto worker: a key's phrase is "phrase-of-<key>"; wrapping and takeover just answer.
    sendMessage: async ({ req }: { req: { op: string; publicKey?: string } }) => {
      coreOps.push(req.op);
      const value = req.op === "authRequestFingerprint" ? `phrase-of-${req.publicKey}` : req.op === "authRequestApprove" ? "4.wrapped" : { masterPasswordHash: "h", key: "2.k|k|k" };
      return { ok: true, value };
    },
  },
};

/** The server: answers per "METHOD path", and records what was sent. */
let answers: Record<string, unknown> = {};
const sent: string[] = [];
globalThis.fetch = (async (url: string, init?: RequestInit) => {
  const key = `${init?.method ?? "GET"} ${new URL(url).pathname}`;
  sent.push(key);
  return new Response(JSON.stringify(answers[key] ?? {}), { status: 200, headers: { "content-type": "application/json" } });
}) as typeof fetch;

const { emergencyConfirm, emergencyTakeover } = await import("./emergency.ts");

const lists = (trusted: unknown[], granted: unknown[]) => ({ "GET /api/emergency-access/trusted": { data: trusted }, "GET /api/emergency-access/granted": { data: granted } });
const reset = () => void ((sent.length = 0), (coreOps.length = 0));

test("confirm wraps the user key only for the key whose phrase the user saw", async () => {
  answers = { ...lists([{ id: "g1", status: 1, type: 0, waitTimeDays: 7, granteeId: "u2" }], []), "GET /api/users/u2/public-key": { publicKey: "SERVER-KEY" } };
  reset();
  await assert.rejects(emergencyConfirm("g1", "phrase-of-OTHER-KEY"), /changed on the server/);
  assert.ok(!coreOps.includes("authRequestApprove"), "the user key was wrapped");
  assert.ok(!sent.some((s) => s.endsWith("/confirm")), "a key went to the server");
  reset();
  await emergencyConfirm("g1", "phrase-of-SERVER-KEY");
  assert.ok(coreOps.includes("authRequestApprove") && sent.includes("POST /api/emergency-access/g1/confirm"));
  // Only a grant that waits for confirmation.
  answers = { ...answers, ...lists([{ id: "g1", status: 2, type: 0, waitTimeDays: 7, granteeId: "u2" }], []) };
  reset();
  await assert.rejects(emergencyConfirm("g1", "phrase-of-SERVER-KEY"));
  assert.ok(!coreOps.includes("authRequestApprove"));
});

test("takeover: only an approved takeover grant, and never under a KDF below the floor", async () => {
  const granted = (status: number, type: number) => lists([], [{ id: "g2", status, type, waitTimeDays: 1, email: "grantor@example.test" }]);
  const weak = { "POST /api/emergency-access/g2/takeover": { keyEncrypted: "4.k", kdf: 0, kdfIterations: 100_000 } };
  answers = { ...granted(4, 1), ...weak };
  reset();
  await assert.rejects(emergencyTakeover("g2", "a long new password"), /too weak/);
  assert.ok(!coreOps.includes("emergencyTakeover") && !sent.some((s) => s.endsWith("/password")), "a hash under a weak KDF was made or sent");
  for (const [status, type] of [[3, 1], [4, 0]]) {
    answers = { ...granted(status!, type!), "POST /api/emergency-access/g2/takeover": { keyEncrypted: "4.k", kdf: 0, kdfIterations: 600_000 } };
    reset();
    await assert.rejects(emergencyTakeover("g2", "a long new password"));
    assert.ok(!sent.some((s) => s.endsWith("/takeover") || s.endsWith("/password")), `status ${status} type ${type} went on`);
  }
  answers = { ...granted(4, 1), "POST /api/emergency-access/g2/takeover": { keyEncrypted: "4.k", kdf: 0, kdfIterations: 600_000 } };
  reset();
  await assert.rejects(emergencyTakeover("g2", "short"), /12 characters/);
  await emergencyTakeover("g2", "a long new password");
  assert.ok(sent.includes("POST /api/emergency-access/g2/password"));
});
