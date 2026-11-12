// Content script on every http(s) page and frame, right after page.js. It watches for focus and for a
// first password field, and scans nothing else. For login, card and identity fields it shows Warren's
// inline menu, an extension iframe (menu.html) the page cannot read; what a field is, the list and the fill
// come from the service worker. It also reports submitted logins so Warren can offer to save or update
// them (bar.html, top frame only). Bundled as a classic script and kept small.
import { watchForPasswordField } from "./collector/field-watcher.ts";
import { deepAll, shadowOf, up } from "./collector/shadow-dom.ts";
import type { PageApi } from "./page.ts";
import { fieldName, fieldOf, picking, startPicker, stopPicker } from "./picker.ts";

const api = (globalThis as unknown as { warren: PageApi }).warren;

const MENU_TYPES = ["text", "email", "tel", "", "search", "number", "password"];

/** Only a field that can type a value is worth asking the service worker about. */
const askable = (el: Element): el is HTMLInputElement => el instanceof HTMLInputElement && !el.disabled && !el.readOnly && MENU_TYPES.includes(el.type);

/** The focused element, looking inside shadow roots (closed ones too). */
function active(): Element | null {
  let a = document.activeElement;
  for (let r = a && shadowOf(a); r?.activeElement; r = shadowOf(a!)) a = r.activeElement;
  return a;
}

/** The element an event is about: inside a closed shadow root the event shows only its host, so ask the focus. */
function targetOf(e: Event): Element {
  const t = e.composedPath()[0] as Element;
  if (t === host || !(t instanceof Element) || !shadowOf(t) || t.shadowRoot) return t;
  return active() ?? t;
}

// ---------- inline menu ----------

/**
 * Where the menu goes: inside the modal the field is in, or the page. A modal <dialog> makes everything outside it inert,
 * and focus-trapping modals pull focus back from anything outside them, so a menu next to them takes no click or key.
 */
function containerOf(el: Element): Element {
  for (let n: Element | null = el; n; n = n.parentElement ?? ((n.getRootNode() as ShadowRoot).host ?? null))
    if (n.matches('dialog:modal, [role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]')) return n;
  return document.documentElement;
}

/**
 * The top layer: above modals, popovers and fullscreen elements, and positioned against the viewport whatever the
 * page sets on its ancestors (a transform or filter on <html> would otherwise move a fixed element).
 */
function raise(el: HTMLElement) {
  try {
    if (el.isConnected && !el.matches(":popover-open")) el.showPopover();
  } catch {
    // The page removed the popover attribute: the menu stays where z-index puts it.
  }
}

let host: HTMLElement | undefined;
let frame: HTMLIFrameElement | undefined;
/** The field the menu is under; in the top frame, for a menu drawn for a child frame, that frame's <iframe>. */
let anchor: HTMLElement | undefined;
/** Top frame only: the field's box inside `anchor` (that frame's own coordinates), for a menu drawn for it. */
let remote: { x: number; y: number; w: number; h: number } | undefined;
/** Child frame: the field whose menu the top frame draws (there is no host here then). */
let drawnAbove: HTMLInputElement | undefined;
/** Child frame: the last such field, which Escape in the top frame's menu focuses again. */
let lastAbove: HTMLInputElement | undefined;
let dismissed: HTMLInputElement | undefined;
/**
 * Per-document secret handed to the menu frame it opens. The menu is inside a closed shadow root, so
 * the page cannot read this; a menu the page frames itself does not have it and is refused.
 * (crypto.getRandomValues, not randomUUID: content scripts also run on plain-http pages.)
 */
const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
/** Focus generation: an in-flight open() must not reopen the menu after a newer focus or close. */
let gen = 0;
/** Last login field focused, also when the menu had nothing to offer: a later passkey request reopens it. */
let focusedLogin: HTMLInputElement | undefined;
/** The fill itself focuses fields: do not reopen the menu right away. */
let quietUntil = 0;

/** Where the menu's field is, in this document's viewport. */
function anchorBox(a: HTMLElement): { left: number; top: number; bottom: number; width: number } {
  const r = a.getBoundingClientRect();
  if (!remote) return r;
  // The child frame's viewport starts inside the <iframe>'s border and padding.
  const cs = getComputedStyle(a);
  const [x, y] = [r.left + a.clientLeft + parseFloat(cs.paddingLeft), r.top + a.clientTop + parseFloat(cs.paddingTop)];
  // A frame cannot put its menu outside its own box (over the rest of the page).
  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
  const top = clamp(y + remote.y, r.top, r.bottom);
  return { left: clamp(x + remote.x, r.left, r.right), top, bottom: clamp(y + remote.y + remote.h, top, r.bottom), width: Math.min(remote.w, r.width) };
}

