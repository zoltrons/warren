// Inline menu and save/update bar. The content script reports focused fields and submitted logins;
// menu.html / bar.html (extension pages framed into the site) ask for data and act. Matching always
// uses the URL of the frame the field is in, as reported by the browser (sender.url).
import type { FillResult, PageLogin } from "../autofill/types.ts";
import { type BarInfo, type FieldKind, type FrameRequest, type MenuData, type MenuItem, type PageRequest, parsePageRequest, type VaultItem, type VaultList } from "../shared/messages.ts";
import { emailAt, httpUrl } from "../shared/url.ts";
import { type PasswordConstraints, ruleOptions } from "../shared/password-rules.ts";
import { coreCall } from "./core.ts";
import { UserError, msg } from "./errors.ts";
import { analyzeFocus, customFieldsOf, fillActiveField, fillInFrames, pageCall, pageDeadline } from "./engine.ts";
import { lockEpoch, touchAutoLock } from "./lock.ts";
import { pageLoadFill, rememberLockedFill } from "./autofill.ts";
import { finishFieldPicker } from "./picker.ts";
import { conditionalReady, openConditional, publicSuffixes, rememberFill } from "./passkey.ts";
import { getLocal, getSettings, getTabState, setLocal, setTabState, updateSession } from "./store.ts";
import { generateAlias, readyAliasVendor } from "./alias.ts";
import { REPROMPT_MESSAGE, repromptPending } from "./reprompt.ts";
import { addGeneratorHistory, copyToClipboard, ensureLoaded, isUnlocked, list, markUsed, save, saveEncrypted } from "./vault.ts";
import { type GeneratorPrefs, generatorPrefs, isBlocked, pageHost, readPrivate, updatePrivate, withWordlist } from "./private.ts";

export interface InlineContext {
  frameId: number;
  url: string;
  kind: FieldKind;
  /** The opening document's secret, echoed by the menu frame (see PageRequest.inlineFocus). */
  nonce: string;
  /** The field is in a registration form (the engine's form_clues). */
  signup: boolean;
  /** The form's password fields: `passwordrules` and length limits, for "Use a strong password". */
  password?: PasswordConstraints;
  /** The field asks for the account: an e-mail box, or a username one (the engine's designation). */
  account?: "email" | "username";
}

export interface PendingSave {
  /** `locked`: submitted while Warren was locked; matched against the vault once it is unlocked (resumeSaves). */
  kind: "add" | "update" | "locked";
  url: string;
  username: string;
  password: string;
  itemId?: string;
  /** Update: the item's revision (epoch ms) the prompt was made against. Saving refuses a copy that changed since. */
  revisionDate?: number;
  /** Update without `itemId`: the site's logins that could have changed; the user picks one in the bar. */
  choices?: { id: string; name: string; sub: string; revisionDate?: number }[];
  /** Secret handed to the bar frame, so a bar the page frames itself cannot save (see showBar). */
  token: string;
  /** From "Use a strong password": prompted as soon as it is filled, and kept longer, as no one typed it anywhere. */
  generated?: boolean;
  /** Add: account names the bar offers for the username (BarInfo.usernames). */
  usernames?: string[];
  /** Update `itemId`, a login saved without a username: the save sets the (editable) username too. */
  addUsername?: boolean;
  /** Made at a fill, before the site took the password: shown only once a submit makes it again (showBar skips it). */
  untilSubmit?: boolean;
  /** epoch ms */
  expiresAt: number;
}

const SAVE_TTL_MS = 5 * 60_000;
/** A generated password exists nowhere else but the generator history: a slow sign-up (e-mail check, captcha) keeps its prompt. */
const GENERATED_TTL_MS = 30 * 60_000;
/** Logins the update bar offers to choose from. */
const MAX_CHOICES = 10;

