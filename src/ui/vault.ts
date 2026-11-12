// Vault screens: list (search, filters, sort), item view, Login/Note/Card/Identity editor. The generator is generator.ts.
// Talks to the service worker only; decrypted data lives here just while the popup is open.
import type { FillResult, PageLogin } from "../autofill/types.ts";
import { URI_MATCH, URI_MATCH_ADVANCED } from "../shared/constants.ts";
import { cardBrand, groupCardNumber, luhnValid } from "../shared/card.ts";
import { cardMark } from "./card-mark.ts";
import { cachedFavicon, type Favicon, loadFavicon } from "./favicon.ts";
import { LINKED, linkedIdFor, linkedKey } from "../shared/linked-fields.ts";
import { hasMarkup } from "../shared/markdown.ts";
import { MAX_QR_BYTES } from "../shared/qr.ts";
import { byRelevance, type Clause, folded, matchesQuery, parseQuery, type Searchable } from "../shared/search.ts";
import { passwordLevel } from "../shared/strength.ts";
import { clipboardDigest } from "../shared/digest.ts";
import { isInsecureUri, mainPage, toHttps } from "../shared/uri-tools.ts";
import type { PageMatches, Response as Reply, SecurityReport, Settings, VaultItem, VaultList } from "../shared/messages.ts";
import { type Child, chipRow, enter, h, inPanel, leave, plural, rowOf, send, t, when, withChevron } from "./dom.ts";
import { type GeneratorPick, generatorScreen, resetGenerator, startGeneratorPick } from "./generator.ts";
import { icon, type IconName } from "./icons.ts";
import { renderMarkdown } from "./markdown.ts";
import { fetchRange, pwnedCount } from "./pwned.ts";
import { qrSvg } from "./qr.ts";

type Json = Record<string, unknown>;
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

type Sort = "name" | "nameDesc" | "updated" | "created" | "opened";
type Route = { kind: "list" } | { kind: "item"; id: string } | { kind: "edit"; isNew: boolean } | { kind: "folders" } | { kind: "org"; id: string } | { kind: "report" };