function place() {
  if (!host || !anchor) return;
  const r = anchorBox(anchor);
  if (!r.width || r.bottom < 0 || r.top > innerHeight) return close();
  // The host's `all:initial!important` outranks anything set here without !important.
  const set = (name: string, value: string) => host!.style.setProperty(name, value, "important");
  const width = Math.min(Math.max(r.width, 300), 420);
  const height = parseFloat(frame?.style.height ?? "") || 0;
  // Under the field, like Chrome's dropdown; above it when only there it fits.
  const below = r.bottom + 4;
  const y = below + height > innerHeight && r.top - 4 - height >= 0 ? r.top - 4 - height : below;
  const [top, left] = [`${y}px`, `${Math.max(4, Math.min(r.left, innerWidth - width - 4))}px`];
  // A page can move the menu under the cursor: the frame restarts its click guard (guardClicks) on every move.
  if (host.style.top && (host.style.top !== top || host.style.left !== left)) frame?.contentWindow?.postMessage("moved", "*");
  set("top", top);
  set("left", left);
  set("width", `${width}px`);
}

/** The field moves without a scroll (an error line above it, a banner): the menu follows. */
const follow = new ResizeObserver(() => place());

/** The top frame draws (or drops) the menu for a child frame: see inline.ts `inlineRemote`. */
const toTop = (msg: Record<string, unknown>) => chrome.runtime.sendMessage({ type: "inlineRemote", ...msg }).catch(() => undefined);

/**
 * Top frame: which window posted a handshake token. A child frame posts a fresh token to its parent and hands the same
 * token to the worker, so the top frame can tell which of its <iframe>s asks, without a frame-id API.
 */
const frameTokens = new Map<string, Set<MessageEventSource>>();
if (window === top)
  addEventListener("message", (e) => {
    const t = (e.data as { warrenFrame?: unknown } | null)?.warrenFrame;
    if (typeof t !== "string" || t.length !== 32 || !e.source) return;
    if (frameTokens.size >= 16) frameTokens.clear(); // a page posting tokens in a loop costs only its own menu
    frameTokens.set(t, (frameTokens.get(t) ?? new Set()).add(e.source));
  });

function close() {
  gen++;
  if (drawnAbove) void toTop({ op: "hide" });
  drawnAbove = undefined;
  // Fades out like Chrome's dropdown; it takes no clicks while it goes.
  const [h, f] = [host, frame];
  if (h && f && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    f.style.pointerEvents = "none";
    f.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, easing: "cubic-bezier(.3,0,.8,.15)" }).finished.then(() => h.remove(), () => h.remove());
  } else h?.remove();
  host = frame = anchor = remote = undefined;
  follow.disconnect();
  removeEventListener("scroll", place, true);
  removeEventListener("resize", place);
}

/** The menu frame under `a` (the field, or a child frame's <iframe>), `height` px tall, for the document with `secret`. */
function draw(a: HTMLElement, height: number, secret: string) {
  anchor = a;
  host = document.createElement("warren-menu");
  host.popover = "manual";
  host.style.cssText = "all:initial!important;position:fixed!important;z-index:2147483647!important;display:block!important;opacity:1!important;transform:none!important;filter:none!important";
  frame = document.createElement("iframe");
  frame.src = `${chrome.runtime.getURL("menu.html")}#${secret}`;
  frame.allow = "clipboard-write";
  // Radius and shadow are Chrome's menu ones (8 px, Material elevation 2).
  frame.style.cssText = `all:initial;display:block;width:100%;height:${height}px;border:0;border-radius:8px;box-shadow:0 0 0 1px rgba(128,128,128,.16),0 1px 2px rgba(0,0,0,.3),0 2px 6px 2px rgba(0,0,0,.15);color-scheme:normal`;
  host.attachShadow({ mode: "closed" }).append(frame);
  containerOf(a).append(host);
  raise(host);
  appear(frame);
  place();
  follow.observe(a);
  follow.observe(document.documentElement);
  addEventListener("scroll", place, true);
  addEventListener("resize", place);
}

