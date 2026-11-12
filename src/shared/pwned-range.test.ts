import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRequest } from "./messages.ts";
import { parseRange, sha1Hex } from "./pwned-range.ts";

test("parseRange keeps real rows, drops padding, upper-cases the suffix", () => {
  const m = parseRange("00ab:3\r\nFFFF:0\nDEAD:12\n\nbroken");
  assert.deepEqual([...m], [["00AB", 3], ["DEAD", 12]]);
});

test("sha1Hex is the upper-case hex digest", async () => {
  assert.equal(await sha1Hex("password"), "5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8");
});

test("exposedRange accepts one 5-digit prefix and refuses anything else", () => {
  parseRequest({ type: "exposedRange", prefix: "5BAA6", body: "x:1" });
  for (const prefix of ["5baa6", "5BAA", "5BAA61", "../..", ""]) assert.throws(() => parseRequest({ type: "exposedRange", prefix, body: "" }), /SHA-1 prefix/);
  assert.throws(() => parseRequest({ type: "exposedRange", prefix: "5BAA6", body: "x".repeat(512 * 1024 + 1) }), /too long/);
});

test("archive requests take an item id only", () => {
  parseRequest({ type: "archiveItem", id: "c1" });
  parseRequest({ type: "unarchiveItem", id: "c1" });
  assert.throws(() => parseRequest({ type: "archiveItem" }));
});
