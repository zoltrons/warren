// Vault state shared by the vault screens (`st`), the toast, the popover menu, list loading and small view helpers.
import { cardMark } from "./card-mark.ts";
import { cachedFavicon, type Favicon, loadFavicon } from "./favicon.ts";
import { clipboardDigest } from "../shared/digest.ts";
import type { BreachResults, PageMatches, Response as Reply, SecurityReport, Settings, VaultList } from "../shared/messages.ts";
import { type Child, h, send, t } from "./dom.ts";
import { type GeneratorPick, resetGenerator } from "./generator.ts";
import { icon, type IconName } from "./icons.ts";
import { sitePrefill, returnFromPicker, startEdit } from "./vault-edit.ts";
import { orgDraft, loadReport } from "./vault-tools.ts";

export type Json = Record<string, unknown>;
export interface Ctx {
  rerender(): void;
  lock(): void;
  /** The account email (default for plus-addressed usernames). */
  email(): string | undefined;
  /** Current settings (per-item options depend on the account-level ones). */
  settings(): Settings | undefined;
  /** Switch the popup's tab (e.g. from the generator to a new vault item); settings can open on a search. */
  goto(tab: "vault" | "send" | "settings", settingsQuery?: string): void;
  /** Open the Send tab with a new text send holding `text`. */
  shareAsSend(text: string): void;
  /** Runs `fn` once the screen asked for last is in the DOM: a screen change lands a frame later (view transition). */
  afterRender(fn: () => void): void;
}

export type Sort = "name" | "nameDesc" | "updated" | "created" | "opened";
export type Route = { kind: "list" } | { kind: "item"; id: string } | { kind: "edit"; isNew: boolean } | { kind: "folders" } | { kind: "org"; id: string } | { kind: "report" };

export interface EditDraft {
  base: Json;
  type: number;
  name: string;
  notes: string;
  folderId: string;
  favorite: boolean;
  /** Ask for the master password before this item is shown, copied or filled. */
  reprompt: boolean;
  /** A new organization item's collections. */
  collectionIds: string[];
  /** Type-specific fields (SCHEMA) by key. */
  data: Record<string, string>;
  /** Login websites with their own match strategy (null = the account default). */
  uris: { uri: string; match: number | null }[];
  /** Tri-state "Autofill on page load" (null = the account default). */
  autofillOnPageLoad: boolean | null;
  /** `pageLabel`: what the page calls a picked field. Only for this editor, it is not saved. */
  fields: { name: string; value: string; type: number; linkedId?: unknown; pageLabel?: string }[];
}

export const SORT_KEY = "vaultSort";
export const SORTS: { id: Sort; label: string }[] = [
  { id: "name", label: "sortNameAsc" },
  { id: "nameDesc", label: "sortNameDesc" },
  { id: "updated", label: "sortUpdated" },
  { id: "created", label: "sortCreated" },
  { id: "opened", label: "sortOpened" },
];

// How often and when each item was opened: kept encrypted by the service worker (background/private.ts) and
// handed over with the list, never synced.
export type Opened = Record<string, { n: number; at: number }>;
export const loadOpened = (): Opened => st.list?.opened ?? {};
try {
  localStorage.removeItem("vaultOpened"); // clear-text copy kept by older builds
} catch {
  /* framed pages have no storage */
}

/** The list's "Recently opened" section, a device setting; the history itself is kept for the "opened" sort. */
export const RECENT_KEY = "vaultRecentHidden";
export function recentShown(): boolean {
  try {
    return localStorage.getItem(RECENT_KEY) !== "1";
  } catch {
    return false;
  }
}
export function setRecentShown(on: boolean) {
  if (on) localStorage.removeItem(RECENT_KEY);
  else localStorage.setItem(RECENT_KEY, "1");
}
export async function clearOpened(): Promise<Reply<unknown>> {
  const r = await send({ type: "clearOpened" });
  if (r.ok && st.list) st.list.opened = {};
  return r;
}
/** Unknown until the list has loaded: then the clear button stays usable. */
export const hasOpened = () => !st.list || Object.keys(loadOpened()).length > 0;

export function noteOpened(id: string) {
  if (st.list) st.list.opened = { ...loadOpened(), [id]: { n: (loadOpened()[id]?.n ?? 0) + 1, at: Date.now() } };
  void send({ type: "itemOpened", id });
}

export function savedSort(): Sort {
  try {
    const v = localStorage.getItem(SORT_KEY);
    if (SORTS.some((s) => s.id === v)) return v as Sort;
  } catch {
    /* framed pages have no storage */
  }
  return "name";
}