/** The field a request is in flight for: the click that focused it must not ask again. */
let opening: HTMLInputElement | undefined;

async function open(el: HTMLInputElement) {
  if (anchor === el || drawnAbove === el || opening === el || dismissed === el || Date.now() < quietUntil) return;
  const mine = ++gen;
  const details = api.collectActive(el);
  opening = el;
  try {
    await show(el, mine, details);
  } finally {
    if (opening === el) opening = undefined;
  }
}

async function show(el: HTMLInputElement, mine: number, details: ReturnType<typeof api.collectActive>) {
  const r = ((await chrome.runtime.sendMessage({ type: "inlineFocus", nonce, details }).catch(() => undefined)) as { data?: { rows: number; footer?: boolean; kind?: string } } | undefined)?.data;
  if (r?.kind === "login") api.setFocused((focusedLogin = el)); // read by the fill
  if (mine !== gen) return;
  // rows = 0: nothing to offer (no matches, not logged in, not a field we fill), so stay out of the way.
  if (!r?.rows) {
    if (el !== anchor) close();
    return;
  }
  if (active() !== el || Date.now() < quietUntil) return;
  close();
  // Row metrics come from the menu's own CSS (popup.css, body.frame): 44 px rows, 4 px frame padding, a 45 px footer.
  const height = Math.min(r.rows, 5) * 44 + 8 + (r.footer ? 45 : 0);
  const box = el.getBoundingClientRect();
  // A frame too small for the menu (a payment form's one-field iframes) has the top frame draw it over the page.
  if (window !== top && (box.bottom + 4 + height > innerHeight || innerWidth < 300)) {
    const mine2 = gen;
    // Only a frame right under the top one: its parent is the top frame, which reads the token's sender.
    const token = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (parent === top) parent.postMessage({ warrenFrame: token }, "*");
    const shown = parent === top && ((await toTop({ op: "show", token, rect: { x: box.left, y: box.top, w: box.width, h: box.height }, height })) as { data?: unknown } | undefined)?.data === true;
    if (mine2 !== gen || active() !== el) return void (shown && toTop({ op: "hide" }));
    if (shown) return void (drawnAbove = lastAbove = el);
  }
  draw(el, height, nonce);
}

/**
 * The user's own last pointer press or Tab. A page can focus a field from script and measure the menu it gets
 * (how many cards, locked or not): only a focus the user caused opens one.
 */
let gesture: { target: Element | undefined; at: number } = { target: undefined, at: 0 };
addEventListener("pointerdown", (e) => e.isTrusted && (gesture = { target: e.composedPath()[0] as Element, at: Date.now() }), true);
addEventListener("keydown", (e) => e.isTrusted && e.key === "Tab" && (gesture = { target: undefined, at: Date.now() }), true);
/** A press on a closed shadow root reports only its host: it counts for the fields inside that root. */
const closedHostOf = (a: Element, el: Element) => {
  if (a.shadowRoot || !shadowOf(a)) return false;
  for (let n: Element | null = el; n; n = up(n)) if (n === a) return true;
  return false;
};
const userFocused = (el: HTMLInputElement) =>
  Date.now() - gesture.at < 1000 && (!gesture.target || el.contains(gesture.target) || closedHostOf(gesture.target, el) || [...(el.labels ?? [])].some((l) => l.contains(gesture.target!)));

addEventListener(
  "focusin",
  (e) => {
    const el = targetOf(e); // fields inside shadow roots too
    if (el === host || picking()) return; // focus moved into our menu, or the user is pointing at fields
    if (askable(el) && userFocused(el)) void open(el);
    else if (el !== anchor) close();
  },
  true,
);

addEventListener(
  "focusout",
  () =>
    setTimeout(() => {
      if (document.activeElement !== host && active() !== anchor) close();
    }),
  true,
);

