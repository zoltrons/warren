// Passkeys for websites, always on (like the official clients). The MAIN-world shim
// (passkey-page.js) + isolated relay (passkey-relay.js) are registered on every secure origin, so
// WebAuthn calls are served by Warren's window (a plain get with no matching passkey says so there and
// offers the browser, like the official clients); security-key-only requests and passkey autofill with
// nothing to offer go straight to the browser. Conditional mediation (passkey autofill) additionally shows
// "Sign in with a passkey" in the inline menu while the website is waiting for an assertion; picking it
// signs in directly when one passkey matches (see openConditional).
// Crypto runs in the worker (offscreen/fido2.ts); credentials are stored as Bitwarden's
// `login.fido2Credentials[]`, so they round-trip through the SDK model and sync with the official apps.
import { ci } from "../shared/validate.ts";
import {
  type PasskeyCall,
  type PasskeyCandidate,
  type PasskeyPrompt,
  type PasskeyResult,
  parsePasskeyCall,
  type VaultItem,
} from "../shared/messages.ts";
import { UserError, verifyMasterPassword } from "./account.ts";
import { ApiError } from "../transport/http.ts";
import { coreCall } from "./core.ts";
import { assertEpoch, lockEpoch } from "./lock.ts";
import { REPROMPT_MESSAGE, repromptPending } from "./reprompt.ts";
import { getLocal, getSettings } from "./store.ts";
import { ensureLoaded, isUnlocked, putCipher, requireUnlocked, sync } from "./vault.ts";

const SCRIPT_IDS = ["warren-passkey-page", "warren-passkey-relay"];
/**
 * A conditional (passkey-autofill) request is kept open by the page pinging the port, which also keeps
 * the service worker awake. Bound how long one can live.
 */
const CONDITIONAL_TTL_MS = 5 * 60_000;
/** WebAuthn needs a secure context: https, or localhost during development. */
const MATCHES = ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"];

interface Pending {
  id: string;
  call: PasskeyCall;
  origin: string;
  rpId: string;
  tabId: number;
  frameId: number;
  /** Conditional mediation: no approval window until the user picks the inline-menu entry. */
  conditional: boolean;
  /** The vault was locked when the call came: unlocking for it verifies the user (master password, PIN, biometrics). */
  startedLocked: boolean;
  /** The user confirmed the master password for this request. */
  confirmed?: boolean;
  windowId?: number;
  done(r: PasskeyResult): void;
}

// In memory on purpose: if the service worker dies, the relay's port closes and the page falls back.
const pending = new Map<string, Pending>();

/** Idempotent: registered content scripts persist across sessions, so this usually does nothing. */
export async function ensurePasskeyScripts(): Promise<void> {
  const scripts = await chrome.scripting.getRegisteredContentScripts({ ids: SCRIPT_IDS }).catch(() => []);
  if (scripts.length === SCRIPT_IDS.length) return;
  await chrome.scripting.unregisterContentScripts({ ids: SCRIPT_IDS }).catch(() => undefined);
  await chrome.scripting.registerContentScripts([
    { id: SCRIPT_IDS[0]!, js: ["passkey-page.js"], matches: MATCHES, runAt: "document_start", world: "MAIN", persistAcrossSessions: true },
    { id: SCRIPT_IDS[1]!, js: ["passkey-relay.js"], matches: MATCHES, runAt: "document_start", persistAcrossSessions: true },
  ]);
}

const error = (name: string, message: string): PasskeyResult => ({ error: { name, message } });

/** Lets the content script refresh its inline menu (the passkey entry may have appeared or gone). */
const refreshMenu = (tabId: number, frameId: number) =>
  chrome.tabs.sendMessage(tabId, { type: "passkeyAvailable" }, { frameId }).catch(() => undefined);

const conditionalFor = (tabId: number, frameId?: number) =>
  [...pending.values()].find((p) => p.conditional && p.tabId === tabId && (frameId === undefined || p.frameId === frameId));

