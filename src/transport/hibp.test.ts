import assert from "node:assert/strict";
import { test } from "node:test";
import { emailBreaches } from "./vault.ts";

const answer = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const withFetch = async (fn: typeof fetch, run: () => Promise<void>) => {
  const real = globalThis.fetch;
  globalThis.fetch = fn;
  try {
    await run();
  } finally {
    globalThis.fetch = real;
  }
};

test("emailBreaches: 404 is no breach, a list names the breaches, the key-less stand-in says unconfigured", async () => {
  await withFetch(answer(404, null), async () => assert.deepEqual(await emailBreaches("https://vw.test", "t", "a@b.test"), { status: "none" }));
  await withFetch(answer(200, [{ Name: "Adobe", Title: "Adobe Inc." }, { name: "Other" }]), async () =>
    assert.deepEqual(await emailBreaches("https://vw.test", "t", "a@b.test"), { status: "found", names: ["Adobe Inc.", "Other"] }));
  await withFetch(answer(200, [{ name: "HaveIBeenPwned", dataClasses: ["Error - No API key set!"] }]), async () =>
    assert.deepEqual(await emailBreaches("https://vw.test", "t", "a@b.test"), { status: "unconfigured" }));
});

test("emailBreaches: the address is URL-encoded and a server error is thrown, not hidden", async () => {
  let url = "";
  await withFetch(async (u) => ((url = String(u)), new Response("[]", { status: 200 })), async () => void (await emailBreaches("https://vw.test", "t", "a+b@c.test")));
  assert.match(url, /username=a%2Bb%40c\.test$/);
  await withFetch(answer(502, { message: "bad gateway" }), async () => assert.rejects(emailBreaches("https://vw.test", "t", "a@b.test")));
});
