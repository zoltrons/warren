import assert from "node:assert/strict";
import { test } from "node:test";
import { toneOf } from "./favicon.ts";

/** 16x16 icon: `n` pixels of `rgb`, the rest transparent (or `fill` when given). */
function icon(n: number, rgb: [number, number, number], fill?: [number, number, number]): Uint8ClampedArray {
  const px = new Uint8ClampedArray(16 * 16 * 4);
  for (let i = 0; i < 256; i++) {
    const c = i < n ? rgb : fill;
    if (c) px.set([...c, 255], i * 4);
  }
  return px;
}

test("favicon tone", () => {
  assert.equal(toneOf(icon(120, [20, 20, 20])), "tone-dark"); // black logo on transparent
  assert.equal(toneOf(icon(120, [250, 250, 250])), "tone-light"); // white logo on transparent
  assert.equal(toneOf(icon(120, [66, 133, 244])), ""); // colourful logo
  assert.equal(toneOf(icon(120, [0, 0, 0], [255, 255, 255])), ""); // opaque square brings its own backdrop
  assert.equal(toneOf(icon(0, [0, 0, 0])), ""); // empty
});