export const st = {
  list: undefined as VaultList | undefined,
  /** The security report screen: the lists, and the breach check's progress and findings. */
  /** The "needs attention" banner was dismissed (until the popup is closed). */
  attentionHidden: false,
  report: undefined as { data?: SecurityReport; exposed?: Map<string, number>; done: number; running: boolean; failed: boolean; emails?: BreachResults; emailsRunning?: boolean } | undefined,
  page: undefined as PageMatches | undefined,
  loading: false,
  syncing: false,
  busy: false,
  error: undefined as string | undefined,
  route: { kind: "list" } as Route,
  query: "",
  /** "" all, "fav", "t:<type>", a folder id, "none" (no folder) or "trash". */
  folder: "",
  sort: savedSort(),
  item: undefined as Json | undefined,
  /** The item fetch is running: an error must not retrigger it on the next render. */
  itemLoading: false,
  /** Cipher id whose fetch failed: never retry it until the screen is opened again. */
  itemFailedFor: undefined as string | undefined,
  /** Cipher id whose master-password re-prompt screen is showing. */
  repromptFor: undefined as string | undefined,
  reveal: new Set<string>(),
  totp: undefined as { code: string; next: string; period: number; remaining: number } | undefined,
  /** The item whose TOTP key the worker refused: shown as an error, not asked for again on every render. */
  totpFailed: undefined as string | undefined,
  /** Timestamp of the first tap of a two-tap destructive action; 0 when idle. */
  confirmDelete: 0,
  /** Which two-tap action is armed: "item" or an attachment id. */
  armed: "",
  draft: undefined as EditDraft | undefined,
  /** The draft as the editor opened with it, to tell whether leaving would lose edits. */
  draftAtOpen: "",
  toast: "",
  /** The toast reports a failure (error icon, alert role) instead of a done action. */
  toastError: false,
  /** A button in the toast that takes the action back (moving to the trash). */
  toastAction: undefined as { label: string; run: () => void } | undefined,
  /** The toast is fading out. */
  toastLeaving: false,
  /** Large Type screen: the text being shown. */
  large: undefined as string | undefined,
  /** Editor: show the rendered notes under the text box. */
  notesPreview: false,
  /** QR screen: what is encoded, and an optional line under the code. */
  qr: undefined as { text: string; note?: string } | undefined,
  /** Breach check result for the open item's password. */
  pwned: undefined as { text: string; bad: boolean } | undefined,
  /** Memory test of the open item's password: asking, then the last verdict. */
  memory: undefined as { ok?: boolean } | undefined,
  /** Key of the field/row that was copied last (shows a check instead of the copy icon). */
  copied: "",
  /** The search box was focused once for this session; later renders keep the user's focus. */
  sawList: false,
  /** Editor: URI rows whose match-detection select is open, by index. */
  uriOpen: new Set<number>(),
  /** Editor: the generator is open for this field. */
  picking: undefined as GeneratorPick["field"] | undefined,
};
/**
 * The item view's TOTP ticker, and the re-check of an open flagged item's grant (it expires, and dies with the service
 * worker). An object, so the item view can set them and resetVault clear them.
 */
export const timers: { totp?: ReturnType<typeof setInterval>; reprompt?: ReturnType<typeof setInterval> } = {};
/** Seconds left at which the next code is pointed out. */
export const TOTP_SOON = 10;
export const REPROMPT_CHECK_MS = 10_000;

export function stopRepromptWatch() {
  clearInterval(timers.reprompt);
  timers.reprompt = undefined;
}

export function resetVault(): void {
  resetGenerator();
  clearInterval(timers.totp);
  stopRepromptWatch();
  closeMenu();
  Object.assign(st, {
    list: undefined, report: undefined, attentionHidden: false, page: undefined, loading: false, syncing: false, busy: false, error: undefined, route: { kind: "list" }, query: "",
    folder: "", item: undefined, reveal: new Set(), totp: undefined, confirmDelete: 0, draft: undefined,
    large: undefined, qr: undefined, pwned: undefined, memory: undefined, notesPreview: false,
    toast: "", toastError: false, toastAction: undefined, toastLeaving: false, copied: "", sawList: false, uriOpen: new Set(), picking: undefined,
  });
}

/** Which screen the vault tab is showing; the popup remembers a scroll position per key. */
export function vaultRouteKey(): string {
  const r = st.route;
  return r.kind === "list" ? "list" : r.kind === "item" ? `item:${r.id}` : r.kind === "edit" ? `edit:${st.picking ?? (r.isNew ? "new" : "item")}` : "folders";
}

