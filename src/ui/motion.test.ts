import assert from "node:assert/strict";
import { test } from "node:test";
import { navMotion } from "./motion.ts";

test("screen motion: drill-down slides, tabs fade, locks and same-depth swaps are instant", () => {
  assert.equal(navMotion("vault:list", "vault:item:1"), "forward");
  assert.equal(navMotion("vault:item:1", "vault:edit:item"), "forward");
  assert.equal(navMotion("vault:edit:item", "vault:list"), "back");
  assert.equal(navMotion("vault:folders", "vault:list"), "back");
  assert.equal(navMotion("vault:list", "settings"), "fade");
  assert.equal(navMotion("generator", "send"), "fade");
  // A lock or a login screen never waits on a transition frame.
  assert.equal(navMotion("vault:item:1", "locked"), undefined);
  assert.equal(navMotion("locked", "vault:list"), undefined);
  assert.equal(navMotion("", "vault:list"), undefined);
  // The editor switching to its field picker stays put: the code after it reads the new DOM at once.
  assert.equal(navMotion("vault:edit:password", "vault:edit:new"), undefined);
  assert.equal(navMotion("vault:item:1", "vault:item:2"), undefined);
});