export function onPasskeyPort(port: chrome.runtime.Port): void {
  const sender = port.sender;
  const origin = sender?.origin;
  // Top frames of web pages only; the origin comes from the browser, never from the page.
  if (sender?.id !== chrome.runtime.id || !sender.tab?.id || sender.frameId !== 0 || !origin?.startsWith("http")) {
    port.disconnect();
    return;
  }
  const tabId = sender.tab.id;
  const frameId = sender.frameId;
  let called = false;
  let mine: Pending | undefined;
  let closed = false;
  // By identity, not by id: a newer conditional call may have taken over this request's id (and window).
  const drop = () => {
    if (mine && pending.get(mine.id) === mine) mine.done({ fallback: true });
  };

  port.onDisconnect.addListener(() => {
    closed = true;
    drop();
  });

  port.onMessage.addListener((msg: unknown) => {
    const m = msg as { ping?: unknown; abort?: unknown } | null;
    if (m?.ping) return; // keep-alive while the user decides
    // The page aborted the call (AbortSignal) or the browser answered it first.
    if (m?.abort) return drop();
    if (called) return; // one call per port
    called = true;
    let call: PasskeyCall;
    try {
      call = parsePasskeyCall(m);
    } catch {
      port.disconnect();
      return;
    }
    void handle(call, origin);
  });

  async function handle(call: PasskeyCall, origin: string): Promise<void> {
    if (!(await getLocal("account"))) return port.postMessage({ fallback: true });
    const conditional = call.kind === "get" && call.conditional;
    // Only modal calls open a window on their own, so only they are limited: one per tab, like the
    // browser, so a page cannot pile up windows by calling in a loop. Checked on the pending entry, not
    // its window (whose id only exists once windows.create resolves). A conditional call opens nothing
    // until the user picks it in the inline menu, and replaces its frame's previous one (below).
    if (!conditional && [...pending.values()].some((p) => p.tabId === tabId && !p.conditional))
      return port.postMessage(error("NotAllowedError", "Another passkey request is pending"));
    let timer: ReturnType<typeof setTimeout> | undefined;
    const p: Pending = {
      id: crypto.randomUUID(),
      call,
      origin,
      rpId: (call.options.rpId || new URL(origin).hostname).toLowerCase(),
      tabId,
      frameId,
      conditional,
      startedLocked: false, // set right after pending.set: no await may come between the one-per-tab check and it
      done: (r) => {
        clearTimeout(timer);
        if (pending.get(p.id) === p) pending.delete(p.id);
        // A finished request never leaves its approval window behind.
        if (p.windowId !== undefined) void chrome.windows.remove(p.windowId).catch(() => undefined);
        if (conditional) void refreshMenu(tabId, frameId);
        if (closed) return;
        try {
          port.postMessage(r);
        } catch {
          // The page went away between the decision and the reply.
        }
      },
    };
    if (conditional) {
      // A newer conditional call replaces the one still waiting (the page re-requested).
      const previous = conditionalFor(tabId, frameId);
      // The user may be choosing in the previous call's window right now: the new call takes it over
      // (same id, so the window's answer reaches it), but only if the window shows what it asks for.
      // Otherwise previous.done() closes the window.
      if (previous?.windowId !== undefined && previous.origin === p.origin && previous.rpId === p.rpId) {
        [p.id, p.windowId, previous.windowId] = [previous.id, previous.windowId, undefined];
      }
      previous?.done(error("AbortError", "This passkey request was replaced by a newer one"));
    }
    pending.set(p.id, p);
    mine = p;
    p.startedLocked = !(await isUnlocked());
    if (conditional) timer = setTimeout(() => void p.done({ fallback: true }), CONDITIONAL_TTL_MS);
    if (call.kind === "get") {
      if (await isUnlocked()) {
        if (!(await candidates(p, call.options.allow).catch(() => [])).length) {
          // Passkey autofill with nothing to offer stays out of the way: the browser's own UI keeps working.
          if (conditional) return p.done({ fallback: true });
          // Like the official clients: the passkey may have been saved on another device since the last sync.
          // If it is still not there, the window says so and offers "Use another device or browser" rather
          // than handing the call to the system dialog unasked.
          await sync(false).catch(() => false);
        }
      } else if (conditional) {
        // Passkey autofill runs on page load: never nag for the master password. The browser's own
        // conditional UI keeps working, and the inline menu entry appears after unlocking.
        return p.done({ fallback: true });
      }
    }
    if (pending.get(p.id) !== p) return; // the page aborted (or replaced it) while we were deciding
    if (conditional) {
      void refreshMenu(tabId, frameId); // the inline menu offers the passkey from now on
      return;
    }
    try {
      await openWindow(p);
    } catch {
      p.done({ fallback: true });
    }
  }
}

async function openWindow(p: Pending): Promise<void> {
  if (p.windowId !== undefined) {
    await chrome.windows.update(p.windowId, { focused: true }).catch(() => undefined);
    return;
  }
  const size = { url: `popup.html?passkey=${p.id}`, type: "popup", width: PASSKEY_WIDTH, height: 640, focused: true } as const;
  // A placement the screen refuses must not cost the user the approval: the browser then picks the spot.
  const w = await chrome.windows.create({ ...size, ...(await underToolbar(p.tabId)) }).catch(() => chrome.windows.create(size));
  // Finished while the window was opening: done() had no window to close yet.
  if (pending.get(p.id) !== p) return void (w?.id !== undefined && chrome.windows.remove(w.id).catch(() => undefined));
  p.windowId = w?.id;
}

