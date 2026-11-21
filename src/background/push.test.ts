// The hub socket notices a silently dead link (pings that stop coming back) and asks to reconnect.
import assert from "node:assert/strict";
import { mock, test } from "node:test";

const noop = async () => undefined;
(globalThis as { chrome?: unknown }).chrome = { alarms: { create: noop, clear: noop } };

class FakeSocket {
  static readonly OPEN = 1;
  static last: FakeSocket;
  readyState = 0;
  sent: unknown[] = [];
  closed = false;
  binaryType = "";
  onopen?: () => void;
  onmessage?: (ev: { data: unknown }) => void;
  onclose?: () => void;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
  }
  send(d: unknown) {
    this.sent.push(d);
  }
  /** Like a half-open TCP link: close() starts a handshake that never completes, so onclose does not fire. */
  close() {
    this.closed = true;
    this.readyState = 2;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}
(globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;

mock.timers.enable({ apis: ["setInterval", "Date"], now: Date.now() });
const { pushUp, startPush, stopPush } = await import("./push.ts");

const counts = () => {
  const c = { open: 0, drop: 0 };
  return { c, on: { onUpdate: () => undefined, onOpen: () => c.open++, onDrop: () => c.drop++ } };
};

test("a link whose pings stop coming back is dropped and reported once", () => {
  const { c, on } = counts();
  startPush("https://vw.example", "a", "tok", on);
  const ws = FakeSocket.last;
  assert.match(ws.url, /^wss:\/\/vw\.example\/notifications\/hub\?access_token=tok$/);
  ws.open();
  assert.equal(c.open, 1);
  // Echoes keep it alive.
  for (let i = 0; i < 5; i++) {
    mock.timers.tick(20_000);
    ws.onmessage?.({ data: new Uint8Array([0x02, 0x91, 0x06]).buffer });
  }
  assert.ok(pushUp("a"));
  assert.equal(c.drop, 0);
  // Silence: two pings unanswered.
  mock.timers.tick(60_000);
  assert.equal(c.drop, 1);
  assert.ok(ws.closed);
  assert.equal(pushUp("a"), false, "a new startPush may open a fresh socket at once");
  ws.onclose?.(); // the late close of the dead socket
  assert.equal(c.drop, 1);
  stopPush();
});

test("stopPush is not reported as a drop", () => {
  const { c, on } = counts();
  startPush("http://127.0.0.1:8000", "b", "tok", on);
  const ws = FakeSocket.last;
  assert.match(ws.url, /^ws:\/\/127\.0\.0\.1:8000\//);
  ws.open();
  stopPush();
  ws.onclose?.();
  assert.equal(c.drop, 0);
});

test("a server that closes the socket is reported, and retries stay spaced out", () => {
  const { c, on } = counts();
  startPush("https://vw.example", "c", "tok", on);
  const first = FakeSocket.last;
  first.onclose?.();
  assert.equal(c.drop, 1);
  startPush("https://vw.example", "c", "tok", on);
  assert.equal(FakeSocket.last, first, "no new attempt within RETRY_MS");
  mock.timers.tick(30_001);
  startPush("https://vw.example", "c", "tok", on);
  assert.notEqual(FakeSocket.last, first);
  stopPush();
});