addEventListener(
  "keydown",
  (e) => {
    if (picking()) return;
    if (e.key === "Escape" && (host || drawnAbove)) {
      dismissed = drawnAbove ?? (anchor instanceof HTMLInputElement ? anchor : undefined);
      close();
    }
    // The form Enter submits, like a click or a submit event: not a filled form next to it (a password change).
    const field = targetOf(e) as HTMLInputElement;
    // ArrowDown moves into the open menu, like a native autocomplete list; its first row takes focus (menu.ts).
    if (e.key === "ArrowDown" && e.isTrusted && frame && field === anchor && !e.altKey) {
      e.preventDefault();
      frame.focus();
      return;
    }
    if (e.key === "ArrowDown" && e.isTrusted && drawnAbove && field === drawnAbove && !e.altKey) {
      e.preventDefault();
      void toTop({ op: "focus" });
      return;
    }
    if (e.key === "Enter" && field.type === "password") report(field.form);
  },
  true,
);

// Escape (or ArrowUp past the first row) in the menu hands focus back to its field. Only our frame's own window
// counts as the sender: a page posting the same text gets nothing.
addEventListener("message", (e) => {
  // The save bar reports its content height (bar.ts) so the frame fits it, as Chrome's bubble does.
  if (barFrame && e.source === barFrame.contentWindow && typeof e.data?.barHeight === "number") {
    barFrame.style.height = `${Math.max(64, Math.min(e.data.barHeight, 240))}px`;
    return;
  }
  if (!frame || e.source !== frame.contentWindow || e.data !== "warren:back") return;
  const el = anchor;
  // A menu drawn for a child frame: focus goes back into that frame, which refocuses its field (inlineBack).
  if (remote) {
    close();
    el?.focus();
    void toTop({ op: "back" });
    return;
  }
  dismissed = el instanceof HTMLInputElement ? el : undefined;
  close();
  el?.focus();
});

// A click reopens a menu that was dismissed with Escape.
addEventListener(
  "click",
  (e) => {
    if (picking()) return;
    const el = targetOf(e);
    if (el === dismissed && e.isTrusted) {
      dismissed = undefined;
      if (askable(el)) void open(el);
    } else if (e.isTrusted && el !== anchor && askable(el) && active() === el) void open(el); // focused by the page (autofocus): the user's click opens it
    // Submit buttons (a <button> without a type is one), and the plain buttons single-page apps use when
    // they say what they do; not "show password" toggles and the like. The click may land on a child.
    const b = el.closest<HTMLButtonElement>("button,input[type=submit],[role=button]");
    if (b && (b.type === "submit" || /log.?in|sign.?(in|up)|regist|create|continue|next|submit|giri[sş]|kay[iı]t|devam/.test((b.textContent || b.value || "").toLowerCase()))) setTimeout(() => report((b as HTMLButtonElement).form ?? b.closest("form")));
  },
  true,
);

addEventListener("submit", (e) => report(e.composedPath()[0] as HTMLFormElement), true);

// ---------- autofill on page load ----------

/** The service worker decides whether anything is filled (setting, lock, matches). */
const offerPageLoad = () => void chrome.runtime.sendMessage({ type: "pageLoad" }).catch(() => undefined);

// Once per document, when its first password field exists, however late a single-page app renders it.
watchForPasswordField(offerPageLoad);
// bfcache returns, like the official autofiller.
addEventListener("pageshow", (e) => {
  if ((e as PageTransitionEvent).persisted && api.hasPasswordField()) offerPageLoad();
});

// ---------- save / update detection ----------

const REPORT_GAP_MS = 5000;

let reported = "";
let lastReport = 0;

function report(form?: HTMLFormElement | null) {
  // A page can fire submit events itself, and whether the bar appears tells it if a guessed password
  // matches the saved one: only a real gesture counts, and only one guess per REPORT_GAP_MS.
  if (!navigator.userActivation.isActive) return;
  const login = api.readLogin(form);
  if (!login) return;
  const key = `${login.username}\n${login.password}`;
  if (key === reported || Date.now() - lastReport < REPORT_GAP_MS) return;
  reported = key;
  lastReport = Date.now();
  void chrome.runtime.sendMessage({ type: "loginSubmitted", username: login.username, password: login.password }).catch(() => undefined);
}

// ---------- "Copy custom field name" ----------

/** A menu can only be told about an element while it opens. Only the user's own right click counts. */
let rightClicked: Element | undefined;
addEventListener(
  "contextmenu",
  (e) => {
    if (e.isTrusted) rightClicked = e.composedPath()[0] as Element;
  },
  true,
);

// ---------- messages from the service worker ----------

let bar: HTMLElement | undefined;
let barFrame: HTMLIFrameElement | undefined;

