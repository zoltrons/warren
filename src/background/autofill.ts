// Autofill on the active tab from the popup, Ctrl+Shift+L or the context menu.
import type { FillResult, PageLogin } from "../autofill/types.ts";
import type { PageMatches, VaultItem, VaultList } from "../shared/messages.ts";
import { pickPageLoadLogin } from "../shared/pageload.ts";
import { UserError } from "./account.ts";
import { coreCall } from "./core.ts";
import { customFieldsOf, type FillRequest, fillInFrames, pageCall } from "./engine.ts";
import { lockEpoch, touchAutoLock } from "./lock.ts";
import { getLocal, getSettings } from "./store.ts";
import { REPROMPT_MESSAGE, repromptPending } from "./reprompt.ts";
import { copyToClipboard, ensureLoaded, isUnlocked, markUsed } from "./vault.ts";
import { readPrivate } from "./private.ts";

const CONTEXT_MENU_ID = "warren-autofill";
export const AUTOFILL_COMMAND = "autofill-login";
const COPY_FIELD_NAME_ID = "warren-copy-field-name";

export async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  return (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
}

export function httpUrl(tab: { url?: string } | undefined): URL | undefined {
  try {
    const u = new URL(tab?.url ?? "");
    return u.protocol === "https:" || u.protocol === "http:" ? u : undefined;
  } catch {
    return undefined;
  }
}

async function matches(url: URL): Promise<VaultItem[]> {
  await ensureLoaded();
  const { defaultUriMatch } = await getSettings();
  return coreCall<VaultItem[]>({ op: "matchUri", url: url.href, defaultMatch: defaultUriMatch });
}

/** Logins matching the tab, plus cards / identities when the user shows them in the tab view. */
export async function pageMatches(): Promise<PageMatches> {
  const tab = await activeTab();
  const url = httpUrl(tab);
  if (!url) return { items: [] };
  const settings = await getSettings();
  const items = await matches(url);
  const wanted = [settings.showCardsOnTab ? 3 : 0, settings.showIdentitiesOnTab ? 4 : 0].filter(Boolean);
  // The bare list: list() would also decrypt the usage data, which is not needed here.
  if (wanted.length) items.push(...(await coreCall<VaultList>({ op: "listVault" })).items.filter((i) => wanted.includes(i.type) && !i.failed));
  return { tabId: tab?.id, host: url.host, origin: url.origin, items };
}

/**
 * Page-load autofill: fill the best login into the frame that reported the page. Mirrors the
 * official client: the per-item tri-state decides whether an item takes part, the last login used
 * for the site wins (else the first by name), and only empty fields are filled.
 */
export async function pageLoadFill(sender: chrome.runtime.MessageSender): Promise<FillResult> {
  const epoch = lockEpoch();
  const settings = await getSettings();
  const tabId = sender.tab?.id;
  const frameId = sender.frameId;
  const url = httpUrl(sender);
  if (!settings.autofillOnPageLoad || tabId === undefined || frameId === undefined || !url) return { filled: false, reason: "noFields" };
  if (!(await isUnlocked())) return { filled: false, reason: "locked" };
  // Items flagged for a master-password re-prompt never fill on page load (no user to ask).
  const pick = pickPageLoadLogin((await matches(url)).filter((i) => !i.reprompt), settings.autofillOnPageLoadDefault, (await readPrivate()).lastUsed);
  if (!pick) return { filled: false, reason: "noMatch" };
  const { username, password } = await coreCall<{ username: string; password: string }>({ op: "fillData", id: pick.id });
  const customFields = await customFieldsOf(pick.id);
  const [res] = await fillInFrames(tabId, { frameIds: [frameId] }, { mode: "login", origin: url.origin, username, password, customFields, onlyEmpty: true, epoch });
  const r = res?.result ?? { filled: false };
  if (r.filled) await closeInlineMenu(tabId, frameId);
  // Unlike the official client, no TOTP copy: nobody asked for this fill, and a code on the clipboard reaches
  // clipboard managers and synced clipboards. No touchAutoLock either: a page load is not user activity.
  return r;
}

/**
 * Runs a page fill, top frame first. A login form is often inside a (same-origin) iframe, so when the
 * top frame has nothing the fill is retried in every frame; the origin check inside refuses foreign ones.
 * A login goes password-first: an e-mail box in the top frame must not win over a real form in an iframe,
 * so the username-only step is the last resort.
 */
