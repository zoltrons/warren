// The Uint8Array base64/hex methods Chromium 156 (the extension's floor) has, for unit tests on Node 24 (.nvmrc),
// which lacks them. Imported first by the tests that reach code using them; the extension never imports it.
type B64 = { alphabet?: "base64" | "base64url"; omitPadding?: boolean };
const ctor = Uint8Array as unknown as Record<string, unknown>;
const proto = Uint8Array.prototype as unknown as Record<string, unknown>;

proto.toHex ??= function (this: Uint8Array) {
  return Array.from(this, (b) => b.toString(16).padStart(2, "0")).join("");
};
ctor.fromHex ??= (s: string) => new Uint8Array((s.match(/../g) ?? []).map((h) => parseInt(h, 16)));
proto.toBase64 ??= function (this: Uint8Array, o: B64 = {}) {
  let s = btoa(Array.from(this, (b) => String.fromCharCode(b)).join(""));
  if (o.alphabet === "base64url") s = s.replace(/\+/g, "-").replace(/\//g, "_");
  return o.omitPadding ? s.replace(/=+$/, "") : s;
};
ctor.fromBase64 ??= (s: string, o: B64 = {}) => {
  const std = o.alphabet === "base64url" ? s.replace(/-/g, "+").replace(/_/g, "/") : s;
  return Uint8Array.from(atob(std + "=".repeat((4 - (std.length % 4)) % 4)), (c) => c.charCodeAt(0));
};
