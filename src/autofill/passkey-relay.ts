// Isolated-world relay between the page shim (passkey-page.ts) and the service worker. Registered on
// every secure origin. Each call gets its own port; pings keep the service worker alive while the user
// decides in the approval window (or while a conditional request waits for the inline menu). A closed
// port means "let the browser handle it"; an "abort" from the page drops the pending request.
const PORT = "warren-passkey"; // PASSKEY_PORT in shared/messages.ts (kept import-free: content script)

/** Live calls by page call id, so an AbortSignal can cancel the matching pending request. */
const ports = new Map<string, chrome.runtime.Port>();

addEventListener("message", (ev: MessageEvent) => {
  const d = ev.data as { warren?: unknown; id?: unknown; kind?: unknown; conditional?: unknown; options?: unknown } | null;
  if (ev.source !== window) return;
  if (d?.warren === "abort") {
    const id = String(d.id);
    const port = ports.get(id);
    if (!port) return;
    ports.delete(id);
    port.postMessage({ abort: true });
    port.disconnect();
    return;
  }
  if (d?.warren !== "req") return;
  const id = String(d.id);
  // Any page script can forge this message: a create without a real click or key press (and any call
  // with a flood of open ports) is handled by the browser itself. A get needs no gesture, like the
  // browser's own: sign-in pages (Google's "Verify it's you") ask on load, and the service worker allows
  // one window per tab.
  // A conditional create needs no gesture either (WebAuthn); the worker saves one only right after it filled that
  // sign-in, so a forged one gets nothing.
  if ((d.kind !== "get" && d.conditional !== true && !navigator.userActivation.isActive) || ports.size >= 8) {
    postMessage({ warren: "res", id: d.id, result: { fallback: true } }, "*");
    return;
  }
  const port = chrome.runtime.connect({ name: PORT });
  ports.set(id, port);
  let done = false;
  const reply = (result: unknown) => {
    if (done) return;
    done = true;
    clearInterval(ping);
    ports.delete(id);
    postMessage({ warren: "res", id: d.id, result }, "*");
  };
  const ping = setInterval(() => {
    try {
      port.postMessage({ ping: true });
    } catch {
      clearInterval(ping);
    }
  }, 20_000);
  port.onMessage.addListener((result: unknown) => {
    reply(result);
    port.disconnect();
  });
  port.onDisconnect.addListener(() => reply({ fallback: true }));
  try {
    port.postMessage({ kind: d.kind, conditional: d.conditional === true, options: d.options });
  } catch {
    // The extension was reloaded or disabled between connect and the call: let the browser handle it.
    reply({ fallback: true });
  }
});