/** Chrome's own autofill dropdown and bubbles fade in; nothing animates when the user asked for less motion. */
function appear(el: HTMLElement) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 100, easing: "cubic-bezier(.2,0,0,1)" });
}

chrome.runtime.onMessage.addListener((msg: { type?: string }, _sender, reply: (r: string | boolean) => void) => {
  // ---- a menu the top frame draws for a child frame's field (inline.ts `inlineRemote`) ----
  if (msg.type === "inlineShow" && window === top) {
    const m = msg as unknown as { token: string; rect: { x: number; y: number; w: number; h: number }; height: number; nonce: string };
    void (async () => {
      // The frame's handshake (`warrenFrame`) may land a moment after the worker's message.
      for (let i = 0; i < 20 && !frameTokens.has(m.token); i++) await new Promise((r) => setTimeout(r, 10));
      const sources = frameTokens.get(m.token);
      frameTokens.delete(m.token);
      // Exactly one window sent it, and it is a frame of this document (not a sibling repeating the token).
      const owner = sources?.size === 1 ? (deepAll(document, "iframe, frame") as HTMLIFrameElement[]).find((f) => sources.has(f.contentWindow!)) : undefined;
      if (!owner) return reply(false);
      close();
      remote = m.rect;
      draw(owner, m.height, m.nonce);
      reply(true);
    })();
    return true;
  }
  // The field's frame lost focus: not when it went to the menu (a click or ArrowDown into it).
  if (msg.type === "inlineHide" && window === top && remote && document.activeElement !== host) close();
  if (msg.type === "inlineMenuFocus" && window === top && remote) frame?.focus();
  if (msg.type === "inlineBack" && lastAbove) {
    dismissed = lastAbove;
    lastAbove.focus();
  }

  if (msg.type === "clickedFieldName") {
    const el = fieldOf(rightClicked);
    return void reply(el ? fieldName(el, api) : "");
  }
  if (msg.type === "pickerStart") {
    close();
    startPicker(api, (field) => void chrome.runtime.sendMessage({ type: "fieldPicked", name: "", fieldType: "", ...field }).catch(() => undefined));
    return void reply("");
  }
  if (msg.type === "pickerStop") stopPicker();
  if (msg.type === "inlineClose") {
    stopPicker(); // also how a lock reaches every tab
    quietUntil = Date.now() + 1000;
    close();
  }
  // A website waiting on a conditional passkey request appeared (or went away): refresh the menu. The
  // field may not have had a menu yet (no matching logins when it was focused), so fall back to it.
  if (msg.type === "passkeyAvailable") {
    const el = (anchor instanceof HTMLInputElement ? anchor : drawnAbove) ?? (focusedLogin && active() === focusedLogin ? focusedLogin : undefined);
    if (el) {
      close();
      void open(el);
    }
  }
  if (msg.type === "barShow" && window === top) {
    // Rebuilt on every show so the frame always carries the current save's token.
    bar?.remove();
    bar = document.createElement("warren-bar");
    bar.style.cssText = "all:initial!important;position:fixed!important;top:12px!important;right:12px!important;z-index:2147483647!important;display:block!important;opacity:1!important;transform:none!important;filter:none!important;width:380px!important;max-width:calc(100vw - 24px)!important";
    const f = document.createElement("iframe");
    f.src = `${chrome.runtime.getURL("bar.html")}#${String((msg as { token?: unknown }).token ?? "")}`;
    // Chrome's bubble: 12 px radius, Material elevation 3; the height follows the content (bar.ts).
    f.style.cssText = "all:initial;display:block;width:100%;height:208px;border:0;border-radius:12px;box-shadow:0 0 0 1px rgba(128,128,128,.16),0 1px 3px rgba(0,0,0,.3),0 4px 8px 3px rgba(0,0,0,.15);color-scheme:normal";
    bar.popover = "manual";
    bar.attachShadow({ mode: "closed" }).append(f);
    document.documentElement.append(bar);
    raise(bar);
    barFrame = f;
    appear(f);
  }
  if (msg.type === "barHide") {
    // Fades out as it faded in (appear); it takes no clicks while it goes.
    const [b, f] = [bar, barFrame];
    bar = barFrame = undefined;
    if (b && f && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      f.style.pointerEvents = "none";
      f.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 100, easing: "cubic-bezier(.3,0,.8,.15)" }).finished.then(() => b.remove(), () => b.remove());
    } else b?.remove();
  }
});
