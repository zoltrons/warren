// Inline menu and save/update bar. The content script reports focused fields and submitted logins;
// menu.html / bar.html (extension pages framed into the site) ask for data and act. Matching always
// uses the URL of the frame the field is in, as reported by the browser (sender.url).
import type { FillResult } from "../autofill/types.ts";
import type { BarInfo, FieldKind, FrameRequest, MenuData, MenuItem, PageRequest, VaultItem } from "../shared/messages.ts";
import { httpUrl } from "../shared/url.ts";
import { coreCall } from "./core.ts";
import { analyzeFocus, customFieldsOf, fillInFrames, pageDeadline } from "./engine.ts";
import { lockEpoch, touchAutoLock } from "./lock.ts";
import { pageLoadFill } from "./autofill.ts";
import { finishFieldPicker } from "./picker.ts";
import { conditionalReady, openConditional } from "./passkey.ts";
import { getLocal, getSettings, getTabState, setLocal, setTabState, updateSession } from "./store.ts";
import { REPROMPT_MESSAGE, repromptPending } from "./reprompt.ts";
import { copyToClipboard, ensureLoaded, isUnlocked, list, markUsed, save, saveEncrypted } from "./vault.ts";
import { isBlocked, readPrivate, updatePrivate } from "./private.ts";

export interface InlineContext {
  frameId: number;
  url: string;
  kind: FieldKind;
  /** The opening document's secret, echoed by the menu frame (see PageRequest.inlineFocus). */
  nonce: string;
  /** The field is in a registration form (the engine's form_clues). */
  signup: boolean;
}

export interface PendingSave {
  kind: "add" | "update";
  url: string;
  username: string;
  password: string;
  itemId?: string;
  /** Update: the item's revision (epoch ms) the prompt was made against. Saving refuses a copy that changed since. */
  revisionDate?: number;
  /** Secret handed to the bar frame, so a bar the page frames itself cannot save (see showBar). */
  token: string;
  /** epoch ms */
  expiresAt: number;
}

const SAVE_TTL_MS = 5 * 60_000;

async function items(kind: FieldKind, url: string): Promise<MenuItem[]> {
  const pick = ({ id, type, name, sub }: VaultItem) => ({ id, type, name, sub });
  if (kind === "login") {
    await ensureLoaded();
    const { defaultUriMatch } = await getSettings();
    return (await coreCall<VaultItem[]>({ op: "matchUri", url, defaultMatch: defaultUriMatch })).map(pick);
  }
  const settings = await getSettings();
  if (kind === "card" && !settings.inlineMenuCards) return [];
  if (kind === "identity" && !settings.inlineMenuIdentities) return [];
  const type = kind === "card" ? 3 : 4;
  return (await list()).items.filter((i) => i.type === type && !i.failed).map(pick);
}


/**
 * Page-originated work is cheap for a page to request and expensive to run (vault scan, PSL). One focus
 * at a time per tab; while it runs, only the newest focus waits, older ones get `superseded`. (Dropping
 * the newest instead closed the menu when the user clicked two fields quickly.) Submitted logins are
 * coalesced per tab before the queue, in index.ts.
 */
const queues = new Map<string, { running: Promise<unknown>; newest: number }>();

const latestPerTab = <T>(key: string, tabId: number, fn: () => Promise<T>, superseded: T): Promise<T> => {
  const k = `${key}:${tabId}`;
  const q = queues.get(k);
  const ticket = (q?.newest ?? 0) + 1;
  const running = (q?.running ?? Promise.resolve()).then(() => (queues.get(k)?.newest === ticket ? fn() : superseded));
  const settled = running.catch(() => undefined).finally(() => {
    if (queues.get(k)?.running === settled) queues.delete(k);
  });
  queues.set(k, { running: settled, newest: ticket });
  return running;
};

/** Content script: `rows` tells it how tall the menu is, 0 = do not show one; `kind` what the field is. */
export async function handlePage(req: PageRequest, sender: chrome.runtime.MessageSender): Promise<unknown> {
  if (req.type === "pageLoad") return pageLoadFill(sender);
  const url = httpUrl(sender)?.href;
  const tabId = sender.tab?.id;
  if (!url || tabId === undefined || sender.frameId === undefined) return { rows: 0 };
  if (req.type === "fieldPicked") return finishFieldPicker(tabId, req).then(() => null);
  if (req.type === "inlineFocus")
    return latestPerTab(
      "focus",
      tabId,
      async () => {
        const field = await analyzeFocus(req.details);
        if (!field.kind) return { rows: 0 };
        return { kind: field.kind, ...(await onFocus(field.kind, req.nonce, field.signup, url, tabId, sender.frameId!)) };
      },
      { rows: 0 },
    );
  await loginSubmitted(tabId, url, req.username, req.password);
  return null;
}

const offerCreate = (ctx: InlineContext, logins: number) => ctx.kind === "login" && (ctx.signup || !logins);