async function items(kind: FieldKind, url: string): Promise<MenuItem[]> {
  const pick = ({ id, type, name, sub }: VaultItem) => ({ id, type, name, sub });
  if (kind === "login") {
    await ensureLoaded();
    const { defaultUriMatch } = await getSettings();
    // The page opens this menu itself: a login it matched only through a regular expression would be a lure (VaultItem.regexOnly).
    return (await coreCall<VaultItem[]>({ op: "matchUri", url, defaultMatch: defaultUriMatch })).filter((m) => !m.regexOnly).map(pick);
  }
  const settings = await getSettings();
  if (kind === "card" && !settings.inlineMenuCards) return [];
  if (kind === "identity" && !settings.inlineMenuIdentities) return [];
  const type = kind === "card" ? 3 : 4;
  // The bare list, as pageMatches takes it: list() would also decrypt the usage data, which is not needed here.
  await ensureLoaded();
  return (await coreCall<VaultList>({ op: "listVault" })).items.filter((i) => i.type === type && !i.failed).map(pick);
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
  if (req.type === "inlineRemote") return remoteMenu(req, tabId, sender.frameId);
  if (req.type === "inlineFocus")
    return latestPerTab(
      "focus",
      tabId,
      async () => {
        const field = await analyzeFocus(req.details);
        if (!field.kind) return { rows: 0 };
        const account = field.autofillType === "Email" ? "email" : field.autofillType === "Username" ? "username" : undefined;
        return { kind: field.kind, ...(await onFocus(field.kind, req.nonce, field.signup, field.password, account, url, tabId, sender.frameId!)) };
      },
      { rows: 0 },
    );
  await loginSubmitted(tabId, url, req.username, req.password, { usernames: req.usernames ?? [] });
  return null;
}

/**
 * The top frame draws the menu for a child frame that is too small for it (content.ts). The nonce stays between the
 * worker and our content scripts: the page in either frame never sees it.
 */
async function remoteMenu(req: Extract<PageRequest, { type: "inlineRemote" }>, tabId: number, frameId: number): Promise<unknown> {
  const ctx = await getTabState("inline", tabId);
  const send = (msg: Record<string, unknown>, to: number) => chrome.tabs.sendMessage(tabId, msg, { frameId: to }).catch(() => undefined);
  if (req.op === "back") return frameId === 0 && ctx ? send({ type: "inlineBack" }, ctx.frameId).then(() => null) : null;
  // Only the frame whose field the current menu context is for, and never the top frame itself.
  if (!ctx || frameId === 0 || ctx.frameId !== frameId) return false;
  if (req.op === "hide") return send({ type: "inlineHide" }, 0).then(() => null);
  if (req.op === "focus") return send({ type: "inlineMenuFocus" }, 0).then(() => null);
  const { rect, height, token } = req;
  if (!rect || !token || height === undefined || height <= 0 || height > 400) return false;
  return (await pageDeadline(chrome.tabs.sendMessage(tabId, { type: "inlineShow", token, rect, height, nonce: ctx.nonce }, { frameId: 0 })).catch(() => false)) === true;
}

/** Before a fill: the field's frame closes its menu, and so does the top frame when it drew it (remoteMenu). */
async function closeMenu(tabId: number, ctx: InlineContext) {
  await chrome.tabs.sendMessage(tabId, { type: "inlineClose" }, { frameId: ctx.frameId }).catch(() => undefined);
  if (ctx.frameId !== 0) await chrome.tabs.sendMessage(tabId, { type: "inlineClose" }, { frameId: 0 }).catch(() => undefined);
}

const offerCreate = (ctx: InlineContext, logins: number) => ctx.kind === "login" && (ctx.signup || !logins);


/**
 * The user's own password or passphrase settings, unless the form limits what it accepts: then a password of the
 * user's length within those limits, from the site's character classes. A rule the generator cannot meet falls back
 * to the user's settings (the site may refuse it, but the user still gets a password).
 */
async function generateFor(ctx: InlineContext, options: GeneratorPrefs["options"]): Promise<string> {
  const plain = async () => coreCall<string>({ op: "generate", options: await withWordlist(options.type === "passphrase" ? options : { ...options, type: "password" }) });
  const ruled = ctx.password && ruleOptions(ctx.password, Number(options.length) || 14);
  if (!ruled) return plain();
  // One of each class at least: the user's own minimums (scaled up with a long length) could outgrow the site's maxlength.
  const mins = { minLowercase: 1, minUppercase: 1, minNumber: 1, minSpecial: 1 };
  return coreCall<string>({ op: "generate", options: { ...options, ...mins, ...ruled, type: "password" } }).catch(plain);
}