interface EditDraft {
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

const SORT_KEY = "vaultSort";
const SORTS: { id: Sort; label: string }[] = [
  { id: "name", label: "sortNameAsc" },
  { id: "nameDesc", label: "sortNameDesc" },
  { id: "updated", label: "sortUpdated" },
  { id: "created", label: "sortCreated" },
  { id: "opened", label: "sortOpened" },
];

// How often and when each item was opened: kept encrypted by the service worker (background/private.ts) and
// handed over with the list, never synced.
type Opened = Record<string, { n: number; at: number }>;
const loadOpened = (): Opened => st.list?.opened ?? {};
try {
  localStorage.removeItem("vaultOpened"); // clear-text copy kept by older builds
} catch {
  /* framed pages have no storage */
}

/** The list's "Recently opened" section, a device setting; the history itself is kept for the "opened" sort. */
const RECENT_KEY = "vaultRecentHidden";
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

function noteOpened(id: string) {
  if (st.list) st.list.opened = { ...loadOpened(), [id]: { n: (loadOpened()[id]?.n ?? 0) + 1, at: Date.now() } };
  void send({ type: "itemOpened", id });
}

function savedSort(): Sort {
  try {
    const v = localStorage.getItem(SORT_KEY);
    if (SORTS.some((s) => s.id === v)) return v as Sort;
  } catch {
    /* framed pages have no storage */
  }
  return "name";
}

const st = {
  list: undefined as VaultList | undefined,
  /** The security report screen: the lists, and the breach check's progress and findings. */
  report: undefined as { data?: SecurityReport; exposed?: Map<string, number>; done: number; running: boolean; failed: boolean } | undefined,
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
let totpTimer: ReturnType<typeof setInterval> | undefined;
/** Seconds left at which the next code is pointed out. */
const TOTP_SOON = 10;
/** An open flagged item re-checks its grant: it expires, and dies with the service worker. */
let repromptTimer: ReturnType<typeof setInterval> | undefined;
const REPROMPT_CHECK_MS = 10_000;

function stopRepromptWatch() {
  clearInterval(repromptTimer);
  repromptTimer = undefined;
}

export function resetVault(): void {
  resetGenerator();
  clearInterval(totpTimer);
  stopRepromptWatch();
  closeMenu();
  Object.assign(st, {
    list: undefined, report: undefined, page: undefined, loading: false, syncing: false, busy: false, error: undefined, route: { kind: "list" }, query: "",
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

// ---------- helpers ----------

const str = (v: unknown) => (typeof v === "string" ? v : "");
const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : undefined);

function hue(s: string): number {
  let x = 0;
  for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return x % 360;
}

/** An absolute http(s) URL for `u`, or undefined when it is not one. */
function webUrl(u: string): string | undefined {
  try {
    const url = new URL(/^[a-z][\w+.-]*:/i.test(u) ? u : `https://${u}`);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** The server's icon service (`<server>/icons/<host>/icon.png`); unset when website icons are off. */
let iconBase: string | undefined;
export const setIconBase = (base: string | undefined) => (iconBase = base);

function iconUrl(uris: string[]): string | undefined {
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

let toastId = 0;
let toastShown = 0;
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

function spacer(): HTMLElement {
  return h("span", { class: "spacer" });
}

export function sectionTitle(text: string): HTMLElement {
  return h("h2", { class: "section-title" }, text);
}

function section(title: string, ...rows: Child[]): Child[] {
  const present = rows.filter(Boolean);
  return present.length ? [sectionTitle(title), h("div", { class: "group" }, ...present)] : [];
}

function progress(): HTMLElement {
  return h("div", { class: "progress" }, h("span", { class: "sr-only" }, t("loading", "")));
}

// ---------- popover menu ----------

let openMenuEl: HTMLElement | undefined;

function closeMenu() {
  openMenuEl?.remove();
  openMenuEl = undefined;
}

interface MenuItem {
  label: string;
  icon?: IconName;
  checked?: boolean;
  onClick: () => void;
}

/** A small popover menu anchored under a button; light-dismiss and Escape come from the platform. */
function menu(anchor: HTMLElement, label: string, items: MenuItem[], radio = false) {
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
function copyOnClick(ctx: Ctx, key: string, value: () => string, title: string): Record<string, unknown> {
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

async function loadList(ctx: Ctx) {
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

async function syncNow(ctx: Ctx, force: boolean) {
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
function syncButton() {
  const b = document.getElementById("vault-sync") as HTMLButtonElement | null;
  if (!b) return;
  b.classList.toggle("spin", st.syncing);
  b.disabled = st.syncing;
}

function open(ctx: Ctx, route: Route) {
  clearInterval(totpTimer);
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

// ---------- list ----------

const TYPE_LABEL: Record<number, string> = { 1: "typeLogin", 2: "typeNote", 3: "typeCard", 4: "typeIdentity", 5: "typeSshKey", 6: "typeBankAccount", 7: "typeDriversLicense", 8: "typePassport" };

const TYPE_ENGLISH: Record<number, string> = { 1: "login", 2: "note", 3: "card", 4: "identity", 5: "ssh" };

// A new list (sync, save, rename) brings new item objects, so an entry never outlives its item's text.
const searchCache = new WeakMap<VaultItem, Searchable>();

function searchable(i: VaultItem): Searchable {
  let s = searchCache.get(i);
  if (!s) searchCache.set(i, (s = folded(searchFields(i))));
  return s;
}

function searchFields(i: VaultItem): Searchable {
  const typeKey = TYPE_LABEL[i.type];
  const flags = [i.favorite && "favorite", i.reused && "reused", i.weak && "weak", i.hasTotp && "totp", i.reprompt && "reprompt"].filter((f): f is string => !!f);
  return {
    name: i.name,
    sub: i.sub,
    uris: i.uris,
    folder: st.list?.folders.find((f) => f.id === i.folderId)?.name ?? "",
    type: [typeKey ? t(typeKey) : "", TYPE_ENGLISH[i.type] ?? ""].filter(Boolean),
    flags,
  };
}

function matches(i: VaultItem, clauses: Clause[]): boolean {
  const f = st.folder;
  if (f === "fav") {
    if (!i.favorite) return false;
  } else if (f.startsWith("t:")) {
    if (i.type !== Number(f.slice(2))) return false;
  } else if (f === "reused") {
    if (!i.reused) return false;
  } else if (f === "weak") {
    if (!i.weak) return false;
  } else if (f === "none") {
    if (i.folderId) return false;
  } else if (f && f !== "trash" && f !== "archive" && i.folderId !== f) return false;
  return !clauses.length || matchesQuery(clauses, searchable(i));
}

function sortItems(items: VaultItem[]): VaultItem[] {
  const byName = (a: VaultItem, b: VaultItem) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) || a.id.localeCompare(b.id);
  const list = [...items];
  if (st.sort === "nameDesc") return list.sort((a, b) => byName(b, a));
  if (st.sort === "updated") return list.sort((a, b) => (b.revisionDate ?? 0) - (a.revisionDate ?? 0) || byName(a, b));
  if (st.sort === "created") return list.sort((a, b) => (b.creationDate ?? 0) - (a.creationDate ?? 0) || byName(a, b));
  if (st.sort === "opened") {
    const opened = loadOpened();
    return list.sort((a, b) => (opened[b.id]?.n ?? 0) - (opened[a.id]?.n ?? 0) || byName(a, b));
  }
  return list.sort(byName);
}

// ---------- quick actions ----------

/** The full item for a quick action. A flagged one opens its view instead, where the master password is asked. */
async function fullItem(ctx: Ctx, id: string): Promise<Json | undefined> {
  const r = await send<Json>({ type: "getItem", id });
  if (r.ok) return r.data;
  if (r.code === "reprompt") open(ctx, { kind: "item", id });
  else toast(ctx, r.error, { error: true });
  return undefined;
}

async function copyOf(ctx: Ctx, id: string, pick: (item: Json) => string) {
  const item = await fullItem(ctx, id);
  if (!item) return;
  const value = pick(item);
  if (value) await copy(ctx, value);
  else toast(ctx, t("nothingToCopy"));
}

async function copyTotp(ctx: Ctx, id: string) {
  const r = await send<{ code: string }>({ type: "totp", id });
  if (r.ok) await copy(ctx, r.data.code);
  else if (r.code === "reprompt") open(ctx, { kind: "item", id });
  else toast(ctx, r.error, { error: true });
}

const iconMode = () => !settingsOf()?.quickActionMenus;

/**
 * Quick actions of a list row, like the official extension. By default one button each for a login:
 * open the website, copy the username, the password and the code (dimmed when the login has none); for a
 * card: copy the number and the security code. With
 * the "Compact row actions" setting: a copy button (a menu when there is a choice) and "⋮" with
 * favorite, website, edit and clone. Secrets are fetched on use, through the worker's re-prompt check.
 */
function rowActions(ctx: Ctx, i: VaultItem): Child[] {
  if (i.failed) return [];
  const field = (o: string, k: string) => (item: Json) => str(obj(item[o])?.[k]);
  const name = i.name || t("untitled");
  if (iconMode()) {
    const button = (ic: IconName, text: string, run: () => void, enabled: boolean) =>
      iconButton(ic, `${text} (${name})`, run, { class: "icon-btn sm quick-action", disabled: !enabled });
    if (i.type === 3)
      return [
        button("card", t("copyField", label("number")), () => void copyOf(ctx, i.id, field("card", "number")), true),
        button("key", t("copyField", label("code")), () => void copyOf(ctx, i.id, field("card", "code")), true),
      ];
    if (i.type !== 1) return [];
    const url = i.uris.map(webUrl).find(Boolean);
    return [
      button("external", t("openWebsite"), () => void chrome.tabs.create({ url: url! }), !!url),
      button("user", t("copyField", label("username")), () => void copy(ctx, i.sub), !!i.sub),
      button("key", t("copyField", label("password")), () => void copyOf(ctx, i.id, field("login", "password")), !i.noPassword),
      button("timer", t("copyField", t("oneTimeCode")), () => void copyTotp(ctx, i.id), i.hasTotp),
    ];
  }
  const copies: MenuItem[] =
    i.type === 1
      ? [
          ...(i.sub ? [{ label: t("copyField", label("username")), icon: "user" as const, onClick: () => void copy(ctx, i.sub) }] : []),
          { label: t("copyField", label("password")), icon: "key", onClick: () => void copyOf(ctx, i.id, field("login", "password")) },
          ...(i.hasTotp ? [{ label: t("copyField", t("oneTimeCode")), icon: "timer" as const, onClick: () => void copyTotp(ctx, i.id) }] : []),
        ]
      : i.type === 3
        ? [
            { label: t("copyField", label("number")), icon: "card", onClick: () => void copyOf(ctx, i.id, field("card", "number")) },
            { label: t("copyField", label("code")), icon: "key", onClick: () => void copyOf(ctx, i.id, field("card", "code")) },
          ]
        : i.type === 2
          ? [{ label: t("copyField", t("notes")), icon: "note", onClick: () => void copyOf(ctx, i.id, (item) => str(item.notes)) }]
          : [];
  const url = i.uris.map(webUrl).find(Boolean);
  const editable = !i.readOnly && st.folder !== "trash";
  const more: MenuItem[] = [
    ...(editable
      ? [
          {
            label: t(i.favorite ? "unfavorite" : "favorite"),
            icon: (i.favorite ? "starBorder" : "star") as IconName,
            onClick: () => void fullItem(ctx, i.id).then((item) => item && vaultAction(ctx, { type: "saveItem", item: { ...item, favorite: !i.favorite } }, "saved", false)),
          },
        ]
      : []),
    ...(url ? [{ label: t("openWebsite"), icon: "external" as const, onClick: () => void chrome.tabs.create({ url }) }] : []),
    ...(editable
      ? [
          { label: t("edit"), icon: "edit" as const, onClick: () => void fullItem(ctx, i.id).then((item) => item && startEdit(ctx, item)) },
          {
            label: t("clone"),
            icon: "copy" as const,
            onClick: () =>
              void fullItem(ctx, i.id).then(
                (item) => item && startEdit(ctx, { ...structuredClone(item), id: undefined, attachments: null, name: `${str(item.name)} ${t("copySuffix")}`, passwordHistory: null }, {}, true),
              ),
          },
        ]
      : []),
  ];
  const copyBtn: HTMLElement | null =
    copies.length === 1
      ? iconButton("copy", `${copies[0]!.label} (${name})`, copies[0]!.onClick, { class: "icon-btn sm" })
      : copies.length
        ? iconButton("copy", t("copyOptions", name), () => menu(copyBtn!, t("copyOptions", name), copies), { class: "icon-btn sm", "aria-haspopup": "menu" })
        : null;
  const moreBtn: HTMLElement | null = more.length
    ? iconButton("more", t("moreOptions", name), () => menu(moreBtn!, t("moreOptions", name), more), { class: "icon-btn sm", "aria-haspopup": "menu" })
    : null;
  return [copyBtn, moreBtn];
}

/** The status marks after a row's name (code, weak or reused, favorite), the same in every list section. */
function rowMarks(i: VaultItem): Child[] {
  return [
    i.hasTotp && !(iconMode() && i.type === 1) ? h("span", { class: "meta" }, icon("timer", t("oneTimeCode"))) : null,
    i.reused || i.weak ? h("span", { class: "meta warn" }, icon("error", t(i.reused ? "filterReused" : "filterWeak"))) : null,
    i.favorite ? h("span", { class: "meta fav" }, icon("star", t("favorite"))) : null,
  ];
}

/** What a screen reader says for a row: the action, then what the eye sees in it (username and the marks). */
function rowLabel(i: VaultItem, name: string): string {
  const marks = [i.sub, i.hasTotp ? t("oneTimeCode") : "", i.reused ? t("filterReused") : i.weak ? t("filterWeak") : "", i.favorite ? t("favorite") : ""];
  return [t("showItem", name), ...marks.filter(Boolean)].join(", ");
}

function itemRow(ctx: Ctx, i: VaultItem): HTMLElement {
  const name = i.failed ? t("decryptFailed") : i.name || t("untitled");
  return h(
    "div",
    // The row is the list item; the button inside keeps its button role (a role on it would replace that).
    { class: "row", role: "listitem" },
    h(
      "button",
      {
        type: "button",
        class: "row-main",
        "data-item": i.id,
        "aria-label": rowLabel(i, name),
        onclick: () => open(ctx, { kind: "item", id: i.id }),
      },
      tile(i.name, i.type, i.uris, i.brand),
      h(
        "div",
        { class: "body" },
        h("span", { class: "title" }, name),
        h("span", { class: "sub" }, i.sub || t(TYPE_LABEL[i.type] ?? "untitled")),
      ),
      ...rowMarks(i),
    ),
    ...rowActions(ctx, i),
    // Fill sits only on the rows listed for this page (suggestionRow): repeated down the whole vault it hid which
    // rows match. Any other item still fills from its own view ("Fill this site", with the mismatch check).
  );
}

function emptyState(ctx: Ctx, q: string): HTMLElement {
  const filtered = !!(q || st.folder);
  const key = st.folder === "trash" ? "trashEmpty" : st.folder === "archive" ? "archiveEmpty" : st.folder === "fav" ? "favoritesEmpty" : filtered ? "noMatches" : "vaultEmpty";
  // What fills this view, said where it is empty.
  const hint = st.folder === "trash" ? "trashEmptyHint" : st.folder === "archive" ? "archiveEmptyHint" : st.folder === "fav" ? undefined : filtered ? "noMatchesHint" : "vaultEmptyHint";
  return h(
    "div",
    { class: "empty" },
    h("strong", {}, t(key)),
    hint ? h("p", {}, t(hint)) : null,
    !filtered
      ? h(
          "div",
          { class: "row-actions" },
          h("button", { type: "button", class: "btn text small", onclick: () => ctx.goto("settings", t("importVault")) }, icon("download"), t("importVault")),
          h("button", { type: "button", class: "btn filled small", onclick: () => void newItem(ctx) }, icon("plus"), t("newItem")),
        )
      : null,
    filtered
      ? h(
          "button",
          {
            type: "button",
            class: "btn text small",
            onclick: () => {
              st.query = "";
              st.folder = "";
              ctx.rerender();
            },
          },
          // Names what is on: a typed search alone is cleared, not "filters".
          t(st.folder ? "clearFilters" : "clearSearch"),
        )
      : null,
  );
}

function fillList(ctx: Ctx, box: HTMLElement, items: VaultItem[], q: string) {
  const nodes: Child[] = [];
  // While searching, the best matches lead (relevance), so there are no letter headings to split them.
  const grouped = !q && (st.sort === "name" || st.sort === "nameDesc");
  if (q) items = byRelevance(items, q);
  // Each card is its own list; the headings between them stay outside any list.
  const pushGroup = (list: VaultItem[]) => nodes.push(h("div", { class: "group", role: "list" }, ...list.map((i) => itemRow(ctx, i))));
  const browsing = !q && !st.folder;
  const page = st.page?.host && st.folder !== "trash" && !q ? st.page : undefined;
  const shownAbove = new Set<string>();
  // The site's own logins lead, also inside a filter (the ones the filter keeps).
  if (page) {
    const ids = new Set(page.items.filter((i) => i.type === 1).map((i) => i.id));
    const site = items.filter((i) => ids.has(i.id));
    for (const i of site) shownAbove.add(i.id);
    // An empty vault leads with its own empty state: no site heading over nothing.
    if (items.length && (site.length || browsing)) {
      nodes.push(sectionTitle(t("onThisSite", page.host!)));
      if (site.length) nodes.push(h("div", { class: "group", role: "list" }, ...site.map((i) => suggestionRow(ctx, i))));
      if (browsing) nodes.push(h("button", { type: "button", class: "btn text small add-page", onclick: () => void saveFromPage(ctx) }, icon("plus"), t("saveFromPage")));
    }
  }
  if (!items.length) {
    nodes.push(emptyState(ctx, q));
  } else {
    // Favorites next; a letter index is kept for the rest.
    // A favorite already listed for this site above is not listed again.
    const favs = q ? [] : items.filter((i) => i.favorite && !shownAbove.has(i.id));
    const rest = favs.length ? items.filter((i) => !i.favorite) : items;
    if (favs.length) {
      nodes.push(sectionTitle(t("favorites")));
      pushGroup(favs);
      for (const i of favs) shownAbove.add(i.id);
    }
    // Then recently opened items, while browsing a vault big enough to need them; one already shown above is left out.
    if (browsing && items.length > 8 && recentShown()) {
      const opened = loadOpened();
      const recent = items.filter((i) => opened[i.id] && !shownAbove.has(i.id)).sort((a, b) => opened[b.id]!.at - opened[a.id]!.at).slice(0, 3);
      if (recent.length) {
        nodes.push(
          h(
            "div",
            { class: "section-head" },
            sectionTitle(t("recentlyOpened")),
            h("button", { type: "button", class: "btn text small", onclick: () => void clearOpened().then(() => ctx.rerender()) }, t("clear")),
          ),
        );
        pushGroup(recent);
      }
    }
    // Cards and identities to fill on this page belong to no site: headings of their own, like the official client.
    if (page && browsing)
      for (const [type, title] of [[3, "typeCards"], [4, "typeIdentities"]] as const) {
        const list = page.items.filter((i) => i.type === type);
        if (list.length) nodes.push(sectionTitle(t(title)), h("div", { class: "group", role: "list" }, ...list.map((i) => suggestionRow(ctx, i))));
      }
    if (!grouped) {
      if (rest.length) pushGroup(rest);
    } else {
      let letter = "";
      let bucket: VaultItem[] = [];
      const flush = () => {
        if (!bucket.length) return;
        nodes.push(h("h2", { class: "letter" }, letter));
        pushGroup(bucket);
        bucket = [];
      };
      for (const i of rest) {
        const l = /[\p{L}\p{N}]/u.test(i.name[0] ?? "") ? i.name[0]!.toUpperCase() : "#";
        if (l !== letter) {
          flush();
          letter = l;
        }
        bucket.push(i);
      }
      flush();
    }
  }
  box.replaceChildren(...(nodes.filter(Boolean) as Node[]));
}

function arrowNav(box: HTMLElement) {
  box.addEventListener("keydown", (e) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const rows = [...box.querySelectorAll<HTMLElement>("[role=listitem] > .row-main")];
    const at = rows.indexOf(document.activeElement as HTMLElement);
    if (at < 0) return;
    e.preventDefault();
    // Up from the first row goes back to the search box it came from.
    if (at === 0 && e.key === "ArrowUp") return void document.getElementById("vault-search")?.focus();
    const next = e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : at + (e.key === "ArrowDown" ? 1 : -1);
    rows[Math.max(0, Math.min(rows.length - 1, next))]?.focus();
  });
}

let skeletonShown = false;
/** The skeleton while the first list loads; the list that replaces it fades in (popup.css .list-body.enter). */
function listOrSkeleton(list: HTMLElement): HTMLElement {
  const loading = st.loading && !st.list;
  if (!loading && skeletonShown) list.classList.add("enter");
  skeletonShown = loading;
  return loading ? skeletonList() : list;
}

function skeletonList(): HTMLElement {
  return h(
    "div",
    { class: "group", "aria-hidden": "true" },
    ...Array.from({ length: 7 }, () =>
      h(
        "div",
        { class: "row skeleton" },
        h("span", { class: "tile skeleton-tile" }),
        h("div", { class: "body" }, h("span", { class: "skeleton-line w40" }), h("span", { class: "skeleton-line w70" })),
      ),
    ),
  );
}

function listView(ctx: Ctx): HTMLElement {
  if (st.folder === "trash" && st.list && !st.list.trash.length) st.folder = ""; // the trash was emptied
  if (st.folder === "archive" && st.list && !st.list.archive.length) st.folder = ""; // the last item left the archive
  const listBox = h("div", { class: "list-body" });
  arrowNav(listBox);
  const addBtn = iconButton("plus", t("newItem"), () => void newItem(ctx), { class: "icon-btn sm add" });
  const redraw = () => {
    const q = st.query.trim().toLowerCase();
    const source = st.folder === "trash" ? st.list?.trash : st.folder === "archive" ? st.list?.archive : st.list?.items;
    const clauses = parseQuery(st.query);
    const items = sortItems((source ?? []).filter((i) => matches(i, clauses)));
    fillList(ctx, listBox, items, q);
    // The empty vault leads with its own "New item" (emptyState): the header one would say it twice.
    addBtn.hidden = !(st.loading && !st.list) && !items.length && !q && !st.folder; // not under the first-load skeleton
    // Said to screen readers while a search or filter is on: how many items it leaves (polite, so typing is not cut).
    status.textContent = q || st.folder ? (items.length ? plural("itemsFound", items.length) : t("noMatches")) : "";
  };
  const status = h("p", { class: "sr-only", role: "status" });
  redraw();

  const input = h("input", {
    id: "vault-search",
    type: "search",
    placeholder: t("searchVault"),
    "aria-label": t("searchVault"),
    "aria-keyshortcuts": "/",
    title: t("searchHint"),
    value: st.query,
    ...(st.sawList ? {} : { "data-autofocus": "1" }),
    oninput: (e: Event) => {
      st.query = (e.target as HTMLInputElement).value;
      clearBtn.hidden = !st.query;
      redraw(); // list only, so the search box keeps focus and caret
    },
    onkeydown: (e: KeyboardEvent) => {
      // ArrowDown steps into the results; Enter opens the first one.
      const first = document.querySelector<HTMLElement>(".list-body [role=listitem] > .row-main");
      if ((e.key === "ArrowDown" || e.key === "Enter") && first && !e.isComposing) {
        e.preventDefault();
        if (e.key === "Enter") first.click();
        else first.focus();
        return;
      }
      if (e.key === "Escape" && st.query) {
        e.stopPropagation();
        st.query = "";
        input.value = "";
        clearBtn.hidden = true;
        redraw();
      }
    },
  });
  st.sawList = true;
  const clearBtn = h(
    "button",
    {
      type: "button",
      class: "icon-btn sm",
      "aria-label": t("clearSearch"),
      title: t("clearSearch"),
      hidden: !st.query,
      onclick: () => {
        st.query = "";
        input.value = "";
        clearBtn.hidden = true;
        redraw();
        input.focus();
      },
    },
    icon("close"),
  );

  const sortButton = iconButton("sort", t("sort"), () => {}, { class: "icon-btn sm", "aria-haspopup": "menu" });
  sortButton.onclick = () =>
    menu(
      sortButton,
      t("sort"),
      SORTS.map((s) => ({
        label: t(s.label),
        checked: st.sort === s.id,
        onClick: () => {
          st.sort = s.id;
          try {
            localStorage.setItem(SORT_KEY, s.id);
          } catch {
            /* no storage */
          }
          ctx.rerender();
        },
      })),
      true,
    );

  const folders = st.list?.folders ?? [];
  const chip = (id: string, label: string, ic?: IconName) =>
    h(
      "button",
      {
        type: "button",
        class: "chip",
        id: `chip-${id}`,
        "aria-pressed": String(st.folder === id),
        onclick: () => {
          st.folder = st.folder === id ? "" : id;
          ctx.rerender();
        },
      },
      ic ? icon(ic) : null,
      label,
    );

  return h(
    "div",
    { class: "page list-page" },
    topBar(
      h("div", { class: "search" }, icon("search"), input, clearBtn),
      sortButton,
      iconButton("refresh", t("syncNow"), () => void syncNow(ctx, true), { id: "vault-sync", class: `icon-btn sm${st.syncing ? " spin" : ""}`, disabled: st.syncing }),
      iconButton("lock", t("lockNow"), () => ctx.lock(), { class: "icon-btn sm" }),
      addBtn,
    ),
    chipRow(
      // Filters over an empty vault could only ever say "no matches".
      { role: "group", "aria-label": t("filters"), hidden: st.list?.items.length === 0 && !st.list.trash.length && !st.list.archive.length },
      chip("fav", t("favorites"), "starBorder"), // outline, like the other chips' glyphs
      chip("t:1", t("typeLogin"), "key"),
      chip("t:3", t("typeCard"), "card"),
      chip("t:4", t("typeIdentity"), "user"),
      chip("t:2", t("typeNote"), "note"),
      ...([[6, "landmark"], [7, "card"], [8, "globe"]] as const).map(([type, ic]) => (st.list?.items.some((i) => i.type === type) ? chip(`t:${type}`, t(TYPE_LABEL[type]!), ic) : null)),
      st.list?.items.some((i) => i.reused) ? chip("reused", t("filterReused"), "error") : null,
      st.list?.items.some((i) => i.weak) ? chip("weak", t("filterWeak"), "error") : null,
      ...folders.map((f) => chip(f.id, f.name, "folder")),
      folders.length ? chip("none", t("noFolder"), "folder") : null,
      st.list?.archive.length ? chip("archive", t("archiveCount", String(st.list.archive.length)), "archive") : null,
      st.list?.trash.length ? chip("trash", t("trashCount", String(st.list.trash.length)), "trash") : null,
      h("button", { type: "button", class: "chip", onclick: () => open(ctx, { kind: "report" }) }, icon("shield"), t("securityReport")),
      h("button", { type: "button", class: "chip", onclick: () => open(ctx, { kind: "folders" }) }, icon("edit"), t("folders")),
    ),
    errorBox(),
    status,
    listOrSkeleton(listBox),
  );
}

// ---------- this site ----------

async function fill(ctx: Ctx, id: string, anyway = false, page = st.page) {
  // Bound to the page shown here: the worker refuses once the tab or its site changed, also after the dialog.
  const { tabId, origin, host } = page ?? {};
  if (tabId === undefined || !origin) return toast(ctx, t("fillFailed"), { error: true });
  const r = await send<FillResult>({ type: "fill", id, tabId, origin, anyway });
  if (r.ok && r.data.filled) window.close();
  // A flagged item: its view shows the master-password screen (itemView gets "reprompt" from getItem).
  else if (!r.ok && r.code === "reprompt") open(ctx, { kind: "item", id });
  // A login saved for another site: fill only after the user says so, like the official client.
  else if (r.ok && r.data.reason === "noMatch" && !anyway && host && (await confirmFill(host))) await fill(ctx, id, true, page);
  else {
    toast(ctx, r.ok ? t("fillFailed") : r.error, { error: true });
    // Show the site the browser is on now, so the next click is for the page the user sees.
    if (!r.ok) await refreshPageMatches(true).then(() => ctx.rerender());
  }
}

function confirmFill(host: string): Promise<boolean> {
  const choose = (v: string) => () => d.close(v);
  const d = h(
    "dialog",
    { class: "confirm", "aria-labelledby": "confirm-fill-text" },
    h("p", { id: "confirm-fill-text" }, t("fillNoMatch", host)),
    h(
      "div",
      { class: "actions" },
      h("button", { type: "button", class: "btn text", onclick: choose("") }, t("cancel")),
      h("button", { type: "button", class: "btn filled", onclick: choose("fill") }, t("fillAnyway")),
    ),
  );
  document.body.append(d);
  d.showModal();
  return new Promise((resolve) => d.addEventListener("close", () => (d.remove(), resolve(d.returnValue === "fill"))));
}

const fillButton = (ctx: Ctx, i: VaultItem) =>
  h("button", { type: "button", class: "btn small tonal", "aria-label": t("fillNamed", i.name), onclick: () => void fill(ctx, i.id) }, t("fill"));

/** Save what the user typed on the page: update the login with the same username, or create one. */
async function saveFromPage(ctx: Ctx) {
  const page = st.page;
  if (page?.tabId === undefined || !page.origin) return toast(ctx, t("noLoginOnPage"), { error: true });
  // The page the site section shows, so the logins compared below are that site's.
  const r = await send<PageLogin | null>({ type: "readPageLogin", tabId: page.tabId, origin: page.origin });
  if (!r.ok || !r.data) return toast(ctx, r.ok ? t("noLoginOnPage") : r.error, { error: true });
  const login = r.data;
  const same = page.items.find((i) => i.type === 1 && !i.readOnly && i.sub === login.username);
  if (same) {
    const item = await send<Json>({ type: "getItem", id: same.id });
    if (item.ok) return startEdit(ctx, item.data, { data: { password: login.password } });
    if (item.code === "reprompt") return open(ctx, { kind: "item", id: same.id }); // never fall through to a duplicate
  }
  startEdit(ctx, undefined, { ...sitePrefill(new URL(login.url).origin), data: { username: login.username, password: login.password } });
}

/** A row of the site section: the body opens the item, the button fills it (cards and identities too). */
function suggestionRow(ctx: Ctx, i: VaultItem): HTMLElement {
  const name = i.name || t("untitled");
  return h(
    "div",
    // A list item like the vault rows, so the arrow keys and Enter from the search reach the site's matches first.
    { class: "row", role: "listitem" },
    h(
      "button",
      { type: "button", class: "row-main", "data-item": i.id, "aria-label": rowLabel(i, name), onclick: () => open(ctx, { kind: "item", id: i.id }) },
      tile(i.name, i.type, i.uris, i.brand),
      h("div", { class: "body" }, h("span", { class: "title" }, name), i.sub ? h("span", { class: "sub" }, i.sub) : null),
      ...rowMarks(i),
    ),
    ...rowActions(ctx, i),
    fillButton(ctx, i),
  );
}

// ---------- item types ----------

interface Spec {
  key: string;
  icon: IconName;
  secret?: boolean;
  mono?: boolean;
  options?: string[];
  area?: boolean;
}

const BRANDS = ["Visa", "Mastercard", "Amex", "Discover", "Diners Club", "JCB", "Maestro", "UnionPay", "RuPay", "Other"];
/** Type-specific fields per cipher type, in display order (labels: `field_<key>` in messages.json). */
const SCHEMA: Record<number, { obj: string; fields: Spec[] }> = {
  1: {
    obj: "login",
    fields: [
      { key: "username", icon: "user" },
      { key: "password", icon: "key", secret: true, mono: true },
      { key: "totp", icon: "timer", secret: true, mono: true },
    ],
  },
  3: {
    obj: "card",
    fields: [
      { key: "cardholderName", icon: "user" },
      { key: "brand", icon: "card", options: BRANDS },
      { key: "number", icon: "card", secret: true, mono: true },
      { key: "expMonth", icon: "calendar", options: Array.from({ length: 12 }, (_, i) => String(i + 1)) },
      { key: "expYear", icon: "calendar" },
      { key: "code", icon: "key", secret: true, mono: true },
    ],
  },
  4: {
    obj: "identity",
    fields: [
      { key: "title", icon: "user", options: ["Mr", "Mrs", "Ms", "Mx", "Dr"] },
      { key: "firstName", icon: "user" },
      { key: "middleName", icon: "user" },
      { key: "lastName", icon: "user" },
      { key: "username", icon: "user" },
      { key: "company", icon: "home" },
      { key: "email", icon: "mail" },
      { key: "phone", icon: "phone" },
      { key: "ssn", icon: "key", secret: true },
      { key: "passportNumber", icon: "key", secret: true },
      { key: "licenseNumber", icon: "key", secret: true },
      { key: "address1", icon: "home" },
      { key: "address2", icon: "home" },
      { key: "address3", icon: "home" },
      { key: "city", icon: "home" },
      { key: "state", icon: "home" },
      { key: "postalCode", icon: "home" },
      { key: "country", icon: "globe" },
    ],
  },
  6: {
    obj: "bankAccount",
    fields: [
      { key: "bankName", icon: "landmark" },
      { key: "nameOnAccount", icon: "user" },
      { key: "accountType", icon: "landmark" },
      { key: "accountNumber", icon: "key", secret: true, mono: true },
      { key: "routingNumber", icon: "key", mono: true },
      { key: "branchNumber", icon: "key", mono: true },
      { key: "pin", icon: "key", secret: true, mono: true },
      { key: "swiftCode", icon: "key", mono: true },
      { key: "iban", icon: "key", secret: true, mono: true },
      { key: "bankContactPhone", icon: "phone" },
    ],
  },
  7: {
    obj: "driversLicense",
    fields: [
      { key: "firstName", icon: "user" },
      { key: "middleName", icon: "user" },
      { key: "lastName", icon: "user" },
      { key: "dateOfBirth", icon: "calendar" },
      { key: "licenseNumber", icon: "key", secret: true, mono: true },
      { key: "issuingCountry", icon: "globe" },
      { key: "issuingState", icon: "globe" },
      { key: "issueDate", icon: "calendar" },
      { key: "expirationDate", icon: "calendar" },
      { key: "issuingAuthority", icon: "home" },
      { key: "licenseClass", icon: "card" },
    ],
  },
  8: {
    obj: "passport",
    fields: [
      { key: "givenName", icon: "user" },
      { key: "surname", icon: "user" },
      { key: "dateOfBirth", icon: "calendar" },
      { key: "sex", icon: "user" },
      { key: "birthPlace", icon: "globe" },
      { key: "nationality", icon: "globe" },
      { key: "passportNumber", icon: "key", secret: true, mono: true },
      { key: "passportType", icon: "card" },
      { key: "nationalIdentificationNumber", icon: "key", secret: true, mono: true },
      { key: "issuingCountry", icon: "globe" },
      { key: "issuingAuthority", icon: "home" },
      { key: "issueDate", icon: "calendar" },
      { key: "expirationDate", icon: "calendar" },
    ],
  },
  5: {
    obj: "sshKey",
    fields: [
      { key: "privateKey", icon: "key", secret: true, mono: true, area: true },
      { key: "publicKey", icon: "key", mono: true },
      { key: "keyFingerprint", icon: "key", mono: true },
    ],
  },
};
const label = (key: string) => t(`field_${key}`);

export function strength(pw: string): { label: string; level: number } {
  const level = passwordLevel(pw);
  return { level, label: t(["strengthWeak", "strengthFair", "strengthStrong", "strengthVeryStrong"][level]!) };
}

// ---------- item view ----------

/**
 * Master-password re-prompt, for items the user flagged in the web vault (`reprompt`). The worker
 * enforces it too: this screen only asks for the password that lifts the gate.
 */
function repromptView(ctx: Ctx, id: string): HTMLElement {
  const input = h("input", { id: "reprompt-password", type: "password", autocomplete: "current-password", required: true, "data-autofocus": "1", spellcheck: false });
  const onsubmit = async (e: Event) => {
    e.preventDefault();
    const password = input.value;
    input.value = "";
    st.busy = true;
    st.error = undefined;
    ctx.rerender();
    const r = await send({ type: "confirmReprompt", id, password });
    st.busy = false;
    if (!r.ok) st.error = r.error;
    else {
      st.repromptFor = undefined;
      st.item = undefined; // refetched with the gate lifted
    }
    ctx.rerender();
  };
  return h(
    "form",
    { class: "page center", onsubmit },
    topBar(iconButton("back", t("back"), () => open(ctx, { kind: "list" }))),
    h("div", { class: "brand" }, h("div", { class: "logo" }, icon("lock")), h("h1", {}, t("repromptTitle")), h("p", {}, t("repromptHint"))),
    h("div", { class: "field" }, h("label", { for: "reprompt-password" }, h("span", {}, t("masterPassword")), input)),
    errorBox(),
    st.busy ? progress() : null,
    h("div", { class: "actions" }, h("button", { type: "submit", class: "btn filled wide", disabled: st.busy }, t("repromptConfirm"))),
  );
}

function fieldRow(
  ctx: Ctx,
  key: string,
  ic: IconName,
  title: string,
  value: string,
  opts: { secret?: boolean; mono?: boolean; extra?: Child; copyValue?: string; menu?: MenuItem[]; display?: string } = {},
): HTMLElement {
  const shown = !opts.secret || st.reveal.has(key);
  const valueEl = h("span", { class: `value${opts.mono ? " mono" : ""}` });
  if (shown) {
    if (opts.mono && opts.secret) valueEl.append(...colorize(opts.display ?? value));
    else valueEl.textContent = opts.display ?? value;
  } else {
    valueEl.textContent = "•".repeat(Math.min(Math.max(value.length, 8), 16));
  }
  return h(
    "div",
    { class: `row field-row${opts.secret ? " elevated" : ""}` },
    icon(ic),
    h("div", copyOnClick(ctx, key, () => opts.copyValue ?? value, title), h("span", { class: "label" }, title), valueEl, opts.extra),
    h(
      "span",
      { class: "field-actions" },
      opts.secret
        ? iconButton(shown ? "eyeOff" : "eye", t(shown ? "hidePassword" : "showPassword"), () => {
            if (shown) st.reveal.delete(key);
            else st.reveal.add(key);
            ctx.rerender();
          })
        : null,
      copyButton(ctx, key, opts.copyValue ?? value, t("copyField", title)),
      moreButton(ctx, value, opts.menu),
    ),
  );
}

/** "⋮" for a value: Large Type, share as a Send, plus whatever the row adds. */
function moreButton(ctx: Ctx, value: string, extra: MenuItem[] = []): HTMLElement {
  const items: MenuItem[] = [
    ...extra,
    { label: t("largeType"), icon: "search", onClick: () => ((st.large = value), ctx.rerender()) },
    ...(new TextEncoder().encode(value).length <= MAX_QR_BYTES ? [{ label: t("showQr"), icon: "qr" as const, onClick: () => ((st.qr = { text: value }), ctx.rerender()) }] : []),
    { label: t("shareAsSend"), icon: "send", onClick: () => ctx.shareAsSend(value) },
  ];
  const b: HTMLElement = iconButton("more", t("moreActions"), () => menu(b, t("moreActions"), items), { "aria-haspopup": "menu" });
  return b;
}

function qrView(ctx: Ctx): HTMLElement {
  const { text, note } = st.qr!;
  return h(
    "div",
    { class: "page" },
    topBar(iconButton("back", t("back"), () => ((st.qr = undefined), ctx.rerender())), h("h1", { class: "grow" }, t("qrCode"))),
    h("div", { class: "qr-box" }, qrSvg(text, t("qrCode"))),
    note ? h("p", { class: "caption center" }, note) : null,
  );
}

/** The authenticator key as an otpauth:// URI, which is what authenticator apps scan. */
function otpauthUri(secret: string, name: string): string {
  return secret.includes("://") ? secret : `otpauth://totp/${encodeURIComponent(name)}?secret=${encodeURIComponent(secret.replace(/\s+/g, ""))}`;
}

/** Every character on its own tile with its position, so look-alikes (O/0, l/1) can be told apart. */
function largeTypeView(ctx: Ctx): HTMLElement {
  const text = st.large!;
  return h(
    "div",
    { class: "page" },
    topBar(iconButton("back", t("back"), () => ((st.large = undefined), ctx.rerender())), h("h1", { class: "grow" }, t("largeType"))),
    h(
      "div",
      { class: "large mono", role: "img", "aria-label": text },
      ...[...text].map((c, i) => h("span", { class: `ch${/\d/.test(c) ? " d" : /[^\p{L}\s]/u.test(c) ? " s" : ""}` }, c === " " ? "␣" : c, h("small", {}, String(i + 1)))),
    ),
  );
}

const RING_CIRCUMFERENCE = 2 * Math.PI * 9;

/** A countdown ring for the one-time code. */
function ring(fraction: number): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "ring");
  svg.setAttribute("aria-hidden", "true");
  const track = document.createElementNS(NS, "circle");
  track.setAttribute("cx", "12");
  track.setAttribute("cy", "12");
  track.setAttribute("r", "9");
  track.setAttribute("class", "ring-track");
  const bar = document.createElementNS(NS, "circle");
  bar.setAttribute("cx", "12");
  bar.setAttribute("cy", "12");
  bar.setAttribute("r", "9");
  bar.setAttribute("class", "ring-bar");
  bar.setAttribute("transform", "rotate(-90 12 12)");
  bar.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  bar.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - fraction));
  svg.append(track, bar);
  return svg;
}

function totpRow(ctx: Ctx, id: string, secret: string, name: string): HTMLElement {
  if (st.totpFailed === id)
    return h("div", { class: "row" }, icon("timer"), h("div", { class: "body" }, h("span", { class: "label" }, t("oneTimeCode")), h("span", { class: "value" }, t("totpInvalid"))));
  if (!st.totp) {
    void refreshTotp(ctx, id);
    return h("div", { class: "row" }, icon("timer"), h("div", { class: "body" }, h("span", { class: "label" }, t("oneTimeCode")), h("span", { class: "value" }, "…")));
  }
  const { code, next, remaining, period } = st.totp;
  const pretty = (c: string) => (c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : c);
  return h(
    "div",
    { class: `row field-row totp-row elevated${remaining <= TOTP_SOON ? " soon" : ""}` },
    icon("timer"),
    h(
      "div",
      copyOnClick(ctx, "totp", () => st.totp?.code ?? code, t("oneTimeCode")),
      h("span", { class: "label" }, t("oneTimeCode")),
      h("span", { class: "value mono totp", "data-totp": "1" }, pretty(code)),
      next ? h("span", { class: "totp-next" }, t("nextCode"), " ", h("span", { class: "mono" }, pretty(next))) : null,
    ),
    h(
      "span",
      { class: "field-actions" },
      h(
        "span",
        { class: "totp-ring", "data-remaining": String(remaining), role: "img", "aria-label": plural("secondsLeft", remaining) },
        ring(remaining / Math.max(period, 1)),
        h("span", { class: "totp-seconds", "aria-hidden": "true" }, String(remaining)),
      ),
      copyButton(ctx, "totp", code, t("copyField", t("oneTimeCode"))),
      moreButton(ctx, code, [
        ...(next ? [{ label: t("copyNextCode"), icon: "copy" as const, onClick: () => void copy(ctx, next) }] : []),
        { label: t("copyAuthKey"), icon: "copy", onClick: () => void copy(ctx, secret) },
        { label: t("showAuthQr"), icon: "qr", onClick: () => ((st.qr = { text: otpauthUri(secret, name), note: t("authQrNote") }), ctx.rerender()) },
      ]),
    ),
  );
}

/** The re-prompt grant ran out: hide the item again until the password is re-entered. */
function hideForReprompt(ctx: Ctx, id: string) {
  clearInterval(totpTimer);
  stopRepromptWatch();
  // The large-type and QR overlays may show this item's password or TOTP key.
  Object.assign(st, { item: undefined, totp: undefined, large: undefined, qr: undefined, reveal: new Set(), copied: "", repromptFor: id });
  ctx.rerender();
}

async function refreshTotp(ctx: Ctx, id: string) {
  const r = await send<{ code: string; next: string; period: number; remaining: number }>({ type: "totp", id });
  if (st.route.kind !== "item" || st.route.id !== id) return;
  if (!r.ok) {
    if (r.code === "reprompt") return hideForReprompt(ctx, id);
    st.totpFailed = id;
    return ctx.rerender();
  }
  st.totp = { code: r.data.code, next: r.data.next, period: r.data.period || 30, remaining: r.data.remaining };
  ctx.rerender();
  clearInterval(totpTimer);
  totpTimer = setInterval(() => {
    if (!st.totp) return;
    st.totp.remaining -= 1;
    if (st.totp.remaining <= 0) {
      clearInterval(totpTimer);
      void refreshTotp(ctx, id);
      return;
    }
    // Tick the ring and the counter without re-rendering the whole screen.
    const pill = document.querySelector<HTMLElement>("[data-remaining]");
    if (!pill) return;
    pill.setAttribute("aria-label", plural("secondsLeft", st.totp.remaining));
    pill.setAttribute("data-remaining", String(st.totp.remaining));
    pill.closest(".totp-row")?.classList.toggle("soon", st.totp.remaining <= TOTP_SOON);
    const seconds = pill.querySelector<HTMLElement>(".totp-seconds");
    if (seconds) seconds.textContent = String(st.totp.remaining);
    const bar = pill.querySelector<SVGCircleElement>(".ring-bar");
    if (bar) bar.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - st.totp.remaining / st.totp.period));
  }, 1000);
}

export const actionRow = (ic: IconName, title: string, onclick: () => void, danger = false) =>
  h("button", { type: "button", class: `row${danger ? " danger" : ""}`, disabled: st.busy, onclick }, icon(ic), h("div", { class: "body" }, h("span", { class: "title" }, title)));

async function vaultAction(ctx: Ctx, req: Parameters<typeof send>[0], done: string, back = true, undo?: () => void) {
  st.busy = true;
  ctx.rerender();
  const r = await send<VaultList>(req);
  st.busy = false;
  st.confirmDelete = 0;
  if (!r.ok) return ((st.error = r.error), ctx.rerender());
  st.list = r.data;
  st.item = undefined;
  await refreshPageMatches(); // e.g. a restored login of this site is back under "On this site"
  if (back) open(ctx, { kind: "list" });
  else {
    // Refetch before rendering, so the item page shows the saved item instead of flashing its loading bar.
    const route = st.route;
    if (route.kind === "item") {
      const fresh = await send<Json>({ type: "getItem", id: route.id });
      if (fresh.ok) st.item = fresh.data;
    }
    ctx.rerender();
  }
  toast(ctx, t(done), undo ? { action: { label: t("undo"), run: undo } } : {});
}

/** Arm a destructive action on the first tap, run it on the second; disarms itself after a while. */
function twoTap(ctx: Ctx, run: () => void, key = "item") {
  if (!st.confirmDelete || st.armed !== key) {
    const at = Date.now();
    st.confirmDelete = at;
    st.armed = key;
    ctx.rerender();
    setTimeout(() => {
      if (st.confirmDelete !== at) return; // disarmed, or armed again since
      st.confirmDelete = 0;
      if (st.route.kind === "item" || st.route.kind === "folders") ctx.rerender();
    }, 4000);
    return;
  }
  st.confirmDelete = 0;
  run();
}

// Same cap as Send files (MAX_SEND_FILE_BYTES in background/vault.ts).
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

async function download(ctx: Ctx, cipherId: string, attachmentId: string) {
  const r = await send<{ fileName: string; data: string }>({ type: "downloadAttachment", cipherId, attachmentId });
  if (!r.ok) return ((st.error = r.error), ctx.rerender());
  const url = URL.createObjectURL(new Blob([Uint8Array.fromBase64(r.data.data)]));
  h("a", { href: url, download: safeFileName(r.data.fileName) }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The name comes from the server: keep it a plain file name (no separators, no control characters). */
function safeFileName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_").trim().slice(0, 100);
  return clean || "attachment";
}

async function upload(ctx: Ctx, cipherId: string, file: File | undefined) {
  if (!file) return;
  if (file.size > MAX_ATTACHMENT_BYTES) return ((st.error = t("fileTooLarge")), ctx.rerender());
  const data = new Uint8Array(await file.arrayBuffer()).toBase64();
  await vaultAction(ctx, { type: "addAttachment", cipherId, file: { name: file.name, data } }, "saved", false);
}

/** Fill / open actions for the item, when a web page is open (a login for another site asks first) or the item has a site. */
function quickActions(ctx: Ctx, id: string, uris: string[], login: boolean): Child {
  const onSite = login && !!st.page?.host;
  const url = uris.map(webUrl).find(Boolean);
  if (!onSite && !url) return null;
  return h(
    "div",
    { class: "quick" },
    onSite ? h("button", { type: "button", class: "btn tonal", onclick: () => void fill(ctx, id) }, icon("fill"), t("fillThisSite")) : null,
    url
      ? h(
          "a",
          {
            class: "btn text",
            href: url,
            target: "_blank",
            rel: "noopener noreferrer",
            onclick: (e: Event) => {
              e.preventDefault();
              void chrome.tabs.create({ url });
            },
          },
          icon("external"),
          t("openWebsite"),
        )
      : null,
  );
}

async function checkBreach(ctx: Ctx, id: string, password: string) {
  st.pwned = { text: t("checking"), bad: false };
  ctx.rerender();
  let result: { text: string; bad: boolean };
  try {
    const n = await pwnedCount(password);
    result = n > 0 ? { text: t("pwnedFound", n.toLocaleString()), bad: true } : { text: t("pwnedClean"), bad: false };
  } catch {
    result = { text: t("pwnedFailed"), bad: false };
  }
  if (st.route.kind !== "item" || st.route.id !== id) return; // the user moved on
  st.pwned = result;
  ctx.rerender();
}

/** "Type it from memory": compared here, against the password the open item already holds. */
function memoryForm(ctx: Ctx, password: string): HTMLElement {
  const input = h("input", { type: "password", autocomplete: "off", spellcheck: false, "aria-label": t("memoryTest"), "data-autofocus": "1" });
  const verdict = st.memory?.ok;
  return h(
    "form",
    {
      class: "field-card add",
      onsubmit: (e: Event) => {
        e.preventDefault();
        const ok = input.value === password;
        input.value = "";
        st.memory = { ok };
        ctx.rerender();
      },
    },
    h("p", { class: "caption" }, t("memoryHint")),
    h("div", { class: "field-card-bottom" }, input, h("button", { type: "submit", class: "btn tonal small" }, t("check"))),
    verdict === undefined ? null : h("div", { class: `notice ${verdict ? "info" : "warn"}` }, icon(verdict ? "check" : "error"), h("div", {}, t(verdict ? "memoryMatch" : "memoryMismatch"))),
  );
}

/** One row for a card's expiry: copies MMYY (what payment forms want), flags an expired or soon-to-expire card. */
function expiryRow(ctx: Ctx, month: string, year: string): HTMLElement | undefined {
  const m = Number(month);
  const y = Number(year);
  if (!(m >= 1 && m <= 12) || !Number.isInteger(y) || y < 0) return undefined;
  const y4 = y < 100 ? 2000 + y : y;
  const mm = String(m).padStart(2, "0");
  const left = new Date(y4, m, 1).getTime() - Date.now(); // a card works through the end of its month
  const status = left <= 0 ? "expired" : left < 60 * 86_400_000 ? "expiringSoon" : "";
  return fieldRow(ctx, "expiry", "calendar", t("expiry"), `${mm}/${y4}`, {
    copyValue: `${mm}${String(y4).slice(-2)}`,
    menu: [
      { label: t("copyMonth"), icon: "copy", onClick: () => void copy(ctx, mm) },
      { label: t("copyYear"), icon: "copy", onClick: () => void copy(ctx, String(y4)) },
    ],
    extra: status ? h("span", { class: `badge ${status === "expired" ? "s0" : "s1"}` }, t(status)) : null,
  });
}

/** Mail, call, text and show-on-map shortcuts for an identity. Maps go to OpenStreetMap, not an ad network. */
function identityActions(data: Json): Child {
  const email = str(data.email).trim();
  const phone = str(data.phone).replace(/[^\d+*#]/g, "");
  const address = ["address1", "address2", "address3", "city", "state", "postalCode", "country"].map((k) => str(data[k]).trim()).filter(Boolean).join(", ");
  const link = (ic: IconName, label: string, href: string) => h("a", { class: "row", href, target: "_blank", rel: "noopener noreferrer", onclick: (e: Event) => (e.preventDefault(), void chrome.tabs.create({ url: href })) }, icon(ic), h("div", { class: "body" }, h("span", { class: "title" }, label)), icon("external"));
  const rows = [
    email ? link("mail", t("sendEmail"), `mailto:${encodeURIComponent(email)}`) : null,
    phone ? link("phone", t("callPhone"), `tel:${phone}`) : null,
    phone ? link("phone", t("textPhone"), `sms:${phone}`) : null,
    address ? link("home", t("showOnMap"), `https://www.openstreetmap.org/search?query=${encodeURIComponent(address)}`) : null,
  ].filter(Boolean);
  return rows.length ? h("div", { class: "group" }, ...rows) : null;
}

/** A website row: open, copy, and a menu with the main page and the https upgrade. */
function uriRow(ctx: Ctx, index: number, uri: string, match: number | null, onHttps: ((to: string) => void) | undefined): HTMLElement {
  const href = webUrl(uri);
  const insecure = isInsecureUri(uri);
  const front = mainPage(uri);
  const https = onHttps ? toHttps(uri) : undefined;
  const items: MenuItem[] = [];
  if (front) items.push({ label: t("openMainPage"), icon: "home", onClick: () => void chrome.tabs.create({ url: front }) });
  if (https) items.push({ label: t("switchToHttps"), icon: "shield", onClick: () => onHttps!(https) });
  // The site's own "change your password" page (W3C well-known URL); sites without one usually redirect home.
  if (href) items.push({ label: t("changePasswordPage"), icon: "key", onClick: () => void chrome.tabs.create({ url: new URL("/.well-known/change-password", href).href }) });
  const sub = [insecure ? t("insecureUri") : "", match !== null ? uriMatchLabel(match) : ""].filter(Boolean).join(", ");
  return h(
    "div",
    { class: "row" },
    icon(insecure ? "error" : "globe"),
    h("div", copyOnClick(ctx, `uri.${index}`, () => uri, uri), h("span", { class: "title ellipsis" }, uri), sub ? h("span", { class: `sub${insecure ? " warn" : ""}` }, sub) : null),
    h("span", { class: "field-actions" }, href ? iconButton("external", t("openWebsite"), () => void chrome.tabs.create({ url: href })) : null, copyButton(ctx, `uri.${index}`, uri, t("copyField", uri)), moreButton(ctx, uri, items)),
  );
}

const NOTES_KEY = "formatNotes";
const notesFormatted = (): boolean => {
  try {
    return localStorage.getItem(NOTES_KEY) === "1";
  } catch {
    return false;
  }
};

function itemView(ctx: Ctx, id: string): HTMLElement {
  const item = st.item && st.item.id === id ? st.item : undefined;
  if (!item) {
    // The worker refuses to hand over a flagged item until the master password is re-entered.
    if (st.repromptFor === id) return repromptView(ctx, id);
    if (!st.itemLoading && st.itemFailedFor !== id) {
      st.itemLoading = true;
      void send<Json>({ type: "getItem", id }).then((r) => {
        st.itemLoading = false;
        if (r.ok) st.item = r.data;
        else if (r.code === "reprompt") st.repromptFor = id;
        else {
          st.error = r.error;
          st.itemFailedFor = id; // a failed fetch is shown, not retried in a loop
        }
        ctx.rerender();
      });
    }
    return h(
      "div",
      { class: "page" },
      topBar(iconButton("back", t("back"), () => open(ctx, { kind: "list" }))),
      errorBox(),
      st.error ? null : progress(),
    );
  }
  if (Number(item.reprompt) === 1 && !repromptTimer)
    repromptTimer = setInterval(async () => {
      const r = await send<boolean>({ type: "repromptGranted", id });
      if (r.ok && !r.data && st.route.kind === "item" && st.route.id === id) hideForReprompt(ctx, id);
    }, REPROMPT_CHECK_MS);
  const inTrash = !!item.deletedDate;
  const inArchive = !inTrash && !!item.archivedDate;
  const summary = [...(st.list?.items ?? []), ...(st.list?.archive ?? []), ...(st.list?.trash ?? [])].find((i) => i.id === id);
  const type = Number(item.type);
  const editable = !summary?.readOnly && !inTrash && type >= 1 && type <= 8;
  const schema = SCHEMA[type];
  const data = schema ? (obj(item[schema.obj]) ?? {}) : {};
  const rows: Child[] = [];
  const expiry = type === 3 ? expiryRow(ctx, str(data.expMonth), str(data.expYear)) : undefined;
  // Like the official clients: the passkey sits after the password as "Created <date>"; creationDate is not encrypted.
  const passkey = type === 1 && Array.isArray(data.fido2Credentials) ? obj(data.fido2Credentials[0]) : undefined;
  for (const f of schema?.fields ?? []) {
    const v = str(data[f.key]);
    if (passkey && f.key === "totp")
      rows.push(
        h("div", { class: "row field-row" }, icon("fingerprint"), h("div", { class: "body" }, h("span", { class: "label" }, t("passkey")), h("span", { class: "value" }, t("passkeyCreated", passkey.creationDate ? when(str(passkey.creationDate)) : "")))),
      );
    if (!v) continue;
    if (expiry && (f.key === "expMonth" || f.key === "expYear")) {
      if (f.key === "expMonth") rows.push(expiry);
      continue;
    }
    if (type === 1 && f.key === "totp") {
      rows.push(totpRow(ctx, id, v, str(item.name)));
      continue;
    }
    const s = type === 1 && f.key === "password" ? strength(v) : undefined;
    rows.push(fieldRow(ctx, f.key, f.icon, label(f.key), v, { secret: f.secret, mono: f.mono, display: type === 3 && f.key === "number" ? groupCardNumber(v) : undefined, extra: s ? h("span", { class: `badge s${s.level}` }, s.label) : null }));
  }
  const login = type === 1 ? data : undefined;
  const uriEntries = (Array.isArray(login?.uris) ? (login!.uris as Json[]) : [])
    .map((u) => ({ uri: str(u.uri), match: typeof u.match === "number" ? (u.match as number) : null }))
    .filter((u) => u.uri);
  const uris = uriEntries.map((u) => u.uri);
  const fields = Array.isArray(item.fields) ? (item.fields as Json[]) : [];
  const history = Array.isArray(item.passwordHistory) ? (item.passwordHistory as Json[]) : [];
  const folder = st.list?.folders.find((f) => f.id === item.folderId);
  const attachments = Array.isArray(item.attachments) ? (item.attachments as Json[]) : [];
  const org = st.list?.organizations?.find((o) => o.id === item.organizationId);
  const collections = (Array.isArray(item.collectionIds) ? (item.collectionIds as string[]) : []).map((c) => st.list?.collections?.find((x) => x.id === c)?.name).filter(Boolean);
  const date = (v: unknown) => (typeof v === "string" && v ? when(v) : "");
  const confirm = st.confirmDelete > 0 && st.armed === "item";
  const password = type === 1 ? str(data.password) : "";
  const reused = summary?.reused ?? 0;
  const formatted = notesFormatted();
  const notes = str(item.notes);
  const fixUri = (from: string, to: string) =>
    void vaultAction(ctx, { type: "saveItem", item: { ...item, login: { ...login, uris: (Array.isArray(login?.uris) ? (login!.uris as Json[]) : []).map((x) => (str(x.uri) === from ? { ...x, uri: to } : x)) } } }, "saved", false);

  return h(
    "div",
    {
      class: "page item-page",
      // A dropped file must never navigate the popup away; on an editable personal item it becomes an attachment.
      ondragover: (e: DragEvent) => e.preventDefault(),
      ondrop: (e: DragEvent) => {
        e.preventDefault();
        if (editable) void upload(ctx, id, e.dataTransfer?.files[0]);
      },
    },
    topBar(
      iconButton("back", t("back"), () => open(ctx, { kind: "list" })),
      spacer(),
      editable
        ? iconButton(item.favorite ? "star" : "starBorder", t(item.favorite ? "unfavorite" : "favorite"), () => void vaultAction(ctx, { type: "saveItem", item: { ...item, favorite: !item.favorite } }, "saved", false), {
            class: `icon-btn${item.favorite ? " fav" : ""}`,
            "aria-pressed": String(item.favorite === true),
          })
        : null,
      editable ? iconButton("edit", t("edit"), () => startEdit(ctx, item)) : null,
    ),
    h(
      "div",
      { class: "hero" },
      tile(str(item.name), type, uris, type === 3 ? str(data.brand) || cardBrand(str(data.number)) || "" : ""),
      h("div", { class: "body" }, h("h1", {}, str(item.name) || t("untitled")), h("span", { class: "sub" }, t(TYPE_LABEL[type] ?? "untitled"))),
    ),
    quickActions(ctx, id, uris, type === 1 && !inTrash),
    errorBox(),
    inTrash ? h("div", { class: "notice warn" }, icon("trash"), h("div", {}, t("inTrash"))) : inArchive ? h("div", { class: "notice" }, icon("archive"), h("div", {}, t("inArchive"))) : summary?.readOnly ? h("div", { class: "notice" }, icon("lock"), h("div", {}, t("readOnlyItem"))) : null,
    rows.length ? h("div", { class: "group" }, ...rows) : null,
    type === 4 ? identityActions(data) : null,
    reused
      ? h(
          "div",
          { class: "notice warn" },
          icon("error"),
          h("div", {}, plural("reusedNotice", reused)),
          h("button", { type: "button", class: "btn text small", onclick: () => ((st.folder = "reused"), open(ctx, { kind: "list" })) }, t("showReused")),
        )
      : null,
    login?.passwordRevisionDate ? h("p", { class: "caption" }, t("passwordChanged", date(login.passwordRevisionDate))) : null,
    ...section(
      t("websites"),
      ...uriEntries.map(({ uri: u, match }, i) => uriRow(ctx, i, u, match, editable ? (to) => fixUri(u, to) : undefined)),
    ),
    // Password tools come after what the user opened the item for: the credentials and where they go.
    password
      ? h("div", { class: "group" }, actionRow("shield", t("checkBreaches"), () => void checkBreach(ctx, id, password)), actionRow("memory", t("memoryTest"), () => ((st.memory = st.memory ? undefined : {}), ctx.rerender())))
      : null,
    st.pwned ? h("div", { class: `notice ${st.pwned.bad ? "warn" : "info"}` }, icon(st.pwned.bad ? "error" : "info"), h("div", {}, st.pwned.text)) : null,
    st.memory && password ? memoryForm(ctx, password) : null,
    ...section(
      t("customFields"),
      ...fields.map((f, i) =>
        Number(f.type) === 3
          ? h(
              "div",
              { class: "row" },
              icon("note"),
              // Which field it stands for, not its value: that is already on this screen, with its own protection.
              h("div", { class: "body" }, h("span", { class: "label" }, str(f.name) || t("untitled")), h("span", { class: "value" }, linkedKey(type, f.linkedId) ? `${t("fieldLinked")}: ${label(linkedKey(type, f.linkedId)!)}` : t("fieldLinked"))),
            )
          : Number(f.type) === 2
            ? h(
                editable ? "button" : "div",
                {
                  class: "row",
                  ...(editable ? { type: "button", disabled: st.busy, onclick: () => void vaultAction(ctx, { type: "saveItem", item: { ...item, fields: fields.map((x, j) => (j === i ? { ...x, value: str(x.value) === "true" ? "false" : "true" } : x)) } }, "saved", false) } : {}),
                },
                icon("note"),
                h("div", { class: "body" }, h("span", { class: "label" }, str(f.name)), h("span", { class: "value" }, t(str(f.value) === "true" ? "yes" : "no"))),
              )
            : fieldRow(ctx, `field.${i}`, "note", str(f.name) || t("untitled"), str(f.value), { secret: Number(f.type) === 1 }),
      ),
    ),
    ...(notes
      ? [
          h(
            "div",
            { class: "section-head" },
            sectionTitle(t("notes")),
            hasMarkup(notes)
              ? h("button", { type: "button", class: "chip small", "aria-pressed": String(formatted), onclick: () => (localStorage.setItem(NOTES_KEY, formatted ? "0" : "1"), ctx.rerender()) }, t("formatNotes"))
              : null,
          ),
          formatted ? renderMarkdown(notes) : h("div", { class: "notes" }, notes),
        ]
      : []),
    ...section(
      t("passwordHistory"),
      ...(st.reveal.has("history")
        ? history.map((p, i) => fieldRow(ctx, `history.${i}`, "key", date(p.lastUsedDate), str(p.password), { secret: true, mono: true }))
        : history.length
          ? [actionRow("history", plural("showPasswordHistory", history.length), () => (st.reveal.add("history"), ctx.rerender()))]
          : []),
    ),
    ...section(
      t("attachments"),
      ...attachments.map((a) =>
        h(
          "div",
          { class: "row" },
          icon("attach"),
          h("div", { class: "body" }, h("span", { class: "title ellipsis" }, str(a.fileName) || t("untitled")), h("span", { class: "sub" }, str(a.sizeName))),
          iconButton("download", t("downloadNamed", str(a.fileName)), () => void download(ctx, id, str(a.id))),
          editable && !inTrash
            ? iconButton(
                "trash",
                st.confirmDelete && st.armed === str(a.id) ? t("tapAgainToDelete") : t("deleteNamed", str(a.fileName)),
                () => twoTap(ctx, () => void vaultAction(ctx, { type: "deleteAttachment", cipherId: id, attachmentId: str(a.id) }, "deleted", false), str(a.id)),
                st.confirmDelete && st.armed === str(a.id) ? { class: "icon-btn danger" } : {},
              )
            : null,
        ),
      ),
      editable && !inTrash
        ? h(
            "label",
            { class: "row" },
            icon("plus"),
            h("div", { class: "body" }, h("span", { class: "title" }, t("addAttachment"))),
            h("input", { type: "file", class: "sr-only", "aria-label": t("addAttachment"), onchange: (e: Event) => void upload(ctx, id, (e.target as HTMLInputElement).files?.[0]) }),
          )
        : null,
    ),
    ...section(
      t("details"),
      org ? h("div", { class: "row" }, icon("shield"), h("div", { class: "body" }, h("span", { class: "label" }, t("organization")), h("span", { class: "value" }, org.name))) : null,
      collections.length ? h("div", { class: "row" }, icon("folder"), h("div", { class: "body" }, h("span", { class: "label" }, t("collections")), h("span", { class: "value" }, collections.join(", ")))) : null,
      folder ? h("div", { class: "row" }, icon("folder"), h("div", { class: "body" }, h("span", { class: "label" }, t("folder")), h("span", { class: "value" }, folder.name))) : null,
      item.revisionDate ? h("div", { class: "row" }, icon("edit"), h("div", { class: "body" }, h("span", { class: "label" }, t("lastEdited")), h("span", { class: "value" }, date(item.revisionDate)))) : null,
    ),
    h(
      "div",
      { class: "group" },
      !inTrash && editable && !item.organizationId && writableOrgs().length ? actionRow("shield", t("moveToOrg"), () => open(ctx, { kind: "org", id })) : null,
      !inTrash && editable && item.organizationId && writableCollections(str(item.organizationId)).length ? actionRow("folder", t("editCollections"), () => open(ctx, { kind: "org", id })) : null,
      !inTrash && !summary?.readOnly && type >= 1 && type <= 8
        ? inArchive
          ? actionRow("archive", t("unarchive"), () => void vaultAction(ctx, { type: "unarchiveItem", id }, "unarchived"))
          : actionRow("archive", t("archive"), () => void vaultAction(ctx, { type: "archiveItem", id }, "archived", true, () => void vaultAction(ctx, { type: "unarchiveItem", id }, "unarchived", false)))
        : null,
      inTrash
        ? actionRow("refresh", t("restore"), () => void vaultAction(ctx, { type: "restoreItem", id }, "restored"))
        : editable
          ? actionRow("copy", t("clone"), () => startEdit(ctx, { ...structuredClone(item), id: undefined, attachments: null, name: `${str(item.name)} ${t("copySuffix")}`, passwordHistory: null }, {}, true))
          : null,
      inTrash
        ? actionRow("trash", t(confirm ? "confirmPurge" : "deleteForever"), () => twoTap(ctx, () => void vaultAction(ctx, { type: "purgeItem", id }, "deleted")), true)
        : editable
          ? // One click: the notice's Undo is the safety net (a second click on top of it was only friction).
            actionRow("trash", t("moveToTrash"), () => void vaultAction(ctx, { type: "deleteItem", id }, "movedToTrash", true, () => void vaultAction(ctx, { type: "restoreItem", id }, "restored", false)), true)
          : null,
    ),
  );
}

// ---------- editor (Login, Secure note, Card, Identity) ----------

interface Prefill {
  name?: string;
  uris?: { uri: string; match: number | null }[];
  data?: Record<string, string>;
}

const sitePrefill = (origin: string | undefined): Prefill => (origin ? { name: new URL(origin).hostname, uris: [{ uri: origin, match: null }] } : {});

/** A new item starts on the site of the active tab, read now: a side panel outlives tab switches. */
async function newItem(ctx: Ctx) {
  await refreshPageMatches();
  startEdit(ctx, undefined, sitePrefill(st.page?.origin));
}

/** Back to the editor after "Pick from page", with the picked field added. */
async function returnFromPicker(ctx: Ctx) {
  const r = await send<{ draft: string; field?: { name: string; fieldType: string; label?: string; autofillType?: string } } | null>({ type: "takeFieldPick" });
  if (!r.ok || !r.data) return;
  const { draft, isNew } = JSON.parse(r.data.draft) as { draft: EditDraft; isNew: boolean };
  const f = r.data.field;
  if (f) {
    const toggle = f.fieldType === "checkbox" || f.fieldType === "radio";
    const linkedId = toggle ? undefined : linkedIdFor(draft.type, f.autofillType);
    const type = toggle ? 2 : linkedId !== undefined ? 3 : f.fieldType === "password" ? 1 : 0;
    draft.fields.push({ name: f.name, value: toggle ? "true" : "", type, linkedId, pageLabel: f.label });
  }
  st.draft = draft;
  open(ctx, { kind: "edit", isNew });
  if (!f) return;
  // The editor opens on its Name box, at the top: take the user to the row they just added, ready for its value.
  ctx.afterRender(() => {
    const row = [...document.querySelectorAll(".field-card")].at(-1);
    row?.querySelector<HTMLElement>(".field-card-bottom input, .field-card-bottom select")?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "center" });
  });
}

async function pickFromPage(ctx: Ctx, isNew: boolean) {
  const r = await send({ type: "startFieldPicker", draft: JSON.stringify({ draft: st.draft, isNew }), panel: inPanel });
  if (!r.ok) {
    st.error = r.error;
    return ctx.rerender();
  }
  // The side panel stays open and hears back; a popup would close at the first click on the page anyway.
  if (!inPanel) return window.close();
  const listener = (msg: { type?: string }) => {
    if (msg.type !== "pickerDone") return;
    chrome.runtime.onMessage.removeListener(listener);
    void returnFromPicker(ctx);
  };
  chrome.runtime.onMessage.addListener(listener);
}

export function startEdit(ctx: Ctx, item: Json | undefined, prefill: Prefill = {}, asNew = !item) {
  const base: Json = item ? structuredClone(item) : { type: 1, favorite: false, reprompt: 0, folderId: null, organizationId: null };
  const type = Number(base.type) || 1;
  const schema = SCHEMA[type];
  const data = Object.fromEntries((schema?.fields ?? []).map((f) => [f.key, str(obj(base[schema!.obj])?.[f.key])]));
  const login = obj(base.login);
  st.draft = {
    base,
    type,
    name: prefill.name ?? str(base.name),
    notes: str(base.notes),
    folderId: str(base.folderId),
    favorite: base.favorite === true,
    reprompt: Number(base.reprompt) === 1,
    collectionIds: Array.isArray(base.collectionIds) ? (base.collectionIds as string[]).filter((c) => writableCollections(str(base.organizationId)).some((x) => x.id === c)) : [],
    data: { ...data, ...prefill.data },
    uris:
      prefill.uris ??
      (Array.isArray(login?.uris) ? (login!.uris as Json[]) : [])
        .map((u) => ({ uri: str(u.uri), match: typeof u.match === "number" ? u.match : null }))
        .filter((u) => u.uri),
    autofillOnPageLoad: typeof login?.autofillOnPageLoad === "boolean" ? (login.autofillOnPageLoad as boolean) : null,
    fields: (Array.isArray(base.fields) ? (base.fields as Json[]) : []).map((f) => ({ name: str(f.name), value: str(f.value), type: Number(f.type) || 0, linkedId: f.linkedId })),
  };
  open(ctx, { kind: "edit", isNew: asNew });
}

function buildItem(d: EditDraft): Json {
  const orNull = (s: string) => (s.trim() ? s : null);
  const item: Json = { ...d.base, type: d.type, name: d.name.trim(), notes: orNull(d.notes), folderId: d.folderId || null, favorite: d.favorite, reprompt: d.reprompt ? 1 : 0 };
  const schema = SCHEMA[d.type];
  for (const k of ["login", "secureNote", "card", "identity", "sshKey", "bankAccount", "driversLicense", "passport"]) if (k !== schema?.obj) delete item[k];
  if (schema) {
    const typed: Json = { ...obj(d.base[schema.obj]) };
    for (const f of schema.fields) typed[f.key] = orNull(d.data[f.key] ?? "");
    if (d.type === 1) {
      typed.uris = d.uris.map((u) => ({ uri: u.uri.trim(), match: u.match })).filter((u) => u.uri);
      typed.autofillOnPageLoad = d.autofillOnPageLoad;
    }
    item[schema.obj] = typed;
  } else item.secureNote = obj(d.base.secureNote) ?? { type: 0 };
  item.fields = d.fields
    // A new item's type may have changed under a linked field: it is gone with what it pointed at.
    .filter((f) => (f.type === 3 ? linkedKey(d.type, f.linkedId) : f.name.trim() || f.value))
    .map((f) =>
      f.type === 3
        ? { name: f.name, value: null, type: 3, linkedId: f.linkedId ?? null }
        : { name: f.name, value: f.type === 2 ? String(f.value === "true") : f.value || null, type: f.type, linkedId: null },
    );
  return item;
}

/** Live strength readout under the password field; updated in place so the caret stays put. */
function strengthMeter(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const fill = h("i");
  const bar = h("div", { class: "meter", "aria-hidden": "true" }, fill);
  const text = h("span", { class: "meter-label" });
  const sync = (v: string) => {
    const s = strength(v);
    bar.dataset.level = String(s.level);
    text.textContent = v ? s.label : "";
    bar.hidden = !v;
  };
  sync(value);
  input.addEventListener("input", () => sync(input.value));
  return h("div", { class: "meter-wrap" }, bar, text);
}

/** The generator's strength bar, drawn once for the current value. */
export function strengthBar(value: string): HTMLElement {
  return h("div", { class: "meter", "data-level": String(strength(value).level), "aria-hidden": "true" }, h("i"));
}

/** Labels for Bitwarden's UriMatchStrategy, as the clients name them. */
export function uriMatchLabel(match: number): string {
  const key =
    match === URI_MATCH.Host ? "uriMatchHost"
    : match === URI_MATCH.StartsWith ? "uriMatchStartsWith"
    : match === URI_MATCH.Exact ? "uriMatchExact"
    : match === URI_MATCH.RegularExpression ? "uriMatchRegex"
    : match === URI_MATCH.Never ? "uriMatchNever"
    : "uriMatchBaseDomainShort";
  return t(key);
}

/** The default's name, for the "Default (…)" option. */
function defaultUriMatchLabel(): string {
  return uriMatchLabel(settingsOf()?.defaultUriMatch ?? URI_MATCH.Domain);
}

const settingsOf = (): Settings | undefined => currentCtx?.settings();
let currentCtx: Ctx | undefined;

/** The editor's website rows: URI + match detection, with Add / Remove. */
function uriEditor(ctx: Ctx): Child[] {
  const d = st.draft!;
  const rows = d.uris.map((u, i) => {
    const open = st.uriOpen.has(i);
    const select = withChevron(
      h(
        "select",
        {
          "aria-label": t("matchDetection"),
          onchange: (e: Event) => {
            const v = (e.target as HTMLSelectElement).value;
            u.match = v === "" ? null : Number(v);
            ctx.rerender();
          },
        },
        h("option", { value: "", selected: u.match === null }, t("defaultLabelWithValue", defaultUriMatchLabel())),
        h("option", { value: String(URI_MATCH.Domain), selected: u.match === URI_MATCH.Domain }, t("uriMatchBaseDomainShort")),
        h("option", { value: String(URI_MATCH.Host), selected: u.match === URI_MATCH.Host }, t("uriMatchHost")),
        h("option", { value: String(URI_MATCH.Exact), selected: u.match === URI_MATCH.Exact }, t("uriMatchExact")),
        h("option", { value: String(URI_MATCH.Never), selected: u.match === URI_MATCH.Never }, t("uriMatchNever")),
        h(
          "optgroup",
          { label: t("uriMatchAdvanced") },
          h("option", { value: String(URI_MATCH.StartsWith), selected: u.match === URI_MATCH.StartsWith }, t("uriMatchStartsWith")),
          h("option", { value: String(URI_MATCH.RegularExpression), selected: u.match === URI_MATCH.RegularExpression }, t("uriMatchRegex")),
        ),
      ),
    );
    return h(
      "div",
      { class: "field-card", "data-row": "uri" },
      h(
        "div",
        { class: "field-card-top" },
        h("input", {
          class: "name",
          value: u.uri,
          placeholder: "https://example.com",
          "aria-label": t("uriLabel", String(i + 1)),
          autocapitalize: "off",
          spellcheck: false,
          oninput: (e: Event) => (u.uri = (e.target as HTMLInputElement).value),
        }),
        iconButton("tune", t("matchDetection"), () => (open ? st.uriOpen.delete(i) : st.uriOpen.add(i), ctx.rerender()), {
          class: `icon-btn sm${open ? " on" : ""}`,
          "aria-pressed": String(open),
        }),
        ...moveButtons(ctx, d.uris, i, () => st.uriOpen.clear()),
        d.uris.length > 1
          ? iconButton("trash", t("removeWebsite"), (e) => leave(rowOf(e, ".field-card"), () => (d.uris.splice(i, 1), st.uriOpen.clear(), ctx.rerender())), { class: "icon-btn sm" })
          : null,
      ),
      open ? h("div", { class: "field-card-bottom" }, select) : null,
      open ? h("p", { class: "caption" }, t("uriMatchHint")) : null,
      open && u.match !== null && URI_MATCH_ADVANCED.includes(u.match)
        ? h("p", { class: "caption warn" }, t(u.match === URI_MATCH.RegularExpression ? "uriMatchRegExHint" : "uriMatchStartsWithHint"))
        : null,
    );
  });
  return [
    sectionTitle(t("websites")),
    ...rows,
    h("button", { type: "button", class: "btn text small add-field", onclick: () => (d.uris.push({ uri: "", match: null }), ctx.rerender(), enter([...document.querySelectorAll("[data-row=uri]")].at(-1))) }, icon("plus"), t("addWebsite")),
  ];
}

/** The usernames used most across the vault's logins (list summaries only: no secrets involved). */
function usernameSuggestions(): string[] {
  const counts = new Map<string, number>();
  for (const i of st.list?.items ?? []) if (i.type === 1 && i.sub) counts.set(i.sub, (counts.get(i.sub) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([u]) => u);
}

type Detector = new (o: { formats: string[] }) => { detect(i: ImageBitmapSource): Promise<{ rawValue: string }[]> };
/** The platform's QR reader (macOS, Android, ChromeOS builds); absent elsewhere, where the button is hidden. */
const barcodeDetector = (): Detector | undefined => (globalThis as { BarcodeDetector?: Detector }).BarcodeDetector;

async function scanQr(file: File): Promise<string | undefined> {
  const Reader = barcodeDetector();
  if (!Reader) return undefined;
  return (await new Reader({ formats: ["qr_code"] }).detect(await createImageBitmap(file)))[0]?.rawValue;
}

/** Swap `list[i]` with its neighbour, for the editor's move up / down buttons. */
function moveItem<T>(list: T[], i: number, by: -1 | 1) {
  const j = i + by;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j]!, list[i]!];
}

const moveButtons = (ctx: Ctx, list: unknown[], i: number, reset?: () => void): Child[] => [
  i > 0 ? iconButton("arrowUp", t("moveUp"), () => (moveItem(list, i, -1), reset?.(), ctx.rerender()), { class: "icon-btn sm up" }) : null,
  i < list.length - 1 ? iconButton("arrowUp", t("moveDown"), () => (moveItem(list, i, 1), reset?.(), ctx.rerender()), { class: "icon-btn sm down" }) : null,
];

function editView(ctx: Ctx, isNew: boolean): HTMLElement {
  const d = st.draft!;
  const exit = () => open(ctx, isNew ? { kind: "list" } : { kind: "item", id: str(d.base.id) });
  // Edits are not dropped on one click: the first says so and offers Discard; a second click within 4 s leaves.
  const back = () => {
    if (JSON.stringify(st.draft) === st.draftAtOpen) return exit();
    if (!(st.confirmDelete && st.armed === "discard")) toast(ctx, t("unsavedChanges"), { action: { label: t("discard"), run: exit } });
    twoTap(ctx, exit, "discard");
  };
  const field = (id: string, title: string, control: HTMLElement, trailing?: Child) => {
    // A select is wrapped for its chevron: the label must point at the select itself.
    (control.querySelector("select") ?? control).id = id;
    return h("div", { class: "field" }, h("label", { for: id }, h("span", {}, title), control), trailing);
  };
  const text = (get: () => string, set: (v: string) => void, props: Record<string, unknown> = {}) => {
    const { area, ...rest } = props;
    return h(area ? "textarea" : "input", { ...rest, value: get(), oninput: (e: Event) => set((e.target as HTMLInputElement).value) });
  };
  const select = (get: () => string, set: (v: string) => void, options: [string, string][], id?: string) =>
    withChevron(h("select", { id, onchange: (e: Event) => set((e.target as HTMLSelectElement).value) }, ...options.map(([v, l]) => h("option", { value: v, selected: v === get() }, l))));

  const specField = (f: Spec) => {
    const get = () => d.data[f.key] ?? "";
    const set = (v: string) => (d.data[f.key] = v);
    const id = `edit-${f.key}`;
    if (f.options) return field(id, label(f.key), select(get, set, [["", "—"], ...f.options.map((o): [string, string] => [o, o])]));
    // Card number: fill in the brand once the number is entered, and warn (never block) on a typo.
    const cardNumber = d.type === 3 && f.key === "number";
    const cardWarn = () => !!get() && !luhnValid(get());
    const shownWarn = cardNumber && cardWarn();
    const onchange = cardNumber
      ? () => {
          const brand = d.data.brand ? undefined : cardBrand(get());
          if (brand) d.data.brand = brand;
          if (brand || cardWarn() !== shownWarn) ctx.rerender();
        }
      : undefined;
    const below: Child[] = [];
    if (shownWarn) below.push(h("p", { class: "caption warn", role: "status" }, t("invalidCardNumber")));
    if (d.type === 1 && f.key === "username" && !get()) {
      const known = usernameSuggestions();
      if (known.length) below.push(chipRow({ role: "group", "aria-label": t("suggestions") }, ...known.map((u) => h("button", { type: "button", class: "chip", onclick: () => ((d.data.username = u), ctx.rerender()) }, u))));
    }
    const wrap = (block: HTMLElement) => (below.length ? h("div", { class: "field-block" }, block, ...below) : block);
    const openGenerator = (field: GeneratorPick["field"]) => {
      startGeneratorPick(field);
      st.picking = field;
      ctx.rerender();
    };
    const generateUsername = d.type === 1 && f.key === "username" ? h("span", { class: "trailing" }, iconButton("generator", t("generateUsername"), () => openGenerator("username"))) : undefined;
    if (!f.secret) return wrap(field(id, label(f.key), text(get, set, { autocomplete: "off", spellcheck: false, area: f.area }), generateUsername));
    const reveal = st.reveal.has(id);
    // A multi-line secret (a private key) stays a textarea, masked by CSS: an input would drop its line breaks.
    const control = f.area
      ? text(get, set, { area: true, autocomplete: "off", spellcheck: false, class: reveal ? "mono" : "mono masked" })
      : text(get, set, { type: reveal ? "text" : "password", autocomplete: "new-password", spellcheck: false, class: "mono", onchange, inputMode: cardNumber ? "numeric" : undefined });
    const block = field(
      id,
      label(f.key),
      control,
      h(
        "span",
        { class: "trailing" },
        iconButton(reveal ? "eyeOff" : "eye", t(reveal ? "hidePassword" : "showPassword"), () => {
          if (reveal) st.reveal.delete(id);
          else st.reveal.add(id);
          ctx.rerender();
        }),
        d.type === 1 && f.key === "password"
          ? iconButton("generator", t("generatePassword"), () => openGenerator("password"))
          : null,
        d.type === 1 && f.key === "totp" && barcodeDetector()
          ? h(
              "label",
              { class: "icon-btn", title: t("scanQrImage") },
              icon("search"),
              h("span", { class: "sr-only" }, t("scanQrImage")),
              h("input", {
                type: "file",
                accept: "image/*",
                class: "sr-only",
                onchange: async (e: Event) => {
                  const file = (e.target as HTMLInputElement).files?.[0];
                  const text = file ? await scanQr(file).catch(() => undefined) : undefined;
                  if (text?.startsWith("otpauth://")) d.data.totp = text;
                  else st.error = t(text ? "qrNotAuthenticator" : "qrNotFound");
                  ctx.rerender();
                },
              }),
            )
          : null,
      ),
    );
    return d.type === 1 && f.key === "password" ? h("div", { class: "field-block" }, block, strengthMeter(control, get())) : wrap(block);
  };

  const onsubmit = async (e: Event) => {
    e.preventDefault();
    if (!d.name.trim()) return ((st.error = t("nameRequired")), ctx.rerender());
    st.busy = true;
    st.error = undefined;
    ctx.rerender();
    const org = isNew ? str(d.base.organizationId) : "";
    if (org && !d.collectionIds.length) return ((st.error = t("pickCollection")), ctx.rerender());
    const r = await send<VaultList>({ type: "saveItem", item: buildItem(d), ...(org ? { collectionIds: d.collectionIds } : {}) });
    st.busy = false;
    if (!r.ok) return ((st.error = r.error), ctx.rerender());
    st.list = r.data;
    st.item = undefined;
    await refreshPageMatches(); // a new login for this site joins "On this site"
    open(ctx, isNew ? { kind: "list" } : { kind: "item", id: str(d.base.id) });
    toast(ctx, t("saved"));
  };
  const typeChip = (type: number, ic: IconName) =>
    h("button", { type: "button", class: "chip", "aria-pressed": String(d.type === type), onclick: () => {
      // The site's name only fits a login: a card or a note started from a site tab starts unnamed.
      if (type !== 1 && d.name === URL.parse(d.uris[0]?.uri ?? "")?.hostname) d.name = "";
      d.type = type;
      ctx.rerender();
    } }, icon(ic), t(TYPE_LABEL[type]!));
  const fav = h("input", { type: "checkbox", checked: d.favorite, "aria-label": t("favorite"), onchange: (e: Event) => (d.favorite = (e.target as HTMLInputElement).checked) });
  const customRow = (f: EditDraft["fields"][number], i: number) => {
    const linkable = LINKED[d.type] ?? [];
    const hint = h("p", { class: "field-card-hint" });
    const syncHint = () => {
      const on = (f.pageLabel || f.name).trim();
      const linked = linkedKey(d.type, f.linkedId);
      hint.textContent = !on
        ? t("fieldHintEmpty")
        : f.type === 3 && linked
          ? t("fieldHintLinked", on, label(linked))
          : f.type === 2
            ? t(f.value === "true" ? "fieldHintChecked" : "fieldHintUnchecked", on)
            : t(f.type === 1 ? "fieldHintHidden" : "fieldHintText", on);
    };
    syncHint();
    const col = (id: string, caption: string, control: Child, grow = true) => h("div", { class: `field-card-col${grow ? " grow" : ""}` }, h("label", { for: id }, caption), control);
    const valueId = `field-value-${i}`;
    const typeId = `field-type-${i}`;
    return h(
      "div",
      { class: "field-card", "data-row": "field" },
      h(
        "div",
        { class: "field-card-top" },
        col(
          `field-name-${i}`,
          t("fieldName"),
          h("input", {
            id: `field-name-${i}`, // a re-render gives focus back by id; without one it jumps to the Name box
            class: "name",
            value: f.name,
            oninput: (e: Event) => {
              f.name = (e.target as HTMLInputElement).value;
              f.pageLabel = undefined; // the user renamed it: the page's label no longer says which field this is
              syncHint();
            },
          }),
        ),
        ...moveButtons(ctx, d.fields, i),
        iconButton("trash", t("removeField"), (e) => leave(rowOf(e, ".field-card"), () => (d.fields.splice(i, 1), ctx.rerender())), { class: "icon-btn sm" }),
      ),
      h(
        "div",
        { class: "field-card-bottom" },
        f.type === 3
          ? col(
              valueId,
              t("fieldLinkedTo"),
              select(
                () => String(f.linkedId ?? ""),
                (v) => {
                  f.linkedId = Number(v);
                  syncHint();
                },
                linkable.map((l): [string, string] => [String(l.id), label(l.key)]),
                valueId,
              ),
            )
          : f.type === 2
            ? col(
                valueId,
                t("fieldChecked"),
                select(
                  () => (f.value === "true" ? "true" : "false"),
                  (v) => {
                    f.value = v;
                    syncHint();
                  },
                  [["false", t("no")], ["true", t("yes")]],
                  valueId,
                ),
              )
            : col(
                valueId,
                t("fieldValue"),
                h("input", {
                  id: valueId,
                  value: f.value,
                  type: f.type === 1 ? "password" : "text",
                  oninput: (e: Event) => (f.value = (e.target as HTMLInputElement).value),
                }),
              ),
        col(
          typeId,
          t("fieldKind"),
          select(
            () => String(f.type),
            (v) => {
              f.type = Number(v);
              if (f.type === 3) f.linkedId = linkable[0]?.id;
              ctx.rerender();
            },
            [["0", t("fieldText")], ["1", t("fieldHidden")], ["2", t("fieldBoolean")], ...(linkable.length ? [["3", t("fieldLinked")] as [string, string]] : [])],
            typeId,
          ),
          false,
        ),
      ),
      hint,
    );
  };

  return h(
    "form",
    { class: "page editor", onsubmit },
    topBar(iconButton("back", t("cancel"), back), h("h1", {}, t(isNew ? "newItem" : "editItem")), spacer()),
    errorBox(),
    isNew ? h("div", { class: "chips", role: "group", "aria-label": t("itemType") }, typeChip(1, "key"), typeChip(3, "card"), typeChip(4, "user"), typeChip(2, "note"), typeChip(5, "server"), typeChip(6, "landmark"), typeChip(7, "card"), typeChip(8, "globe")) : null,
    field("edit-name", t("name"), text(() => d.name, (v) => (d.name = v), { required: true, "data-autofocus": "1" })),
    ...(SCHEMA[d.type]?.fields ?? []).map(specField),
    ...(d.type === 1 ? uriEditor(ctx) : []),
    d.type === 1 && settingsOf()?.autofillOnPageLoad
      ? field(
          "edit-auto-pageload",
          t("autofillOnPageLoad"),
          select(
            () => (d.autofillOnPageLoad === null ? "" : String(d.autofillOnPageLoad)),
            (v) => (d.autofillOnPageLoad = v === "" ? null : v === "true"),
            [["", t("defaultLabelWithValue", settingsOf()?.autofillOnPageLoadDefault === false ? t("off") : t("on"))], ["true", t("on")], ["false", t("off")]],
          ),
        )
      : null,
    sectionTitle(t("customFields")),
    ...d.fields.map(customRow),
    h(
      "div",
      { class: "add-field-row" },
      h("button", { type: "button", class: "btn text small add-field", onclick: () => (d.fields.push({ name: "", value: "", type: 0 }), ctx.rerender(), enter([...document.querySelectorAll("[data-row=field]")].at(-1))) }, icon("plus"), t("addField")),
      h("button", { type: "button", class: "btn text small add-field", onclick: () => void pickFromPage(ctx, isNew) }, icon("globe"), t("pickField")),
    ),
    field("edit-notes", t("notes"), text(() => d.notes, (v) => (d.notes = v), { area: true, rows: 3 })),
    hasMarkup(d.notes)
      ? h("button", { type: "button", class: "chip small", "aria-pressed": String(st.notesPreview), onclick: () => ((st.notesPreview = !st.notesPreview), ctx.rerender()) }, t("previewNotes"))
      : null,
    st.notesPreview && hasMarkup(d.notes) ? renderMarkdown(d.notes) : null,
    isNew && writableOrgs().length
      ? field(
          "edit-owner",
          t("owner"),
          select(
            () => str(d.base.organizationId),
            (v) => ((d.base.organizationId = v || null), (d.collectionIds = []), ctx.rerender()),
            [["", t("ownerMe")], ...writableOrgs().map((o): [string, string] => [o.id, o.name])],
          ),
        )
      : null,
    isNew && str(d.base.organizationId) ? collectionPicker(ctx, str(d.base.organizationId), d.collectionIds) : null,
    field("edit-folder", t("folder"), select(() => d.folderId, (v) => (d.folderId = v), [["", t("noFolder")], ...(st.list?.folders ?? []).map((f): [string, string] => [f.id, f.name])])),
    h("label", { class: "row check-card" }, h("div", { class: "body" }, h("span", { class: "title" }, t("favorite"))), h("span", { class: "switch" }, fav, h("span"))),
    h(
      "label",
      { class: "row check-card" },
      h("div", { class: "body" }, h("span", { class: "title" }, t("repromptToggle")), h("span", { class: "sub wrap" }, t("repromptToggleHint"))),
      h("span", { class: "switch" }, h("input", { type: "checkbox", checked: d.reprompt, onchange: (e: Event) => (d.reprompt = (e.target as HTMLInputElement).checked) }), h("span")),
    ),
    st.busy ? progress() : null,
    h("div", { class: "editor-footer" }, h("button", { type: "submit", class: "btn filled wide", disabled: st.busy }, icon("check"), t("save"))),
  );
}

// ---------- folders ----------

// ---------- organizations ----------

/** Collections of `orgId` the user may add items to. */
const writableCollections = (orgId: string) => (st.list?.collections ?? []).filter((c) => c.organizationId === orgId && !c.readOnly);
const writableOrgs = () => (st.list?.organizations ?? []).filter((o) => writableCollections(o.id).length);

/** One switch per writable collection of `orgId`; `chosen` is changed in place. */
function collectionPicker(ctx: Ctx, orgId: string, chosen: string[]): HTMLElement {
  return h(
    "div",
    { class: "group", role: "group", "aria-label": t("collections") },
    ...writableCollections(orgId).map((c) =>
      h(
        "label",
        { class: "row check-card" },
        icon("folder"),
        h("div", { class: "body" }, h("span", { class: "title" }, c.name)),
        h(
          "span",
          { class: "switch" },
          h("input", {
            type: "checkbox",
            checked: chosen.includes(c.id),
            onchange: (e: Event) => {
              const on = (e.target as HTMLInputElement).checked;
              const at = chosen.indexOf(c.id);
              if (on && at < 0) chosen.push(c.id);
              if (!on && at >= 0) chosen.splice(at, 1);
              ctx.rerender();
            },
          }),
          h("span"),
        ),
      ),
    ),
  );
}

/** Move a personal item into an organization, or change an organization item's collections. */
const orgDraft = { id: "", orgId: "", ids: [] as string[] };
function orgView(ctx: Ctx, id: string): HTMLElement {
  const item = st.item && st.item.id === id ? st.item : undefined;
  const back = () => open(ctx, { kind: "item", id });
  const current = str(item?.organizationId);
  if (orgDraft.id !== id && item) {
    const ids = Array.isArray(item?.collectionIds) ? [...(item!.collectionIds as string[])] : [];
    Object.assign(orgDraft, { id, orgId: current || (writableOrgs()[0]?.id ?? ""), ids });
  }
  const moving = !current;
  // Collections the user cannot change stay as they are (the server keeps them only if sent).
  const fixed = moving ? [] : orgDraft.ids.filter((c) => !writableCollections(current).some((x) => x.id === c));
  const submit = () => {
    const ids = [...new Set([...orgDraft.ids])];
    if (!ids.length) return ((st.error = t("pickCollection")), ctx.rerender());
    void vaultAction(ctx, moving ? { type: "moveToOrg", id, organizationId: orgDraft.orgId, collectionIds: ids } : { type: "setCollections", id, collectionIds: ids }, "saved", false).then(() => {
      if (st.route.kind === "org" && !st.error) back();
    });
  };
  return h(
    "div",
    { class: "page" },
    topBar(iconButton("back", t("back"), back), h("h1", {}, t(moving ? "moveToOrg" : "editCollections"))),
    errorBox(),
    item ? null : h("p", { class: "caption" }, t("loading")),
    moving
      ? h(
          "div",
          { class: "field" },
          h(
            "label",
            { for: "org-owner" },
            h("span", {}, t("organization")),
            withChevron(
              h(
                "select",
                { id: "org-owner", onchange: (e: Event) => ((orgDraft.orgId = (e.target as HTMLSelectElement).value), (orgDraft.ids = []), ctx.rerender()) },
                ...writableOrgs().map((o) => h("option", { value: o.id, selected: o.id === orgDraft.orgId }, o.name)),
              ),
            ),
          ),
        )
      : null,
    moving ? h("p", { class: "caption" }, t("moveToOrgHint")) : null,
    orgDraft.orgId ? collectionPicker(ctx, orgDraft.orgId, orgDraft.ids) : null,
    fixed.length ? h("p", { class: "caption" }, t("collectionsReadOnly", String(fixed.length))) : null,
    st.busy ? progress() : null,
    h("button", { type: "button", class: "btn filled wide", disabled: st.busy || !item, onclick: submit }, icon("check"), t(moving ? "moveToOrg" : "save")),
  );
}

const REPORT_PARALLEL = 6;

async function loadReport(ctx: Ctx) {
  st.report = { done: 0, running: false, failed: false };
  const r = await send<SecurityReport>({ type: "securityReport" });
  if (st.route.kind !== "report") return;
  if (!r.ok) return ((st.error = r.error), ctx.rerender());
  st.report.data = r.data;
  ctx.rerender();
}

/** Asks HIBP for each prefix (a few at a time) and lets the worker match the answers against its own hashes. */
async function checkExposed(ctx: Ctx) {
  const rep = st.report;
  const prefixes = [...(rep?.data?.prefixes ?? [])];
  if (!rep || rep.running) return;
  Object.assign(rep, { running: true, failed: false, done: 0, exposed: new Map<string, number>() });
  ctx.rerender();
  const worker = async () => {
    for (let p = prefixes.pop(); p !== undefined && !rep.failed; p = prefixes.pop()) {
      try {
        const body = await fetchRange(p);
        const r = await send<{ id: string; count: number }[]>({ type: "exposedRange", prefix: p, body });
        if (!r.ok) throw new Error(r.error);
        for (const x of r.data) rep.exposed!.set(x.id, x.count);
      } catch {
        rep.failed = true;
      }
      rep.done++;
      if (st.route.kind === "report") ctx.rerender();
    }
  };
  await Promise.all(Array.from({ length: REPORT_PARALLEL }, worker));
  rep.running = false;
  if (st.route.kind === "report") ctx.rerender();
}

function reportView(ctx: Ctx): HTMLElement {
  const rep = st.report;
  const byId = new Map((st.list?.items ?? []).map((i) => [i.id, i]));
  const rows = (ids: string[]) => ids.map((id) => byId.get(id)).filter((i): i is VaultItem => !!i);
  const block = (title: string, ids: string[]): Child[] => {
    const items = rows(ids);
    return items.length ? [sectionTitle(`${title} (${items.length})`), h("div", { class: "group", role: "list" }, ...sortItems(items).map((i) => itemRow(ctx, i)))] : [];
  };
  const d = rep?.data;
  const total = d?.prefixes.length ?? 0;
  const exposedIds = [...(rep?.exposed?.keys() ?? [])];
  const clean = !!d && !rows(d.reused).length && !rows(d.weak).length && !rows(d.insecure).length;
  return h(
    "div",
    { class: "page" },
    topBar(iconButton("back", t("back"), () => open(ctx, { kind: "list" })), h("h1", {}, t("securityReport"))),
    errorBox(),
    !d ? progress() : null,
    d && clean && !exposedIds.length && !rep?.exposed ? h("div", { class: "empty" }, icon("shield"), h("p", { class: "title" }, t("reportClean")), h("p", { class: "caption" }, t("reportCleanHint"))) : null,
    ...(d ? [...block(t("reportReused"), d.reused), ...block(t("reportWeak"), d.weak), ...block(t("reportInsecure"), d.insecure)] : []),
    d && total
      ? h(
          "div",
          { class: "group" },
          h("button", { type: "button", class: "row", disabled: rep!.running, onclick: () => void checkExposed(ctx) }, icon("shield"), h("div", { class: "body" }, h("span", { class: "title" }, rep!.running ? t("reportChecking", String(rep!.done), String(total)) : t("reportCheckExposed")))),
        )
      : null,
    d && total ? h("p", { class: "caption" }, t("reportExposedNote")) : null,
    rep?.failed ? h("div", { class: "notice warn" }, icon("error"), h("div", {}, t("reportFailed"))) : null,
    ...(rep?.exposed && !rep.running ? (exposedIds.length ? block(t("reportExposed"), exposedIds) : rep.failed ? [] : [h("p", { class: "caption" }, t("reportExposedNone"))]) : []),
  );
}

function foldersView(ctx: Ctx): HTMLElement {
  const names = new Map((st.list?.folders ?? []).map((f) => [f.id, f.name]));
  const fresh = { name: "" };
  // One compact row per folder: the name edits in place, the actions sit next to it.
  const folderRow = (id: string) =>
    h(
      "div",
      { class: "row" },
      icon("folder"),
      h("input", { class: "row-input", value: names.get(id) ?? "", "aria-label": t("folderName"), spellcheck: false, oninput: (e: Event) => names.set(id, (e.target as HTMLInputElement).value) }),
      h(
        "span",
        { class: "field-actions" },
        iconButton("edit", t("rename"), () => void vaultAction(ctx, { type: "saveFolder", id, name: names.get(id) ?? "" }, "saved", false), { class: "icon-btn sm" }),
        // Two clicks, like the other deletes that cannot be undone: the folder and every item's place in it go.
        st.confirmDelete && st.armed === `folder:${id}`
          ? iconButton("trash", t("tapAgainToDelete"), (e) => twoTap(ctx, () => leave(rowOf(e), () => void vaultAction(ctx, { type: "deleteFolder", id }, "deleted", false)), `folder:${id}`), { class: "icon-btn sm danger" })
          : iconButton("trash", t("deleteFolder"), () => twoTap(ctx, () => {}, `folder:${id}`), { class: "icon-btn sm delete" }),
      ),
    );
  return h(
    "div",
    { class: "page" },
    topBar(iconButton("back", t("back"), () => open(ctx, { kind: "list" })), h("h1", {}, t("folders"))),
    errorBox(),
    h(
      "div",
      { class: "group" },
      ...(st.list?.folders ?? []).map((f) => folderRow(f.id)),
      h(
        "form",
        {
          class: "row",
          onsubmit: (e: Event) => {
            e.preventDefault();
            if (fresh.name.trim()) void vaultAction(ctx, { type: "saveFolder", name: fresh.name.trim() }, "saved", false);
          },
        },
        icon("plus"),
        h("input", { class: "row-input", placeholder: t("newFolder"), "aria-label": t("newFolder"), oninput: (e: Event) => (fresh.name = (e.target as HTMLInputElement).value) }),
        h("button", { type: "submit", class: "btn tonal small" }, t("add")),
      ),
    ),
  );
}

export function vaultScreen(ctx: Ctx): HTMLElement {
  currentCtx = ctx;
  closeMenu(); // a re-render invalidates any open popover menu
  if (!st.list && !st.loading && !st.error) void loadList(ctx);
  const r = st.route;
  if (st.large) return largeTypeView(ctx);
  if (st.qr) return qrView(ctx);
  if (r.kind === "item") return itemView(ctx, r.id);
  if (r.kind === "edit" && st.draft && st.picking) {
    const field = st.picking;
    const d = st.draft;
    const back = () => {
      st.picking = undefined;
      ctx.rerender();
    };
    return generatorScreen(ctx, {
      field,
      back,
      use: (value) => {
        d.data[field] = value;
        if (field === "password") st.reveal.add("edit-password");
        back();
      },
      ...(field === "username"
        ? {
            addField: (name: string, value: string) => {
              d.fields.push({ name, value, type: 0 });
              back();
            },
          }
        : {}),
    });
  }
  if (r.kind === "edit" && st.draft) return editView(ctx, r.isNew);
  if (r.kind === "folders") return foldersView(ctx);
  if (r.kind === "report") return reportView(ctx);
  if (r.kind === "org") return orgView(ctx, r.id);
  return listView(ctx);
}