async function onFocus(kind: FieldKind, nonce: string, signup: boolean, url: string, tabId: number, frameId: number): Promise<{ rows: number; footer?: boolean }> {
  if (!(await getSettings()).inlineMenu || !(await getLocal("account"))) return { rows: 0 };
  const ctx: InlineContext = { frameId, url, kind, nonce, signup };
  await setTabState("inline", tabId, ctx);
  if (!(await isUnlocked())) return { rows: 1 }; // "Unlock to fill"
  if (await isBlocked(url, true)) return { rows: 0 };
  const logins = (await items(kind, url)).length;
  // A website waiting on a conditional passkey request gets one extra row for it.
  const passkey = kind === "login" && (await conditionalReady(tabId, frameId));
  // footer: the menu's "Manage passwords" row under the list, as in Chrome's own autofill dropdown.
  return { rows: logins + (passkey ? 1 : 0) + (offerCreate(ctx, logins) ? 1 : 0), footer: true };
}

async function loginSubmitted(tabId: number, url: string, username: string, password: string) {
  const epoch = lockEpoch();
  const settings = await getSettings();
  const host = new URL(url).hostname.replace(/\.$/, ""); // no port or trailing dot: the form hostOf gives the settings list
  if (!settings.savePrompt || !(await isUnlocked()) || (await readPrivate()).neverSave.includes(host)) return;
  await ensureLoaded();
  const matches = await coreCall<VaultItem[]>({ op: "matchUri", url, defaultMatch: settings.defaultUriMatch });
  // Usernames compare case-insensitively, like the official clients ("Ali@x.com" is "ali@x.com"). A page
  // without one (the password step of a two-step sign-in) may be any of the site's logins.
  const sameUser = username ? matches.filter((m) => m.sub.toLowerCase() === username.toLowerCase()) : matches;
  const editable = sameUser.filter((m) => !m.readOnly);
  // Only read-only copies (e.g. an organization's): the login is saved already, never offer a duplicate.
  if (!editable.length && sameUser.length) return dropSave(tabId);
  // A flagged item is never compared or overwritten from inside a page: edit it in the popup.
  if (editable.some((m) => repromptPending(m))) return;
  // A saved login signing in: nothing to offer, and a save an earlier (mistyped) submit left waiting goes.
  for (const m of editable) if ((await coreCall<{ password: string }>({ op: "fillData", id: m.id })).password === password) return dropSave(tabId);
  const expiresAt = Date.now() + SAVE_TTL_MS;
  let pending: PendingSave;
  if (!editable.length) pending = { kind: "add", url, username, password, token: "", expiresAt };
  else if (editable.length === 1) {
    const [m] = editable as [VaultItem];
    pending = { kind: "update", url, username: username || m.sub, password, itemId: m.id, revisionDate: m.revisionDate, token: "", expiresAt };
  } else return; // several logins (even with the same username), none with this password: no telling which one changed
  // A lock while this was decided cleared the pending saves: the typed password must not come back after it.
  if (epoch !== lockEpoch()) return;
  await setTabState("save", tabId, pending);
  await showBar(tabId, epoch);
}

/** A pending save, dropping it once its TTL passed so a typed password never outlives it. */
async function pendingSave(tabId: number): Promise<PendingSave | undefined> {
  const p = await getTabState("save", tabId);
  if (!p) return undefined;
  if (p.expiresAt <= Date.now()) {
    await setTabState("save", tabId, undefined);
    return undefined;
  }
  return p;
}

/**
 * Also called when the tab finishes loading: logins are usually submitted right before a navigation. `epoch`:
 * lockEpoch() from before the pending save was read.
 */
export async function showBar(tabId: number, epoch = lockEpoch()): Promise<void> {
  const p = await pendingSave(tabId);
  if (!p) return;
  // The pending login was typed on `p.url`: never offer it on a page of another site (the tab may have
  // navigated away). It is kept until it expires, so coming back to the site still prompts.
  if (!(await onSameSite(tabId, p.url))) return;
  // A fresh token per show, carried by the bar frame it opens and required back from it: a copy of
  // bar.html framed by the page has no token and cannot save.
  const token = crypto.randomUUID();
  // Written back only if no lock cleared it meanwhile (checked in the tick the write goes out).
  if (epoch !== lockEpoch()) return;
  await setTabState("save", tabId, { ...p, token });
  await pageDeadline(chrome.tabs.sendMessage(tabId, { type: "barShow", token }, { frameId: 0 })).catch(() => undefined);
}

async function onSameSite(tabId: number, url: string): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return !!tab.url && new URL(tab.url).origin === new URL(url).origin;
  } catch {
    return false; // no such tab, or a page we cannot read (chrome://, the web store)
  }
}

async function dropSave(tabId: number) {
  await setTabState("save", tabId, undefined);
  await chrome.tabs.sendMessage(tabId, { type: "barHide" }, { frameId: 0 }).catch(() => undefined);
}