/** A new alias is offered on a registration form's fields, once a service is set up. */
const offerGenerate = (ctx: InlineContext) => ctx.kind === "login" && ctx.signup;
const offerAlias = async (ctx: InlineContext) => ctx.kind === "login" && ctx.signup && !!(await readyAliasVendor());

/**
 * "Use a private username": the username generator's own settings, for a registration form's account field when the
 * user picked private sign-up usernames. A plain word is no e-mail: an e-mail box gets a plus address of the
 * generator's e-mail instead, or no row. An alias service has its own row (offerAlias).
 */
async function privateUsername(ctx: InlineContext): Promise<Record<string, unknown> | undefined> {
  if (ctx.kind !== "login" || !ctx.signup || !ctx.account || (await getSettings()).signupUsernames !== "private") return undefined;
  const { options, email, domain } = await generatorPrefs();
  const chosen = String(options.usernameType || "word");
  const usernameType = ctx.account === "email" && chosen === "word" ? "plus" : chosen;
  if (!["word", "plus", "subdomain", "catchall"].includes(usernameType)) return undefined;
  // The generator's own rules, so the row onFocus counts is the row inlineList can fill.
  if ((usernameType === "catchall" && !domain.trim()) || ((usernameType === "plus" || usernameType === "subdomain") && emailAt(email.trim()) === undefined)) return undefined;
  return { type: "username", usernameType, email, domain, capitalize: options.capitalize === true, includeNumber: options.includeNumber === true };
}

async function onFocus(kind: FieldKind, nonce: string, signup: boolean, password: PasswordConstraints | undefined, account: InlineContext["account"], url: string, tabId: number, frameId: number): Promise<{ rows: number; footer?: boolean }> {
  if (!(await getSettings()).inlineMenu || !(await getLocal("account"))) return { rows: 0 };
  const ctx: InlineContext = { frameId, url, kind, nonce, signup, ...(password ? { password } : {}), ...(account ? { account } : {}) };
  await setTabState("inline", tabId, ctx);
  if (!(await isUnlocked())) return { rows: 1 }; // "Unlock to fill"
  if (await isBlocked(url, true)) return { rows: 0 };
  const logins = (await items(kind, url)).length;
  // A website waiting on a conditional passkey request gets one extra row for it.
  const passkey = kind === "login" && (await conditionalReady(tabId, frameId));
  // footer: the menu's "Manage passwords" row under the list, as in Chrome's own autofill dropdown.
  return { rows: logins + (passkey ? 1 : 0) + (offerCreate(ctx, logins) ? 1 : 0) + (offerGenerate(ctx) ? 1 : 0) + ((await privateUsername(ctx)) ? 1 : 0) + ((await offerAlias(ctx)) ? 1 : 0), footer: true };
}

interface Submitted {
  /** Replayed after an unlock (resumeSaves): a lock meanwhile ends it instead of keeping the password again. */
  resumed?: boolean;
  /** Warren generated the password into this page ("Use a strong password"). */
  generated?: boolean;
  /**
   * Asked at the fill, before the site took the password. Only a new login is shown then: an update waits for the
   * submit or the next page, so a password the site refuses never replaces the one that works.
   */
  beforeSubmit?: boolean;
  /** The form's other values, offered as the username (PageLogin.usernames). */
  usernames?: string[];
  /** With `beforeSubmit`: the form has an account box (PageLogin.accountBox), so no username yet means a new account. */
  accountBox?: boolean;
}

/** The user's most used account names (logins' usernames), for a new login's username list. */
async function frequentUsernames(n: number): Promise<string[]> {
  const counts = new Map<string, number>();
  for (const i of (await list()).items) if (i.type === 1 && !i.failed && i.sub) counts.set(i.sub, (counts.get(i.sub) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1]).slice(0, n).map(([u]) => u);
}

