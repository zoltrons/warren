// Live updates from Vaultwarden's WebSocket hub (/notifications/hub). The socket lives in the service worker:
// its pings every 20 s count as activity (Chrome 116+), so the worker stays up while an account is logged in.
// PUSH_ALARM reconnects after a drop or a worker restart; index.ts decides what an update does.
import { HANDSHAKE, type HubUpdate, parseHubMessages, PING } from "../transport/hub.ts";

export const PUSH_ALARM = "push";
const PING_MS = 20_000;
/** Hub updates are a few hundred bytes; anything far larger is not one (invariant 7: bounded server data). */
const MAX_MESSAGE_BYTES = 64 * 1024;
/** A server without WebSockets refuses every attempt: try at most this often outside the alarm. */
const RETRY_MS = 30_000;

let socket: WebSocket | undefined;
/** Whose updates the socket carries ("<server>|<email>"): a socket of an earlier login must never stay in use. */
let socketOwner = "";
let lastTry = 0;

export const pushUp = (owner: string) => !!socket && socket.readyState <= WebSocket.OPEN && socketOwner === owner;

/** Vaultwarden echoes every binary message (notifications.rs), so our pings come back: two missed means a dead link. */
const SILENT_MS = 2 * PING_MS + 5_000;

interface Handlers {
  onUpdate: (u: HubUpdate) => void;
  /** Runs once the hub connection is up: updates sent while it was down are lost and need a sync. */
  onOpen: () => void;
  /** The connection ended without stopPush: reconnect (startPush still waits RETRY_MS between attempts). */
  onDrop: () => void;
}

/** Opens the hub connection for `owner` unless it is up (or was just tried). `base` is the configured server. */
export function startPush(base: string, owner: string, token: string, on: Handlers): void {
  if (pushUp(owner)) return;
  if (socketOwner !== owner) stopPush();
  if (Date.now() - lastTry < RETRY_MS) return;
  lastTry = Date.now();
  // Browsers cannot set headers on a WebSocket; Vaultwarden takes the token from the query like the official clients send it.
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/notifications/hub?access_token=${encodeURIComponent(token)}`);
  ws.binaryType = "arraybuffer";
  let pinger: ReturnType<typeof setInterval> | undefined;
  let heard = Date.now();
  // Once: from onclose, or right away when the link went silent (a half-open TCP connection after sleep or a
  // network change closes only after minutes, and its close handshake cannot complete).
  const drop = () => {
    clearInterval(pinger);
    if (socket !== ws) return; // stopPush or a newer socket: nothing to reconnect
    socket = undefined;
    ws.close();
    on.onDrop();
  };
  ws.onopen = () => {
    heard = Date.now();
    ws.send(HANDSHAKE);
    pinger = setInterval(() => (Date.now() - heard > SILENT_MS ? drop() : ws.send(PING)), PING_MS);
    on.onOpen();
  };
  ws.onmessage = (ev: MessageEvent) => {
    heard = Date.now();
    if (!(ev.data instanceof ArrayBuffer)) return;
    if (ev.data.byteLength > MAX_MESSAGE_BYTES) return ws.close();
    let updates: HubUpdate[];
    try {
      updates = parseHubMessages(new Uint8Array(ev.data));
    } catch {
      return; // not something we understand: the next full sync catches up anyway
    }
    for (const u of updates) on.onUpdate(u);
  };
  ws.onclose = drop;
  socket = ws;
  socketOwner = owner;
  void chrome.alarms.create(PUSH_ALARM, { periodInMinutes: 1 });
}

export function stopPush(): void {
  void chrome.alarms.clear(PUSH_ALARM);
  const ws = socket;
  socket = undefined;
  socketOwner = "";
  lastTry = 0;
  ws?.close();
}
