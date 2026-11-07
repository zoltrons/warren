import assert from "node:assert/strict";
import { test } from "node:test";

const local: Record<string, unknown> = {};
const tick = () => new Promise((r) => setTimeout(r));
// A stand-in for the crypto worker: "encrypts" by base64 with a marker; a foreign value fails like a wrong key.
const enc = (s: string) => `2.${Buffer.from(s).toString("base64")}`;
const dec = (s: string) => (s.startsWith("2.") ? Buffer.from(s.slice(2), "base64").toString() : "");
(globalThis as { chrome?: unknown }).chrome = {
  offscreen: { hasDocument: async () => true },
  runtime: {
    sendMessage: async ({ req }: { req: { op: string; values: string[] } }) => {
      await tick();
      return { ok: true, value: req.values.map(req.op === "encryptText" ? enc : dec) };
    },
  },
  storage: {
    local: {
      get: async (key: string) => (await tick(), { [key]: local[key] }),
      set: async (v: Record<string, unknown>) => (await tick(), Object.assign(local, v)),
      remove: async (keys: string | string[]) => {
        for (const k of [keys].flat()) delete local[k];
      },
    },
  },
};

const { migratePrivate, readPrivate, sanitize, updatePrivate } = await import("./private.ts");

test("stored encrypted, and overlapping writes keep every change", async () => {
  await Promise.all([updatePrivate((d) => d.neverSave.push("a.example")), updatePrivate((d) => d.neverSave.push("b.example"))]);
  assert.deepEqual((await readPrivate()).neverSave, ["a.example", "b.example"]);
  assert.ok(typeof local.private === "string" && !(local.private as string).includes("example"));
});

test("an unreadable record is not written over", async () => {
  local.private = "not-ours";
  await assert.rejects(updatePrivate((d) => d.neverSave.push("c.example")));
  assert.equal(local.private, "not-ours");
  delete local.private;
});

test("clear-text data of older builds moves in, then goes", async () => {
  local.settings = { savePrompt: true, neverSave: ["old.example"] };
  local.lastUsed = { id1: 5 };
  await migratePrivate();
  const d = await readPrivate();
  assert.deepEqual(d.neverSave, ["old.example"]);
  assert.deepEqual(d.lastUsed, { id1: 5 });
  assert.equal(local.settings.savePrompt, true);
  assert.equal("neverSave" in local.settings, false);
  assert.equal(local.lastUsed, undefined);
});

test("damaged entries are dropped", () => {
  const d = sanitize({ neverSave: ["x", 3, "x", ""], blocked: 5, lastUsed: { a: 1, b: "2" }, opened: { a: { n: 1, at: 2 }, b: { n: "1" } }, generator: { email: 4, wordlist: -3, options: { length: 20, type: "passphrase", wordlist: ["a"], email: "x", "bad key": 1, nested: {} } } });
  assert.deepEqual(d, { neverSave: ["x"], blocked: [], lastUsed: { a: 1 }, opened: { a: { n: 1, at: 2 } }, generator: { options: { length: 20, type: "passphrase" }, email: "", domain: "", wordlist: 0 } });
});

test("never-save hosts have one form, whatever the port: settings, save bar and older builds' entries", async () => {
  const { hostOf } = await import("./private.ts");
  const page = "https://nas.example:5001/login";
  // The settings list (hostOf) and the save bar's check (inline.ts: URL hostname) must agree.
  assert.equal(hostOf("nas.example:5001"), new URL(page).hostname);
  assert.equal(hostOf(page), "nas.example");
  // Older save bars stored the host with its port.
  assert.deepEqual(sanitize({ neverSave: ["nas.example:5001", "nas.example", "[::1]:8080", "plain.example"] }).neverSave, ["nas.example", "[::1]", "plain.example"]);
});

test("the word list is stored encrypted, counted, and only added for a passphrase", async () => {
  const { setWordlist, withWordlist } = await import("./private.ts");
  const words = Array.from({ length: 120 }, (_, i) => `word${i}`);
  assert.equal((await setWordlist(words.join("\n"))).wordlist, 120);
  assert.ok(!(local.wordlist as string).includes("word1"));
  assert.deepEqual(((await withWordlist({ type: "passphrase" })).wordlist as string[]).length, 120);
  assert.equal((await withWordlist({ type: "password" })).wordlist, undefined);
  await assert.rejects(setWordlist("too\nfew"));
  assert.equal((await setWordlist("")).wordlist, 0);
  assert.equal(local.wordlist, undefined);
});

test("site lists: typed hosts are normalized, blocked hosts cover subdomains", async () => {
  const { hostOf, blockedHost } = await import("./private.ts");
  assert.equal(hostOf(" https://Login.Example.com/path?x "), "login.example.com");
  assert.equal(hostOf("example.com"), "example.com");
  assert.equal(hostOf("localhost:8099"), "localhost");
  assert.equal(hostOf("intranet"), undefined);
  assert.equal(hostOf("javascript:alert(1)"), undefined);
  assert.equal(hostOf(""), undefined);
  assert.ok(blockedHost("a.example.com", ["example.com"]));
  assert.ok(blockedHost("example.com", ["example.com"]));
  assert.ok(!blockedHost("badexample.com", ["example.com"]));
});