async function loginSubmitted(tabId: number, url: string, username: string, password: string, { resumed = false, generated = false, beforeSubmit = false, usernames = [], accountBox = false }: Submitted = {}) {
  const epoch = lockEpoch();
  const settings = await getSettings();
  const host = pageHost(url) ?? ""; // the form the site lists hold (private.ts)
  if (!settings.savePrompt) return;
  const origin = new URL(url).origin;
  // The first page of a two-step sign-in (Google, Microsoft, Okta): only an account name. Its password page,
  // on the same origin, names none: the account comes from here.
  if (!password) return username ? setTabState("ident", tabId, { origin, username, at: Date.now() }) : undefined;
  if (!username) {
    const ident = await getTabState("ident", tabId);
    if (ident && ident.origin === origin && Date.now() - ident.at < SAVE_TTL_MS) username = ident.username;
  }
  // The submit of a password Warren generated here: it stays the generated prompt (TTL, title), with the username it found.
  const earlier = await pendingSave(tabId);
  if (earlier?.generated && earlier.password === password && new URL(earlier.url).origin === origin) {
    generated = true;
    username ||= earlier.username;
    if (!usernames.length) usernames = earlier.usernames ?? [];
  }
  if (!(await isUnlocked())) {
    // Logged out: there is nothing to unlock. A replay that a lock overtook keeps nothing.
    if (resumed || !(await getLocal("account"))) return;
    // Kept until it expires or the next lock, like any pending save: the bar asks for an unlock, then decides.
    // (Never a generated password: generating needs the vault open, and a lock drops its prompt.)
    await setTabState("save", tabId, { kind: "locked", url, username, password, token: "", expiresAt: Date.now() + SAVE_TTL_MS, ...(usernames.length ? { usernames } : {}) });
    return showBar(tabId, epoch);
  }
  if ((await readPrivate()).neverSave.includes(host)) return;
  await ensureLoaded();
  // A page never updates a login it matched only through a regular expression (VaultItem.regexOnly).
  const matches = (await coreCall<VaultItem[]>({ op: "matchUri", url, defaultMatch: settings.defaultUriMatch })).filter((m) => !m.regexOnly);
  // Usernames compare case-insensitively, like the official clients ("Ali@x.com" is "ali@x.com"). A page
  // without one (the password step of a two-step sign-in) may be any of the site's logins.
  // A sign-up whose account box is still empty, at the fill: a new account, whatever the site's saved logins (a second
  // account there). A password reset has no such box, and stays "which of the logins".
  const newAccount = beforeSubmit && !username && accountBox;
  const sameUser = newAccount ? [] : username ? matches.filter((m) => m.sub.toLowerCase() === username.toLowerCase()) : matches;
  // A login whose password the organization hides is not the user's to change (or to compare) from a page either.
  const changeable = (m: VaultItem) => !m.readOnly && !m.hidesPassword;
  const editable = sameUser.filter(changeable);
  // Only read-only copies (e.g. an organization's): the login is saved already, never offer a duplicate.
  if (!editable.length && sameUser.length) return dropSave(tabId);
  // A flagged item is never compared or overwritten from inside a page: edit it in the popup.
  if (editable.some((m) => repromptPending(m))) return;
  const passwordOf = async (m: VaultItem) => (await coreCall<{ password: string }>({ op: "fillData", id: m.id })).password;
  // A saved login signing in: nothing to offer, and a save an earlier (mistyped) submit left waiting goes.
  for (const m of editable) if ((await passwordOf(m)) === password) return dropSave(tabId);
  const expiresAt = Date.now() + (generated ? GENERATED_TTL_MS : SAVE_TTL_MS);
  // The site's login saved without an account name (the bar's username left empty) and this very password: it is
  // this account, so it gets the name rather than a second copy.
  let unnamed: VaultItem | undefined;
  if (!editable.length && username)
    for (const m of matches)
      if (!m.sub && changeable(m) && !repromptPending(m) && (await passwordOf(m)) === password) {
        unnamed = m;
        break;
      }
  let pending: PendingSave;
  if (unnamed) pending = { kind: "update", url, username, password, itemId: unnamed.id, revisionDate: unnamed.revisionDate, addUsername: true, token: "", expiresAt };
  else if (!editable.length) {
    // The username list: what the form held, then the user's own most used names (an e-mail for a sign-up). Only a
    // hint: a vault list that fails never costs the prompt.
    const usual = settings.signupUsernames === "usual" ? await frequentUsernames(3).catch(() => []) : [];
    const offered = [...new Set([...usernames, ...usual])].filter((u) => u && u !== username).slice(0, 6);
    pending = { kind: "add", url, username, password, token: "", expiresAt, ...(offered.length ? { usernames: offered } : {}) };
  } else if (editable.length === 1) {
    const [m] = editable as [VaultItem];
    pending = { kind: "update", url, username: username || m.sub, password, itemId: m.id, revisionDate: m.revisionDate, token: "", expiresAt };
  } else {
    // Several logins (even with the same username), none with this password: the user says which one changed.
    const choices = editable.slice(0, MAX_CHOICES).map((m) => ({ id: m.id, name: m.name, sub: m.sub, ...(m.revisionDate ? { revisionDate: m.revisionDate } : {}) }));
    pending = { kind: "update", url, username, password, choices, token: "", expiresAt };
  }
  if (generated) pending.generated = true;
  // A lock while this was decided cleared the pending saves: the typed password must not come back after it.
  if (epoch !== lockEpoch()) return;
  if (beforeSubmit && pending.kind !== "add") pending.untilSubmit = true;
  await setTabState("save", tabId, pending);
  // A bar still up from an earlier prompt would now act on this one and fail (its token is gone): it goes.
  if (pending.untilSubmit) return void (await chrome.tabs.sendMessage(tabId, { type: "barHide" }, { frameId: 0 }).catch(() => undefined));
  await showBar(tabId, epoch);
}