const PASSKEY_WIDTH = 400;

/** Where the extension's own popup opens: the top right of the window asking, below its toolbar. */
async function underToolbar(tabId: number): Promise<{ left?: number; top?: number }> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  const win = tab && (await chrome.windows.get(tab.windowId).catch(() => undefined));
  if (win?.left === undefined || win.top === undefined || win.width === undefined || win.state === "minimized") return {};
  return { left: Math.max(win.left, win.left + win.width - PASSKEY_WIDTH - 16), top: win.top + 88 };
}

/** The approval window was closed without a decision: let the browser handle the call. */
export function onWindowRemoved(windowId: number): void {
  for (const p of pending.values()) if (p.windowId === windowId) p.done({ fallback: true });
}

function get(id: string): Pending {
  const p = pending.get(id);
  if (!p) throw new UserError("sessionExpired", "This passkey request is no longer active");
  return p;
}

async function candidates(p: Pending, ids: string[]): Promise<PasskeyCandidate[]> {
  await ensureLoaded();
  return coreCall<PasskeyCandidate[]>({ op: "passkeyCandidates", rpId: p.rpId, origin: p.origin, ids });
}

/**
 * A new passkey can join one of the site's own editable logins (by item id, empty credentialId). The
 * official apps keep one passkey per login: one that holds a passkey already is offered as `replaces`, and
 * passkeyDecision overwrites it only with the user's confirmation.
 */
async function joinable(p: Pending): Promise<PasskeyCandidate[]> {
  await ensureLoaded();
  const { defaultUriMatch } = await getSettings();
  const items = await coreCall<VaultItem[]>({ op: "matchUri", url: p.origin, defaultMatch: defaultUriMatch });
  return items
    .filter((i) => !i.readOnly && !i.failed)
    .map((i) => ({ itemId: i.id, name: i.name, userName: i.sub, credentialId: "", ...(i.hasPasskey ? { replaces: true } : {}) }));
}

/** Inline menu: is there a stored passkey for the conditional request waiting in this frame? */
export async function conditionalReady(tabId: number, frameId: number): Promise<boolean> {
  const p = conditionalFor(tabId, frameId);
  if (!p || p.call.kind !== "get") return false;
  try {
    return (await candidates(p, p.call.options.allow)).length > 0;
  } catch {
    return false;
  }
}

/**
 * Inline menu "Sign in with a passkey". Clicking the entry is the user's decision: with exactly one
 * matching passkey it signs in right away, no window. The approval window opens only when there is a
 * choice to make (several passkeys) or the item asks for the master password again (`reprompt`).
 */
export async function openConditional(tabId: number, frameId: number): Promise<void> {
  const p = conditionalFor(tabId, frameId);
  if (!p) throw new UserError("sessionExpired", "This passkey request is no longer active");
  if (p.call.kind === "get") {
    await requireUnlocked();
    const found = await candidates(p, p.call.options.allow);
    const only = found.length === 1 ? found[0] : undefined;
    // A site that requires user verification gets the window, which asks for the master password.
    if (only && !mustVerify(p) && !repromptPending(await coreCall<VaultItem>({ op: "cipherSummary", id: only.itemId }))) {
      await passkeyDecision(p.id, "use", only.itemId, only.credentialId);
      return;
    }
  }
  await openWindow(p);
}

/**
 * The UV flag means "the authenticator verified the user for this request", and sites rely on it as a second
 * factor. A click in an already unlocked vault is only presence: verified is an unlock or a master password
 * confirmation that happened for this request.
 */
const verified = (p: Pending) => !!p.confirmed || p.startedLocked;
const mustVerify = (p: Pending) => p.call.options.userVerification === "required" && !verified(p);

export async function passkeyPrompt(id: string): Promise<PasskeyPrompt> {
  await requireUnlocked();
  const p = get(id);
  const base = { origin: p.origin, rpId: p.rpId, ...(mustVerify(p) ? { verify: true } : {}) };
  if (p.call.kind === "get") {
    const found = await candidates(p, p.call.options.allow);
    // Nothing matches: say whether the vault has passkeys for this site at all (the site may know another one).
    const others = !found.length && p.call.options.allow.length ? (await candidates(p, [])).length : 0;
    return { kind: "get", ...base, candidates: found, ...(others ? { others } : {}) };
  }
  return { kind: "create", ...base, rpName: p.call.options.rpName, userName: p.call.options.user.name, candidates: await joinable(p) };
}