/** menu.html / bar.html, framed into the tab `sender.tab`. */
export async function handleFrame(req: FrameRequest, tabId: number): Promise<unknown> {
  // Before anything is read: a fill that a lock overtakes reaches no frame (engine.ts).
  const epoch = lockEpoch();
  if (req.type === "barInfo" || req.type === "barAction") {
    const p = await pendingSave(tabId);
    if (!p) return dropSave(tabId).then(() => null);
    // Only the bar this tab was just opened with may read or act.
    if (!p.token || req.token !== p.token) throw new Error("this save prompt is no longer active");
    if (req.type === "barInfo") return { kind: p.kind, host: new URL(p.url).host, username: p.username } satisfies BarInfo;
    if (req.action === "never") {
      const host = new URL(p.url).hostname.replace(/\.$/, "");
      await updatePrivate((d) => (d.neverSave = [...d.neverSave.filter((h) => h !== host), host]));
    } else if (req.action === "save") {
      if (p.kind === "update" && p.itemId) {
        // flagged after the prompt was queued
        if (repromptPending(await coreCall<VaultItem>({ op: "cipherSummary", id: p.itemId }))) throw new Error(REPROMPT_MESSAGE);
        // Against the revision the prompt was made for: an older prompt never undoes a newer password.
        await saveEncrypted(await coreCall<Record<string, unknown>>({ op: "preparePassword", id: p.itemId, password: p.password, revisionDate: p.revisionDate }));
      } else {
        const u = new URL(p.url);
        await save({ type: 1, name: u.hostname, login: { username: p.username, password: p.password, uris: [{ uri: u.origin, match: null }] } });
      }
    }
    await dropSave(tabId);
    return null;
  }

  const ctx = await getTabState("inline", tabId);
  if (!ctx) throw new Error("no field is focused");
  // Only the menu this document opened may act: a copy of menu.html framed by the page has no nonce.
  if (req.nonce !== ctx.nonce) throw new Error("this menu is not the one opened for this page");
  if (req.type === "inlineOpen") {
    await chrome.action.openPopup().catch(() => undefined);
    return null;
  }
  if (req.type === "inlinePasskey") {
    await touchAutoLock(); // a pick counts as activity
    await openConditional(tabId, ctx.frameId);
    return null;
  }
  if (!(await isUnlocked())) return { kind: ctx.kind, locked: true, items: [], passkey: false, create: false } satisfies MenuData;
  if (req.type === "inlineNewLogin") {
    await touchAutoLock();
    await updateSession({ newLogin: new URL(ctx.url).origin });
    await chrome.action.openPopup().catch(() => updateSession({ newLogin: undefined }));
    return null;
  }
  const available = await items(ctx.kind, ctx.url);
  const passkey = ctx.kind === "login" && (await conditionalReady(tabId, ctx.frameId));
  if (req.type === "inlineList") return { kind: ctx.kind, locked: false, items: available, passkey, create: offerCreate(ctx, available.length) } satisfies MenuData;

  // inlineFill: only an item offered for this field and frame.
  if (!available.some((i) => i.id === req.id)) throw new Error("item not available here");
  // Only a pick counts as activity: a page can open the menu (and list it) on its own, in a loop.
  await touchAutoLock();
  // A flagged item needs the master password, and there is no place to ask for it inside the page:
  // send the user to the extension popup, where the unlock screen is one click away.
  if (repromptPending(await coreCall<VaultItem>({ op: "cipherSummary", id: req.id }))) {
    await chrome.action.openPopup().catch(() => undefined);
    throw new Error(REPROMPT_MESSAGE);
  }
  await chrome.tabs.sendMessage(tabId, { type: "inlineClose" }, { frameId: ctx.frameId }).catch(() => undefined);
  const origin = new URL(ctx.url).origin;
  let res: FillResult | undefined;
  if (ctx.kind === "login") {
    const { username, password, totp } = await coreCall<{ username: string; password: string; totp?: string }>({ op: "fillData", id: req.id });
    const { autosubmit } = await getSettings();
    res = (await fillInFrames(tabId, { frameIds: [ctx.frameId] }, { mode: "login", origin, username, password, totp, autosubmit, customFields: await customFieldsOf(req.id), epoch }))[0]?.result;
    if (res?.filled) {
      await markUsed(req.id);
      if (totp && (await getSettings()).autoCopyTotp && epoch === lockEpoch()) await copyToClipboard(totp);
    }
  } else {
    const values = await coreCall<Record<string, string>>({ op: "formValues", id: req.id });
    res = (await fillInFrames(tabId, { frameIds: [ctx.frameId] }, { mode: "form", origin, values, customFields: await customFieldsOf(req.id), epoch }))[0]?.result;
  }
  await setTabState("inline", tabId, undefined);
  return res ?? { filled: false };
}