/**
 * The save prompt for a password just generated into the frame of `ctx`: the account name is what the form already
 * holds (the user corrects it in the bar), the password the one Warren made, never the field's value read back.
 */
async function offerGeneratedSave(tabId: number, ctx: InlineContext, password: string) {
  const [read] = await pageCall<PageLogin | null>({ tabId, frameIds: [ctx.frameId] }, "readFocusedLogin", undefined).catch(() => []);
  const login = read?.result;
  let found = { username: "", usernames: [] as string[], accountBox: false };
  // The frame may have navigated since the fill. Its values pass the validator of the page's own submit report.
  if (login && URL.parse(login.url)?.origin === new URL(ctx.url).origin) {
    try {
      const r = parsePageRequest({ type: "loginSubmitted", username: login.username, password, usernames: login.usernames ?? [] }) as Extract<PageRequest, { type: "loginSubmitted" }>;
      found = { username: r.username, usernames: r.usernames ?? [], accountBox: login.accountBox === true };
    } catch {
      // nothing usable: the bar asks for the username
    }
  }
  await loginSubmitted(tabId, ctx.url, found.username, password, { generated: true, beforeSubmit: true, usernames: found.usernames, accountBox: found.accountBox });
}

/** After an unlock: logins submitted while locked are matched now, and get the save or update bar they need. */
export async function resumeSaves(): Promise<void> {
  const keys = Object.keys(await chrome.storage.session.get(null)).filter((k) => k.startsWith("save:"));
  for (const k of keys) {
    const tabId = Number(k.slice("save:".length));
    const p = await pendingSave(tabId);
    if (p?.kind !== "locked") continue;
    await dropSave(tabId);
    await loginSubmitted(tabId, p.url, p.username, p.password, { resumed: true, usernames: p.usernames ?? [] }).catch((e: unknown) => console.warn("resume save", e));
  }
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
  // A prompt made before the site took the password (the fill) waits for the submit, not for any page load.
  if (!p || p.untilSubmit) return;
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

/**
 * The tab shows the site the login was typed on: its origin, or after a sign-up's redirect another host of the same
 * registrable domain (accounts.example.com to example.com), on the same scheme. Without the suffix list, the origin.
 */
async function onSameSite(tabId: number, url: string): Promise<boolean> {
  let now: URL;
  try {
    now = new URL((await chrome.tabs.get(tabId)).url ?? "");
  } catch {
    return false; // no such tab, or a page we cannot read (chrome://, the web store)
  }
  const then = new URL(url);
  if (now.origin === then.origin) return true;
  if (now.protocol !== then.protocol || now.port !== then.port) return false;
  const psl = await publicSuffixes().catch(() => undefined);
  return !!psl && psl.baseDomain(now.hostname) === psl.baseDomain(then.hostname) && !psl.isPublicSuffix(psl.baseDomain(then.hostname));
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
    if (req.type === "barInfo")
      return {
        kind: p.kind,
        host: new URL(p.url).host,
        username: p.username,
        ...(p.choices ? { choices: p.choices.map(({ id, name, sub }) => ({ id, name, sub })) } : {}),
        ...(p.generated ? { generated: true as const } : {}),
        ...(p.kind === "add" && p.usernames?.length ? { usernames: p.usernames } : {}),
        ...(p.addUsername ? { addUsername: true as const } : {}),
      } satisfies BarInfo;
    if (req.action === "unlock") {
      await chrome.action.openPopup().catch(() => undefined);
      return null; // the prompt stays: resumeSaves picks it up after the unlock
    }
    if (p.kind === "locked" && req.action !== "close") return null; // nothing to save or block before the vault is open
    if (req.action === "never") {
      const host = pageHost(p.url);
      if (host) await updatePrivate((d) => (d.neverSave = [...d.neverSave.filter((h) => h !== host), host]));
    } else if (req.action === "save") {
      if (p.kind === "update") {
        // One of the logins this prompt offered, never an id the bar makes up.
        const choice = p.itemId ? { id: p.itemId, revisionDate: p.revisionDate } : p.choices?.find((c) => c.id === req.itemId);
        if (!choice) throw new UserError("invalid", msg("errPickTheLoginToUpdate"));
        // flagged after the prompt was queued
        if (repromptPending(await coreCall<VaultItem>({ op: "cipherSummary", id: choice.id }))) throw new Error(REPROMPT_MESSAGE);
        // Against the revision the prompt was made for: an older prompt never undoes a newer password.
        // A login that lacked a username gets the one the bar shows (the user may correct it); others keep theirs.
        const username = p.addUsername ? (req.username ?? p.username) : undefined;
        await saveEncrypted(await coreCall<Record<string, unknown>>({ op: "preparePassword", id: choice.id, password: p.password, revisionDate: choice.revisionDate, ...(username === undefined ? {} : { username }) }));
      } else {
        const u = new URL(p.url);
        // The bar lets the user correct the username of a new login before it is saved.
        await save({ type: 1, name: u.hostname, login: { username: req.username ?? p.username, password: p.password, uris: [{ uri: u.origin, match: null }] } });
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
    // "Unlock to fill": the fill follows the unlock (resumeFill).
    if (!(await isUnlocked())) await rememberLockedFill(await chrome.tabs.get(tabId).catch(() => undefined));
    await chrome.action.openPopup().catch(() => undefined);
    return null;
  }
  if (req.type === "inlinePasskey") {
    await touchAutoLock(); // a pick counts as activity
    await openConditional(tabId, ctx.frameId);
    return null;
  }
  if (!(await isUnlocked())) return { kind: ctx.kind, locked: true, items: [], passkey: false, create: false, alias: false, generate: false } satisfies MenuData;
  if (req.type === "inlineBlock") {
    const host = pageHost(ctx.url);
    if (host) await updatePrivate((d) => (d.blocked = [...d.blocked.filter((h) => h !== host), host]));
    await closeMenu(tabId, ctx);
    return null;
  }
  if (req.type === "inlineNewLogin") {
    await touchAutoLock();
    await updateSession({ newLogin: new URL(ctx.url).origin });
    await chrome.action.openPopup().catch(() => updateSession({ newLogin: undefined }));
    return null;
  }
  if (req.type === "inlineGenerate") {
    if (!offerGenerate(ctx)) throw new Error("not a registration form");
    await touchAutoLock();
    // The user's own password or passphrase settings; a username-generator setting gets a default password.
    // The password the menu showed, if it is this document's; a fresh one otherwise.
    const shown = await getTabState("suggest", tabId);
    await setTabState("suggest", tabId, undefined);
    const password = (shown?.nonce === ctx.nonce && shown.password) || (await generateFor(ctx, (await generatorPrefs()).options));
    // Kept like any generated value, so it is not lost if the page never submits.
    await addGeneratorHistory(password);
    await closeMenu(tabId, ctx);
    const origin = new URL(ctx.url).origin;
    // The new and confirm fields of this frame's form; no username, no submit.
    const [res] = await fillInFrames(tabId, { frameIds: [ctx.frameId] }, { mode: "login", origin, username: "", password, passwordOnly: true, epoch });
    await setTabState("inline", tabId, undefined);
    // Asked now, not only on submit: a sign-up that submits in a way the page hides (or never navigates) would
    // otherwise leave the account with a password no one saved. The submit later refreshes the username.
    if (res?.result.filled) await offerGeneratedSave(tabId, ctx, password);
    return res?.result ?? { filled: false };
  }

  if (req.type === "inlineUsername") {
    const naming = await privateUsername(ctx);
    if (!naming) throw new Error("no private username is offered here");
    await touchAutoLock();
    // The name the menu showed, if it is this document's; a fresh one otherwise.
    const shown = await getTabState("suggest", tabId);
    await setTabState("suggest", tabId, undefined);
    const username = (shown?.nonce === ctx.nonce && shown.username) || (await coreCall<string>({ op: "generate", options: naming }));
    await addGeneratorHistory(username);
    await closeMenu(tabId, ctx);
    const res = await fillActiveField(tabId, ctx.frameId, { origin: new URL(ctx.url).origin, value: username, epoch });
    await setTabState("inline", tabId, undefined);
    return res ?? { filled: false };
  }

  const available = await items(ctx.kind, ctx.url);
  const passkey = ctx.kind === "login" && (await conditionalReady(tabId, ctx.frameId));
  if (req.type === "inlineList") {
    const generate = offerGenerate(ctx);
    // Shown in the row, then filled by it: the user sees what the site gets, as in Chrome's dropdown.
    const suggested = generate ? await generateFor(ctx, (await generatorPrefs()).options).catch(() => undefined) : undefined;
    const naming = await privateUsername(ctx);
    const username = naming ? await coreCall<string>({ op: "generate", options: naming }).catch(() => undefined) : undefined;
    if ((suggested || username) && epoch === lockEpoch()) await setTabState("suggest", tabId, { nonce: ctx.nonce, ...(suggested ? { password: suggested } : {}), ...(username ? { username } : {}) });
    return {
      kind: ctx.kind,
      locked: false,
      items: available,
      passkey,
      create: offerCreate(ctx, available.length),
      alias: await offerAlias(ctx),
      generate,
      ...(suggested ? { suggested } : {}),
      ...(username ? { username } : {}),
    } satisfies MenuData;
  }

  if (req.type === "inlineAlias") {
    const vendor = (await offerAlias(ctx)) ? await readyAliasVendor() : undefined;
    if (!vendor) throw new Error("no e-mail alias service is set up");
    await touchAutoLock();
    // The service is asked for the tab's site (generateAlias reads the active tab), never for a URL from the page.
    const alias = await generateAlias(vendor);
    await closeMenu(tabId, ctx);
    const res = await fillActiveField(tabId, ctx.frameId, { origin: new URL(ctx.url).origin, value: alias, epoch });
    await setTabState("inline", tabId, undefined);
    return res ?? { filled: false };
  }

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
  await closeMenu(tabId, ctx);
  const origin = new URL(ctx.url).origin;
  let res: FillResult | undefined;
  if (ctx.kind === "login") {
    const { username, password, totp } = await coreCall<{ username: string; password: string; totp?: string }>({ op: "fillData", id: req.id });
    const { autosubmit } = await getSettings();
    res = (await fillInFrames(tabId, { frameIds: [ctx.frameId] }, { mode: "login", origin, username, password, totp, autosubmit, customFields: await customFieldsOf(req.id), epoch }))[0]?.result;
    if (res?.filled) {
      await markUsed(req.id);
      await rememberFill(tabId, origin, req.id);
      if (totp && (await getSettings()).autoCopyTotp && epoch === lockEpoch()) await copyToClipboard(totp);
    }
  } else {
    const values = await coreCall<Record<string, string>>({ op: "formValues", id: req.id });
    // A checkout that puts each card field in its own frame (number, expiry, code): a pick in one of them fills the
    // frames on that frame's origin. Frames on any other origin are refused by fillInFrames, so nothing leaves it.
    const target = ctx.frameId === 0 ? { frameIds: [0] } : ({ allFrames: true } as const);
    const results = await fillInFrames(tabId, target, { mode: "form", origin, values, customFields: await customFieldsOf(req.id), epoch });
    res = results.find((r) => r.frameId === ctx.frameId)?.result;
    if (!res?.filled) res = results.find((r) => r.result.filled)?.result ?? res;
  }
  await setTabState("inline", tabId, undefined);
  return res ?? { filled: false };
}