async function fillFrames(tabId: number, req: FillRequest): Promise<FillResult> {
  const filledIn = (res: { result: FillResult; frameId: number }[]) => res.find((r) => r.result.filled);
  const strict = req.mode === "login" ? { ...req, passwordOnly: true } : req;
  const top = await fillInFrames(tabId, { frameIds: [0] }, strict);
  const hit = filledIn(top) ?? filledIn(await fillInFrames(tabId, { allFrames: true }, strict));
  if (hit) {
    await closeInlineMenu(tabId, hit.frameId);
    return hit.result;
  }
  if (req.mode !== "login") return top[0]?.result ?? { filled: false };
  const last = (await fillInFrames(tabId, { frameIds: [0] }, req))[0]?.result;
  if (last?.filled) await closeInlineMenu(tabId);
  return last ?? { filled: false };
}

/**
 * The fill focuses the fields it writes, which would open the inline menu on top of a fill the user just
 * asked for. `inlineClose` also keeps the menu quiet for a moment (content.ts).
 */
function closeInlineMenu(tabId: number, frameId?: number) {
  return chrome.tabs.sendMessage(tabId, { type: "inlineClose" }, frameId === undefined ? {} : { frameId }).catch(() => undefined);
}

/** Fills `id` (or the first match) into the tab. Only items saved for this site are filled. */
async function fillTab(tab: chrome.tabs.Tab | undefined, id?: string, anyway = false): Promise<FillResult> {
  // Before any value is read: a lock from here on stops the fill before a frame gets one (engine.ts).
  const epoch = lockEpoch();
  const url = httpUrl(tab);
  if (!url || tab?.id === undefined) throw new UserError("invalid", "This page cannot be filled");
  let item: VaultItem | undefined;
  let values: Record<string, string> | undefined;
  if (id) {
    // The "On this site" list may offer a card or identity: fill it by its own field map.
    const cipher = await coreCall<VaultItem>({ op: "cipherSummary", id }).catch(() => undefined);
    if (!cipher) return { filled: false, reason: "noMatch" };
    if (repromptPending(cipher)) throw new UserError("reprompt", REPROMPT_MESSAGE);
    const type = cipher.type;
    if (type === 1) {
      if (!anyway && !(await matches(url)).some((i) => i.id === id)) return { filled: false, reason: "noMatch" };
    } else if (type === 3 || type === 4) {
      values = await coreCall<Record<string, string>>({ op: "formValues", id });
    } else return { filled: false, reason: "noMatch" };
  } else {
    // "Fill the first match" is a fill nobody confirmed: skip items that need a re-prompt.
    item = (await matches(url)).filter((i) => !i.reprompt)[0];
    if (!item) return { filled: false, reason: "noMatch" };
    id = item.id;
  }
  let r: FillResult;
  let totp: string | undefined;
  if (values) {
    r = await fillFrames(tab.id, { mode: "form", origin: url.origin, values, customFields: await customFieldsOf(id), epoch });
  } else {
    const filled = await coreCall<{ username: string; password: string; totp?: string }>({ op: "fillData", id });
    totp = filled.totp;
    const { autosubmit } = await getSettings();
    r = await fillFrames(tab.id, { mode: "login", origin: url.origin, username: filled.username, password: filled.password, totp, autosubmit, customFields: await customFieldsOf(id), epoch });
  }
  if (r.filled) {
    await markUsed(id);
    // Not onto the clipboard of a vault that locked after the fill.
    if (totp && (await getSettings()).autoCopyTotp && epoch === lockEpoch()) await copyToClipboard(totp);
  }
  return r;
}

/**
 * A fill the user picked in the popup. A login saved for another site fills only with `anyway` (the user accepted
 * the "Fill anyway" dialog for this very page), like the official client. Only into
 * the page the popup showed: a side panel stays open across tab switches and navigations, and the user chose for
 * that site. fillTab passes `origin` down, so a navigation after this check is refused in the frame too.
 */
export async function fillShownTab(id: string, tabId: number, origin: string, anyway = false): Promise<FillResult> {
  const tab = await chrome.tabs.get(tabId).catch(() => undefined);
  if (!tab?.active || httpUrl(tab)?.origin !== origin) throw new UserError("invalid", "The page changed. Check the site and try again.");
  return fillTab(tab, id, anyway);
}

/** Toolbar icon per state: full color when unlocked, gray when locked, faded gray when logged out. */
const actionIcon = (state: "warren" | "locked" | "loggedout") => Object.fromEntries([16, 19, 32, 38].map((s) => [s, `icons/${state}-${s}.png`]));

// Last icon set by this worker: a service worker loads `path` icons with fetch, so set it only on a change.
let shownIcon: string | undefined;

