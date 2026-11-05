// SignalR MessagePack hub protocol: the subset Vaultwarden's /notifications/hub speaks
// (vaultwarden src/api/notifications.rs). Server -> client only; we send the handshake and pings.

export const HANDSHAKE = '{"protocol":"messagepack","version":1}\x1e';
/** A length-prefixed SignalR ping ([6]). Vaultwarden echoes it, so traffic flows both ways. */
export const PING = new Uint8Array([0x02, 0x91, 0x06]);

/** Vaultwarden UpdateType values we act on. 0-14 except 11 change the vault, settings or sends. */
export const HUB = { LogOut: 11, AuthRequest: 15, AuthRequestResponse: 16 } as const;

export interface HubUpdate {
  type: number;
  /** Device that caused it (absent for some). */
  contextId?: string;
  /** Payload.Id: the cipher, folder, send or auth request. */
  id?: string;
}

/** The `ReceiveMessage` invocations in one binary WebSocket message. Throws on malformed data. */
export function parseHubMessages(buf: Uint8Array): HubUpdate[] {
  const out: HubUpdate[] = [];
  // Vaultwarden sends the handshake answer `{}\x1e` as a binary frame too.
  let at = buf[0] === 0x7b ? buf.indexOf(0x1e) + 1 || buf.length : 0;
  while (at < buf.length) {
    // Each message is prefixed with its length as a 7-bit varint (at most 5 bytes).
    let len = 0;
    for (let shift = 0; ; shift += 7) {
      const b = buf[at++];
      if (b === undefined || shift > 28) throw new Error("bad frame length");
      len += (b & 0x7f) * 2 ** shift;
      if (!(b & 0x80)) break;
    }
    const end = at + len;
    if (end > buf.length) throw new Error("truncated frame");
    const msg = decode(buf.subarray(at, end));
    at = end;
    // [1 = Invocation, headers, invocationId, target, [ { ContextId, Type, Payload } ]]
    if (!Array.isArray(msg) || msg[0] !== 1 || msg[3] !== "ReceiveMessage") continue;
    const arg = (Array.isArray(msg[4]) ? msg[4][0] : undefined) as Record<string, unknown> | undefined;
    if (typeof arg?.Type !== "number") continue;
    const payload = arg.Payload as Record<string, unknown> | undefined;
    out.push({
      type: arg.Type,
      ...(typeof arg.ContextId === "string" ? { contextId: arg.ContextId } : {}),
      ...(typeof payload?.Id === "string" ? { id: payload.Id } : {}),
    });
  }
  return out;
}

/** MessagePack to plain values. Binary and extension values (dates) come back as null. */
export function decode(b: Uint8Array): unknown {
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let at = 0;
  const take = (n: number) => {
    if (at + n > b.length) throw new Error("truncated");
    at += n;
    return at - n;
  };
  const u8 = () => view.getUint8(take(1));
  const u16 = () => view.getUint16(take(2));
  const u32 = () => view.getUint32(take(4));
  const skip = (n: number) => (take(n), null);
  const text = (n: number) => new TextDecoder().decode(b.subarray(take(n), at));
  // Every element takes at least a byte: a count beyond what is left is malformed (and never allocated).
  const count = (n: number) => {
    if (n > b.length - at) throw new Error("truncated");
    return n;
  };
  const list = (n: number, d: number) => Array.from({ length: count(n) }, () => read(d + 1));
  const map = (n: number, d: number) => {
    const o: Record<string, unknown> = Object.create(null);
    for (let i = count(n); i > 0; i--) {
      const k = read(d + 1);
      o[String(k)] = read(d + 1);
    }
    return o;
  };
  function read(d: number): unknown {
    if (d > 32) throw new Error("too deep");
    const t = u8();
    if (t < 0x80) return t;
    if (t < 0x90) return map(t & 0x0f, d);
    if (t < 0xa0) return list(t & 0x0f, d);
    if (t < 0xc0) return text(t & 0x1f);
    if (t >= 0xe0) return t - 0x100;
    switch (t) {
      case 0xc0: return null;
      case 0xc2: return false;
      case 0xc3: return true;
      case 0xc4: return skip(u8());
      case 0xc5: return skip(u16());
      case 0xc6: return skip(u32());
      case 0xc7: return skip(u8() + 1);
      case 0xc8: return skip(u16() + 1);
      case 0xc9: return skip(u32() + 1);
      case 0xca: return view.getFloat32(take(4));
      case 0xcb: return view.getFloat64(take(8));
      case 0xcc: return u8();
      case 0xcd: return u16();
      case 0xce: return u32();
      case 0xcf: return Number(view.getBigUint64(take(8)));
      case 0xd0: return view.getInt8(take(1));
      case 0xd1: return view.getInt16(take(2));
      case 0xd2: return view.getInt32(take(4));
      case 0xd3: return Number(view.getBigInt64(take(8)));
      case 0xd4: case 0xd5: case 0xd6: case 0xd7: case 0xd8: return skip(1 + 2 ** (t - 0xd4));
      case 0xd9: return text(u8());
      case 0xda: return text(u16());
      case 0xdb: return text(u32());
      case 0xdc: return list(u16(), d);
      case 0xdd: return list(u32(), d);
      case 0xde: return map(u16(), d);
      case 0xdf: return map(u32(), d);
      default: throw new Error("bad msgpack type");
    }
  }
  return read(0);
}
