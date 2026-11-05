import assert from "node:assert/strict";
import { test } from "node:test";
import { decode, parseHubMessages } from "./hub.ts";

// Just enough MessagePack to build what Vaultwarden's create_update() sends.
const enc = (v: unknown): number[] => {
  if (v === null) return [0xc0];
  if (typeof v === "number") return [v];
  if (typeof v === "string") {
    const s = [...new TextEncoder().encode(v)];
    return [0xd9, s.length, ...s];
  }
  if (Array.isArray(v)) return [0x90 | v.length, ...v.flatMap(enc)];
  if (v instanceof Uint8Array) return [0xd7, 0xff, ...v]; // timestamp ext (-1, 8 bytes)
  const e = Object.entries(v as object);
  return [0x80 | e.length, ...e.flatMap(([k, x]) => [...enc(k), ...enc(x)])];
};
const frame = (v: unknown) => {
  const body = enc(v);
  return [body.length & 0x7f | (body.length > 127 ? 0x80 : 0), ...(body.length > 127 ? [body.length >> 7] : []), ...body];
};
const update = (type: number, payload: object, contextId: string | null = null) =>
  [1, {}, null, "ReceiveMessage", [{ ContextId: contextId, Type: type, Payload: payload }]];

test("parseHubMessages reads Vaultwarden updates, several per message", () => {
  const date = new Uint8Array(8);
  const buf = new Uint8Array([
    0x7b, 0x7d, 0x1e, // handshake answer
    ...frame(update(0, { Id: "c1", UserId: "u1", OrganizationId: null, CollectionIds: null, RevisionDate: date }, "dev-2")),
    ...frame(update(15, { Id: "req-1", UserId: "u1" }, "dev-3")),
    ...frame([6]), // a ping
    ...frame(update(5, { UserId: "u1", Date: date })),
  ]);
  assert.deepEqual(parseHubMessages(buf), [
    { type: 0, contextId: "dev-2", id: "c1" },
    { type: 15, contextId: "dev-3", id: "req-1" },
    { type: 5 },
  ]);
});

test("parseHubMessages refuses truncated and hostile data", () => {
  const ok = frame(update(0, { Id: "c1" }));
  assert.throws(() => parseHubMessages(new Uint8Array(ok.slice(0, -2))));
  assert.throws(() => parseHubMessages(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0xff, 0x01])));
  // array32 claiming 4 billion elements in a 6-byte message
  assert.throws(() => decode(new Uint8Array([0xdd, 0xff, 0xff, 0xff, 0xff, 0x00])));
  // nesting bomb
  assert.throws(() => decode(new Uint8Array(100).fill(0x91)));
  // a "__proto__" key stays a plain key
  const o = decode(new Uint8Array([0x81, ...enc("__proto__"), 0x01])) as Record<string, unknown>;
  assert.equal(Object.getPrototypeOf(o), null);
  assert.equal(Object.getOwnPropertyDescriptor(o, "__proto__")?.value, 1);
});