// Calls overlap (tab switch + page load); menu ids must not be created twice.
let tabUi: Promise<void> = Promise.resolve();
const ignoreError = () => void chrome.runtime.lastError;

/**
 * Action badge with the number of logins for the active tab, and one context-menu entry per login
 * under "Fill with Warren", and the toolbar icon for the lock state. Locked: no badges anywhere, and the bare
 * entry opens the popup.
 */
export function updateTabUi(): Promise<void> {
  tabUi = tabUi.then(async () => {
    const tab = await activeTab();
    const url = httpUrl(tab);
    const unlocked = await isUnlocked();
    const items = unlocked && url ? await matches(url) : [];
    await chrome.contextMenus.removeAll();
    if ((await getSettings()).contextMenu) {
      const contexts: ["editable"] = ["editable"];
      chrome.contextMenus.create({ id: CONTEXT_MENU_ID, title: chrome.i18n.getMessage("ctxAutofill"), contexts }, ignoreError);
      for (const i of items)
        chrome.contextMenus.create({ id: `${CONTEXT_MENU_ID}:${i.id}`, parentId: CONTEXT_MENU_ID, title: i.sub ? `${i.name} (${i.sub})` : i.name, contexts }, ignoreError);
      // A child turns the parent into a plain submenu, so a locked vault keeps the entry that opens the popup.
      if (unlocked) chrome.contextMenus.create({ id: COPY_FIELD_NAME_ID, parentId: CONTEXT_MENU_ID, title: chrome.i18n.getMessage("copyCustomFieldName"), contexts }, ignoreError);
    }
    const icon = unlocked ? "warren" : (await getLocal("account")) ? "locked" : "loggedout";
    if (icon !== shownIcon) {
      shownIcon = icon;
      // Not awaited: a stalled icon load must not hold up the badge, the menu or the request queue behind it.
      void chrome.action.setIcon({ path: actionIcon(icon) }).catch(() => (shownIcon = undefined));
      void chrome.action.setBadgeBackgroundColor({ color: "#c2113f" }); // raspberry: white count text stays readable
    }
    const badge = (tabId: number | undefined, text: string) => (tabId === undefined ? undefined : chrome.action.setBadgeText({ tabId, text }));
    if (unlocked) await badge(tab?.id, items.length ? String(items.length) : "");
    else await Promise.all((await chrome.tabs.query({})).map((t) => badge(t.id, "")));
  }).catch((e: unknown) => console.warn("tab ui", e));
  return tabUi;
}

/** Context menu: the parent entry fills the first match; a child entry fills that login. */
export async function onContextMenu(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) {
  if (!(await getSettings()).contextMenu) return undefined;
  const id = String(info.menuItemId);
  if (id === COPY_FIELD_NAME_ID) return copyFieldName(tab, info.frameId);
  if (id === CONTEXT_MENU_ID) return autofillFromGesture(tab);
  if (id.startsWith(`${CONTEXT_MENU_ID}:`)) return autofillFromGesture(tab, id.slice(CONTEXT_MENU_ID.length + 1));
  return undefined;
}

/** What to call a custom field for the field the user right-clicked. The frame says, the user picked it. */
async function copyFieldName(tab: chrome.tabs.Tab | undefined, frameId: number | undefined) {
  if (tab?.id === undefined) return;
  const name: unknown = await chrome.tabs.sendMessage(tab.id, { type: "clickedFieldName" }, { frameId: frameId ?? 0 }).catch(() => undefined);
  if (typeof name === "string" && name) await copyToClipboard(name.slice(0, 300));
}

export async function readPageLogin(): Promise<PageLogin | null> {
  const tab = await activeTab();
  if (!httpUrl(tab) || tab?.id === undefined) return null;
  const [res] = await pageCall<PageLogin | null>({ tabId: tab.id, frameIds: [0] }, "readLogin", undefined);
  const login = res?.result ?? null;
  return login && { ...login, url: tab.url! }; // the browser's URL, not the page's own location.href
}

/** Keyboard shortcut / context menu: fill the first match, or open the popup (locked, or nothing to fill). */
export async function autofillFromGesture(tab: chrome.tabs.Tab | undefined, id?: string): Promise<FillResult> {
  if (!(await isUnlocked())) {
    await chrome.action.openPopup().catch(() => undefined);
    return { filled: false, reason: "locked" };
  }
  await touchAutoLock();
  const r = await fillTab(tab, id).catch((e: unknown): FillResult => (console.warn("autofill", e), { filled: false, reason: "error" }));
  if (!r.filled) await chrome.action.openPopup().catch(() => undefined);
  return r;
}
