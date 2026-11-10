// guardClicks (SECURITY.md invariant 4): a click in menu.html / bar.html counts only once the browser has reported the
// frame really visible (IntersectionObserver v2) for 300 ms, and the wait starts again when the menu moves.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

let report: ((es: { isVisible?: boolean }[]) => void) | undefined;
let observerOptions: { trackVisibility?: boolean } | undefined;
const listeners: Record<string, ((e: unknown) => void)[]> = {};
const set = (k: string, v: unknown) => Object.defineProperty(globalThis, k, { value: v, configurable: true, writable: true });
set("chrome", { i18n: { getMessage: () => "" } });
set("localStorage", { getItem: () => null });
set("location", { search: "" });
set("document", { documentElement: { dataset: {} }, body: { classList: { contains: () => false } } });
set(
  "IntersectionObserver",
  class {
    constructor(cb: typeof report, options: typeof observerOptions) {
      report = cb;
      observerOptions = options;
    }
    observe() {}
  },
);
set("addEventListener", (type: string, fn: (e: unknown) => void) => (listeners[type] ??= []).push(fn));

let now = 1000;
Date.now = () => now;
const { guardClicks, leave, plural, wordsStartWith } = await import("./dom.ts");
guardClicks();

/** True when the guard let the click through to the buttons. */
function click(): boolean {
  let blocked = false;
  for (const fn of listeners.click ?? []) fn({ stopImmediatePropagation: () => (blocked = true), preventDefault: () => undefined });
  return !blocked;
}

test("clickjacking: the frame asks the browser to track real visibility", () => {
  assert.equal(observerOptions?.trackVisibility, true);
});

test("clickjacking: no click before the frame was reported visible, and none in its first 300 ms", () => {
  assert.equal(click(), false, "no visibility report yet");
  report!([{ isVisible: true }]);
  now += 299;
  assert.equal(click(), false, "299 ms after it became visible");
  now += 1;
  assert.equal(click(), true, "300 ms after it became visible");
});

test("clickjacking: a covered or transparent frame takes no click, and the wait starts over", () => {
  report!([{ isVisible: false }]);
  now += 10_000;
  assert.equal(click(), false);
  report!([{ isVisible: true }]);
  now += 100;
  assert.equal(click(), false);
  now += 200;
  assert.equal(click(), true);
});

test("clickjacking: a menu that moved waits 300 ms again", () => {
  for (const fn of listeners.message ?? []) fn({});
  now += 299;
  assert.equal(click(), false);
  now += 1;
  assert.equal(click(), true);
});

test("leave: a second removal while a row is still leaving is ignored, so it cannot remove the wrong row", () => {
  set("matchMedia", () => ({ matches: false }));
  let leaving: string | null = null;
  (document as unknown as { querySelector: (s: string) => unknown }).querySelector = (s) => (s === ".leaving" ? leaving : null);
  const row = (name: string) => ({ classList: { add: (c: string) => c === "leaving" && (leaving = name) } }) as unknown as Element;
  const removed: string[] = [];
  mock.timers.enable({ apis: ["setTimeout"] });
  try {
    leave(row("a"), () => removed.push("a"));
    leave(row("b"), () => removed.push("b"));
    mock.timers.tick(120);
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual(removed, ["a"]);
});

test("settings search matches the start of words only", () => {
  assert.ok(wordsStartWith("Lock when the computer locks", "lock"));
  assert.ok(wordsStartWith("Auto-lock", "lock"));
  assert.ok(!wordsStartWith("Blocked websites", "lock"));
  assert.ok(wordsStartWith("Kilit ekranı", "KILIT EKRANI"));
  assert.ok(wordsStartWith("Unlock with PIN", "pin unl"));
  assert.ok(!wordsStartWith("Unlock with PIN", "pin lock"));
  assert.ok(wordsStartWith("anything", "  "));
});

test("plural picks the _one message for a count of one only", () => {
  assert.equal(plural("days", 1), "days_one");
  assert.equal(plural("days", 0), "days");
  assert.equal(plural("days", 2), "days");
});