/**
 * After a replacing save that got no answer: once synced, an item that holds the new passkey gets the one it replaced.
 * shortcut: an undo that fails as well (still offline) is lost; keep it sealed on disk if that is ever seen.
 */
async function undoIfTaken(p: Pending, itemId: string, credentialId: string, undo: Record<string, unknown>): Promise<void> {
  await sync(true);
  if (!(await candidates(p, [credentialId])).some((c) => c.itemId === itemId)) return;
  const now = (await getLocal("vault"))?.ciphers.find((c) => ci(c, "id") === itemId);
  await putCipher({ ...undo, lastKnownRevisionDate: ci(now, "revisionDate") ?? null });
}

export async function passkeyDecision(id: string, action: "use" | "fallback", itemId?: string, credentialId?: string, replace = false, password?: string): Promise<null> {
  const epoch = lockEpoch();
  const p = get(id);
  if (action === "fallback") return (p.done({ fallback: true }), null);
  await requireUnlocked();
  if (password !== undefined) {
    await verifyMasterPassword(password); // a wrong one goes back to the window, which asks again
    if (pending.get(id) !== p) return null;
    p.confirmed = true;
  }
  if (mustVerify(p)) throw new UserError("invalid", "This site requires you to confirm your master password");
  const uv = verified(p);
  try {
    if (p.call.kind === "get") {
      const c = (await candidates(p, p.call.options.allow)).find((x) => x.itemId === itemId && x.credentialId === credentialId);
      if (!c) throw new UserError("invalid", "Choose one of the passkeys for this site");
      // The window has no password prompt: a flagged item must be confirmed in the popup first (the grant is per item).
      if (repromptPending(await coreCall<VaultItem>({ op: "cipherSummary", id: c.itemId }))) throw new UserError("reprompt", REPROMPT_MESSAGE);
      const credential = await coreCall<Record<string, unknown>>({ op: "passkeyAssert", itemId: c.itemId, credentialId: c.credentialId, rpId: p.rpId, origin: p.origin, challenge: p.call.options.challenge, uv });
      p.done({ credential });
    } else {
      const o = p.call.options;
      if (o.exclude.length && (await candidates(p, o.exclude)).length)
        return (p.done(error("InvalidStateError", "A passkey for this account already exists in Warren")), null);
      // Joining an existing login: only one offered for this site, and a flagged one is confirmed in the popup first.
      if (itemId) {
        const target = (await joinable(p)).find((c) => c.itemId === itemId);
        if (!target) throw new UserError("invalid", "Choose one of the logins for this site");
        // Never overwrite a passkey the window did not ask the user about.
        if (target.replaces && !replace) throw new UserError("invalid", "This login already has a passkey: confirm replacing it");
        if (repromptPending(await coreCall<VaultItem>({ op: "cipherSummary", id: itemId }))) throw new UserError("reprompt", REPROMPT_MESSAGE);
      }
      // The worker returns the item already encrypted: the new private key never passes through here.
      const r = await coreCall<{ cipher: Record<string, unknown>; response: Record<string, unknown>; undo?: Record<string, unknown> }>({
        op: "passkeyCreate",
        input: { origin: p.origin, rpId: p.rpId, rpName: o.rpName, challenge: o.challenge, user: o.user, discoverable: o.discoverable, uv },
        ...(itemId ? { itemId } : {}),
      });
      // The page aborted (or the vault locked) before the save went out: the site never gets this credential, so it
      // must not replace one. Checked right before the request, after every await on the way.
      const saved = await putCipher(r.cipher, () => {
        if (pending.get(id) !== p) throw new UserError("sessionExpired", "The site cancelled the passkey request");
        assertEpoch(epoch);
      }).catch(async (e: unknown) => {
        // No answer (or a gateway's): the server may have taken the replacement all the same, and the site gets none.
        if (r.undo && itemId && !(e instanceof UserError) && !(e instanceof ApiError && e.status < 500))
          await undoIfTaken(p, itemId, String(r.response.id), r.undo).catch((u: unknown) => console.warn("passkey undo", u));
        throw e;
      });
      if (pending.get(id) === p) return (p.done({ credential: r.response }), null);
      // Cancelled while the save was out: the site will never use the new passkey, so the one it replaced comes
      // back, saved over the server's copy just made (its revision).
      if (r.undo) await putCipher({ ...r.undo, lastKnownRevisionDate: ci(saved, "revisionDate") ?? null });
    }
  } catch (e) {
    if (e instanceof UserError && (e.code === "invalid" || e.code === "reprompt")) throw e;
    p.done(error("NotAllowedError", e instanceof Error ? e.message : String(e)));
  }
  return null;
}