/** The vault screen's context, for code that runs outside a render (a list reload, settings lookups). */
export let currentCtx: Ctx | undefined;
export const setCurrentCtx = (ctx: Ctx) => void (currentCtx = ctx);
export const settingsOf = (): Settings | undefined => currentCtx?.settings();

// ---------- helpers ----------

export const str = (v: unknown) => (typeof v === "string" ? v : "");
export const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);

export function hue(s: string): number {
  let x = 0;
  for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return x % 360;
}

/** An absolute http(s) URL for `u`, or undefined when it is not one. */
export function webUrl(u: string): string | undefined {
  try {
    const url = new URL(/^[a-z][\w+.-]*:/i.test(u) ? u : `https://${u}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** The server's icon service (`<server>/icons/<host>/icon.png`); unset when website icons are off. */
export let iconBase: string | undefined;
export const setIconBase = (base: string | undefined) => (iconBase = base);

export function iconUrl(uris: string[]): string | undefined {
  for (const u of iconBase ? uris : []) {
    const url = webUrl(u);
    if (url) return `${iconBase}/${new URL(url).hostname}/icon.png`;
  }
  return undefined;
}

/** A tinted letter tile; logins with a website get the server's favicon, cards their network's mark. */
export function tile(name: string, type: number, uris: string[] = [], brand = ""): HTMLElement {
  const letter = name.trim().slice(0, 1).toUpperCase();
  const fallback: IconName = type === 2 ? "note" : type === 3 ? "card" : type === 4 ? "user" : type === 5 ? "key" : type === 6 ? "landmark" : type === 7 ? "card" : type === 8 ? "globe" : "key";
  const el = h("span", { class: "tile", style: `--h:${hue(name)}`, "aria-hidden": "true" }, letter || icon(fallback));
  const mark = type === 3 && brand ? cardMark(brand) : undefined;
  if (mark) return (el.classList.add("card-tile"), el.replaceChildren(mark), el);
  const src = type === 1 ? iconUrl(uris) : undefined;
  if (!src) return el;
  const show = (f: Favicon | null) => {
    if (!f) return;
    el.replaceChildren(h("img", { src: f.url, alt: "", onerror: () => (el.classList.remove(f.tone || "_"), el.replaceChildren(letter || icon(fallback))) }));
    if (f.tone) el.classList.add(f.tone);
  };
  const known = cachedFavicon(src);
  if (known !== undefined) show(known);
  else void loadFavicon(src).then(show);
  return el;
}

/** Password digits and symbols get their own colors, like the rest of the app. */
export function colorize(value: string): (Node | string)[] {
  return [...value].map((c) => (/\d/.test(c) ? h("span", { class: "d" }, c) : /[^\p{L}\s]/u.test(c) ? h("span", { class: "s" }, c) : c));
}

export let toastId = 0;
export let toastShown = 0;
/** A short note above the tab bar. An error says so in its icon; an action (undo) keeps it up longer. */
export function toast(ctx: Ctx, text: string, opts: { error?: boolean; action?: { label: string; run: () => void } } = {}) {
  const id = ++toastId;
  Object.assign(st, { toast: text, toastError: !!opts.error, toastAction: opts.action, toastLeaving: false });
  ctx.rerender();
  const hide = () => {
    if (toastId !== id) return; // a newer toast owns the slot
    // Held while the pointer or the keyboard is on it, so its Undo can still be reached (WCAG 2.2.1).
    if (document.querySelector(".toast:hover, .toast:focus-within")) return void setTimeout(hide, 1000);
    st.toastLeaving = true;
    document.querySelector(".toast")?.classList.add("out");
    setTimeout(() => {
      if (toastId !== id) return;
      Object.assign(st, { toast: "", toastAction: undefined, toastLeaving: false });
      ctx.rerender();
    }, 160);
  };
  setTimeout(hide, opts.action ? 5000 : 1800);
}

export async function copy(ctx: Ctx, value: string, key?: string) {
  await navigator.clipboard.writeText(value);
  void send({ type: "clipboardCopied", hash: await clipboardDigest(value) }); // schedules clearing
  // Says when the clipboard is cleared, as set in Settings (default one minute; never says nothing).
  const delay = settingsOf()?.clearClipboardDelay;
  toast(ctx, delay && delay !== "never" ? t("copiedClears", t(delay)) : t("copiedOnly"));
  if (!key) return;
  // The copy icon turns into a check for a moment, so the action is visible without reading the toast.
  st.copied = key;
  ctx.rerender();
  setTimeout(() => {
    if (st.copied === key) {
      st.copied = "";
      ctx.rerender();
    }
  }, 1400);
}

export function iconButton(ic: IconName, label: string, onclick: (e: MouseEvent) => void, extra: Record<string, unknown> = {}) {
  return h("button", { type: "button", class: "icon-btn", "aria-label": label, title: label, onclick, ...extra }, icon(ic));
}

export function copyButton(ctx: Ctx, key: string, value: string, label: string) {
  const done = st.copied === key;
  return h(
    "button",
    {
      type: "button",
      class: `icon-btn${done ? " done" : ""}`,
      "aria-label": label,
      title: label,
      onclick: () => void copy(ctx, value, key),
    },
    icon(done ? "check" : "copy"),
  );
}

export function errorBox(): Child {
  return st.error ? h("div", { class: "error", role: "alert" }, icon("error"), h("div", {}, st.error)) : null;
}

// Ctrl/Cmd+Z runs a notice's Undo while it is up, so the keyboard does not have to reach it past the tab bar.
// In a text field the browser's own undo wins.
document.addEventListener("keydown", (e) => {
  const action = st.toastAction;
  if (!action || e.key.toLowerCase() !== "z" || !(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey) return;
  if ((e.target as HTMLElement | null)?.closest("input, textarea, [contenteditable]")) return;
  e.preventDefault();
  Object.assign(st, { toast: "", toastAction: undefined });
  toastId++;
  action.run();
});

export function toastEl(): Child {
  if (!st.toast) return null;
  // Only a new toast slides in; a re-render while it is up keeps it still.
  const fresh = toastShown !== toastId;
  toastShown = toastId;
  const action = st.toastAction;
  return h(
    "div",
    { class: `toast${st.toastError ? " error-toast" : ""}${fresh ? "" : " still"}${st.toastLeaving ? " out" : ""}`, role: st.toastError ? "alert" : "status" },
    icon(st.toastError ? "error" : "check"),
    h("span", {}, st.toast),
    action
      ? h("button", { type: "button", class: "btn text small toast-action", "aria-keyshortcuts": "Control+Z Meta+Z", onclick: () => (Object.assign(st, { toast: "", toastAction: undefined }), toastId++, action.run()) }, action.label)
      : null,
  );
}

export function topBar(...children: Child[]): HTMLElement {
  return h("div", { class: "top" }, ...children);
}

export function spacer(): HTMLElement {
  return h("span", { class: "spacer" });
}

export function sectionTitle(text: string): HTMLElement {
  return h("h2", { class: "section-title" }, text);
}

export function section(title: string, ...rows: Child[]): Child[] {
  const present = rows.filter(Boolean);
  return present.length ? [sectionTitle(title), h("div", { class: "group" }, ...present)] : [];
}

export function progress(): HTMLElement {
  return h("div", { class: "progress" }, h("span", { class: "sr-only" }, t("loading", "")));
}

// ---------- popover menu ----------

export let openMenuEl: HTMLElement | undefined;

export function closeMenu() {
  openMenuEl?.remove();
  openMenuEl = undefined;
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  checked?: boolean;
  onClick: () => void;
}

/** A small popover menu anchored under a button; light-dismiss and Escape come from the platform. */
export function menu(anchor: HTMLElement, label: string, items: MenuItem[], radio = false) {
  closeMenu();
  const el = h(
    "div",
    { class: "menu", popover: "auto", role: "menu", "aria-label": label },
    ...items.map((it) =>
      h(
        "button",
        {
          type: "button",
          class: "menu-item",
          role: radio ? "menuitemradio" : "menuitem",
          ...(radio ? { "aria-checked": String(!!it.checked) } : {}),
          onclick: () => {
            closeMenu();
            it.onClick();
          },
        },
        it.icon ? icon(it.icon) : h("span", { class: "menu-gap" }),
        h("span", { class: "grow" }, it.label),
        it.checked ? icon("check") : null,
      ),
    ),
  );
  document.body.append(el);
  openMenuEl = el;
  const r = anchor.getBoundingClientRect();
  el.style.top = `${Math.round(r.bottom + 6)}px`;
  el.style.right = `${Math.round(Math.max(8, window.innerWidth - r.right))}px`;
  el.addEventListener("toggle", (e) => {
    if ((e as ToggleEvent).newState === "closed" && openMenuEl === el) openMenuEl = undefined;
  });
  el.showPopover();
  // Keep keyboard users in the menu: focus its first item.
  (el.querySelector("[role=menuitem], [role=menuitemradio]") as HTMLElement | null)?.focus();
}

// ---------- data ----------

/**
 * The label-and-value part of a row copies its value on a click or Enter, like its copy button. A click
 * on a link or button inside it, or one that ends a text selection, does not.
 */
export function copyOnClick(ctx: Ctx, key: string, value: () => string, title: string): Record<string, unknown> {
  const run = () => void copy(ctx, value(), key);
  return {
    class: "body copyable",
    role: "button",
    tabindex: "0",
    title: t("copyField", title),
    onclick: (e: MouseEvent) => {
      if ((e.target as Element).closest("a,button,input,textarea,select,details") || getSelection()?.toString()) return;
      run();
    },
    onkeydown: (e: KeyboardEvent) => {
      if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
      e.preventDefault();
      run();
    },
  };
}

export async function loadList(ctx: Ctx) {
  st.loading = true;
  // Asked for alongside the list and shown with it, not after the sync: one render for both (the matches are quick),
  // as each render rebuilds the whole list, a long frame in a large vault.
  const page = send<PageMatches>({ type: "pageMatches" });
  const r = await send<VaultList>({ type: "vaultList" });
  const p = r.ok ? await page : undefined;
  st.loading = false;
  if (r.ok) st.list = r.data;
  else st.error = r.error;
  if (p?.ok) st.page = p.data;
  ctx.rerender();
  if (!r.ok) return;
  // Opened by the inline menu's "Create account": go straight to the form.
  const site = await send<string | null>({ type: "takeNewLogin" });
  if (site.ok && site.data) startEdit(ctx, undefined, sitePrefill(site.data));
  await returnFromPicker(ctx);
  await syncNow(ctx, false);
}

/** A push sync changed the vault in the background: show the new list without leaving the current screen. */
export async function reloadList(): Promise<void> {
  // A save of this screen stores the vault before it answers: its own answer brings the list, a second render is waste.
  if (!st.list || !currentCtx || st.busy) return;
  const r = await send<VaultList>({ type: "vaultList", passive: true });
  if (r.ok) st.list = r.data;
  await refreshPageMatches(true);
  currentCtx.rerender();
}

/** Re-reads the logins matching the active tab (e.g. after the default URI match setting changed). */
export async function refreshPageMatches(passive = false): Promise<void> {
  const p = await send<PageMatches>({ type: "pageMatches", passive });
  if (p.ok) st.page = p.data;
}

export async function syncNow(ctx: Ctx, force: boolean) {
  st.syncing = true;
  syncButton();
  const r = await send<VaultList | null>({ type: "sync", force });
  st.syncing = false;
  if (r.ok && r.data) {
    st.list = r.data;
    // New data can add matches for the current site.
    const p = await send<PageMatches>({ type: "pageMatches" });
    if (p.ok) st.page = p.data;
  }
  if (!r.ok) st.error = r.error;
  // Nothing new (null): only the spinner changes, so the list is not rebuilt for it.
  if (r.ok && !r.data) syncButton();
  else ctx.rerender();
}

/** The list's sync button follows st.syncing in place; a screen without it picks the state up on its next render. */
export function syncButton() {
  const b = document.getElementById("vault-sync") as HTMLButtonElement | null;
  if (!b) return;
  b.classList.toggle("spin", st.syncing);
  b.disabled = st.syncing;
}

export function open(ctx: Ctx, route: Route) {
  clearInterval(timers.totp);
  stopRepromptWatch();
  const from = st.route;
  Object.assign(st, { route, error: undefined, confirmDelete: 0, totp: undefined, totpFailed: undefined, large: undefined, qr: undefined, notesPreview: false, pwned: undefined, memory: undefined, reveal: new Set(), copied: "", uriOpen: new Set(), picking: undefined, repromptFor: undefined, itemFailedFor: undefined });
  if (route.kind !== "edit") st.draft = undefined;
  else if (from.kind !== "edit") st.draftAtOpen = JSON.stringify(st.draft);
  if (route.kind === "org") orgDraft.id = ""; // read from the item on the first render
  if (route.kind === "report") void loadReport(ctx);
  else st.report = undefined;
  if (route.kind === "item") noteOpened(route.id);
  ctx.rerender();
  // Back on the list, focus returns to the row the item was opened from (the copy in view, when it is listed twice).
  if (route.kind === "list" && from.kind === "item") {
    const id = from.id;
    ctx.afterRender(() => {
      const rows = [...document.querySelectorAll<HTMLElement>(`[data-item="${CSS.escape(id)}"]`)];
      const seen = rows.find((r) => { const b = r.getBoundingClientRect(); return b.top >= 0 && b.bottom <= innerHeight; });
      (seen ?? rows[0])?.focus({ preventScroll: true });
    });
  }
}
