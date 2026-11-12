// Service worker entry. Stateless: listeners are registered synchronously at top level, every
// handler reads its state from chrome.storage.
import { KDF_ARGON2ID } from "../shared/constants.ts";
import { type ErrorCode, PASSKEY_PORT, type PageRequest, parseFrameRequest, parsePageRequest, parseRequest, type Request, type Response, type State, type VaultItem } from "../shared/messages.ts";
import { ValidationError } from "../shared/validate.ts";
import { getServerInfo } from "../transport/config.ts";
import { httpUrl, normalizeServerUrl } from "../shared/url.ts";
import { NetworkError } from "../transport/http.ts";
import {
  answerLoginRequest,
  auth,
  cancelTwoFactor,
  checkDeviceLogin,
  confirmReprompt,
  dropLoginRequest,
  loginRequests,
  finishSso,
  login,
  PENDING_ALARM,
  removeBiometric,
  setBiometric,
  setPin,
  startDeviceLogin,
  startSso,
  logout,
  relocateRefreshToken,
  sendTwoFactorEmail,
  submitTwoFactor,
  startDuo,
  duoTabUpdated,
  unlock,
  unlockWithBiometric,
  unlockWithPin,
  UserError,
} from "./account.ts";
import { HUB, type HubUpdate } from "../transport/hub.ts";
import { PUSH_ALARM, pushUp, startPush, stopPush } from "./push.ts";
import { REPROMPT_MESSAGE, repromptGranted, repromptPending } from "./reprompt.ts";
import { coreAlive, coreCall } from "./core.ts";
import { safeKdf } from "./kdf.ts";
import { AUTOLOCK_ALARM, lockNow, ownerEpoch, touchAutoLock } from "./lock.ts";
import {
  getLocal,
  getSession,
  getSettings,
  clearTabState,
  restrictStorageAccess,
  setDefaultManager,
  setLocal,
  updateSession,
  updateSettings,
} from "./store.ts";
import { generatorPrefs, hostOf, readPrivate, setGeneratorPrefs, setWordlist, updatePrivate, withWordlist } from "./private.ts";
import { handleFrame, handlePage, showBar } from "./inline.ts";
import { ensurePasskeyScripts, onPasskeyPort, onWindowRemoved, passkeyDecision, passkeyPrompt } from "./passkey.ts";
import { startFieldPicker, takeFieldPick } from "./picker.ts";
import { AUTOFILL_COMMAND, autofillFromGesture, fillShownTab, onContextMenu, pageMatches, readPageLogin, updateTabUi } from "./autofill.ts";
import { generateAlias, getAliasSettings, saveAliasSettings } from "./alias.ts";
import { archive, addAttachment, breachEmails, deleteAttachment, moveToOrg, setCollections, addGeneratorHistory, CLIPBOARD_ALARM, downloadAttachment, exportVault, importVault, clearClipboard, clearGeneratorHistory, deleteFolder, generatorHistory, isUnlocked, deleteSend, getSend, purge, removeSendPassword, restore, saveFolder, scheduleClipboardClear, list as vaultList, requireUnlocked, save, saveSend, sendList, sync, trash } from "./vault.ts";

async function getState(): Promise<State> {
  const [server, account, session, settings, vault, bio] = await Promise.all([
    getLocal("server"),
    getLocal("account"),
    getSession(),
    getSettings(),
    getLocal("vault"),
    getLocal("biometric"),
  ]);
  const base = { settings, serverUrl: server?.url, serverVersion: server?.version, syncedAt: vault?.syncedAt, ...(session.ssoError ? { ssoError: session.ssoError } : {}) };
  if (!server) return { phase: "setup", ...base };
  if (session.pending && session.pending.expiresAt > Date.now())
    return { phase: "twoFactor", ...base, email: session.pending.email, twoFactor: session.pending.challenge };
  if (session.deviceLogin && session.deviceLogin.expiresAt > Date.now())
    return { phase: "deviceLogin", ...base, email: session.deviceLogin.email, fingerprint: session.deviceLogin.fingerprint };
  // An abandoned login attempt (popup closed mid-2FA) still holds a derived master key in the crypto
  // worker: drop it as soon as we notice it has expired.
  if (session.pending) await cancelTwoFactor();
  if (!account) return { phase: "loggedOut", ...base };
  let unlocked = session.unlocked;
  if (unlocked && !(await coreAlive())) {
    // The offscreen document (and with it the keys) is gone, e.g. after an extension reload.
    await updateSession({ unlocked: false });
    unlocked = false;
  }
  const pin = { weakKdf: account.kdf.type !== KDF_ARGON2ID || !safeKdf(account.kdf), pinSet: !!account.protectedPin, pinUnlock: !!account.protectedPin && (!!account.pinKey || session.pin?.email === account.email) };
  const biometric = bio && bio.email === account.email ? { credentialId: bio.credentialId, prfSalt: bio.prfSalt } : undefined;
  // The never-save list is encrypted: it is only there to show (and edit) while the vault is open.
  if (unlocked) Object.assign(base.settings, await readPrivate().then((d) => ({ neverSave: d.neverSave, blocked: d.blocked }), () => ({})));
  const requests = session.loginRequests?.length ?? 0;
  return { phase: unlocked ? "unlocked" : "locked", ...base, ...pin, ...(biometric ? { biometric } : {}), ...(requests ? { loginRequests: requests } : {}), email: account.email };
}

async function setServer(input: string): Promise<void> {
  let url: string;
  try {
    url = normalizeServerUrl(input);
  } catch (e) {
    throw new UserError("invalid", (e as Error).message);
  }
  const info = await getServerInfo(url).catch((e: unknown) => {
    if (e instanceof NetworkError) throw e;
    throw new UserError("badServer", "This does not look like a Vaultwarden server");
  });
  const previous = await getLocal("server");
  if (previous && previous.url !== url) await logout();
  await setLocal("server", { url, version: info.version, name: info.name });
}

/** Vault requests return their own data; everything else returns the new State. */
async function handle(req: Request): Promise<unknown> {
  switch (req.type) {
    case "vaultList":
    case "sync":
    case "getItem":
    case "saveItem":
    case "moveToOrg":
    case "setCollections":
    case "deleteItem":
    case "restoreItem":
    case "archiveItem":
    case "securityReport":
    case "exposedRange":
    case "breachEmails":
    case "unarchiveItem":
    case "purgeItem":
    case "downloadAttachment":
    case "addAttachment":
    case "deleteAttachment":
    case "exportVault":
    case "importVault":
    case "saveFolder":
    case "deleteFolder":
    case "generate":
    case "aliasSettings":
    case "setAliasSettings":
    case "generateAlias":
    case "generatorHistory":
    case "generatorHistoryAdd":
    case "generatorHistoryClear":
    case "itemOpened":
    case "clearOpened":
    case "generatorPrefs":
    case "setGeneratorPrefs":
    case "setWordlist":
    case "sendList":
    case "getSend":
    case "saveSend":
    case "deleteSend":
    case "removeSendPassword": {
      await requireUnlocked();
      if (!(req.type === "vaultList" && req.passive)) await touchAutoLock();
      if (req.type === "vaultList") return vaultList();
      if (req.type === "sync") return (await sync(req.force)) ? vaultList() : null;
      if (req.type === "getItem") {
        // A flagged item does not leave the worker until the master password is re-entered.
        if (repromptPending(await coreCall<VaultItem>({ op: "cipherSummary", id: req.id }))) throw new UserError("reprompt", REPROMPT_MESSAGE);
        return coreCall({ op: "getCipher", id: req.id });
      }
      if (req.type === "saveItem") return save(req.item, req.collectionIds);
      if (req.type === "moveToOrg") return moveToOrg(req.id, req.organizationId, req.collectionIds);
      if (req.type === "setCollections") return setCollections(req.id, req.collectionIds);
      if (req.type === "deleteItem") return trash(req.id);
      if (req.type === "restoreItem") return restore(req.id);
      if (req.type === "securityReport") return coreCall({ op: "securityReport" });
      if (req.type === "breachEmails") return breachEmails(req.emails);
      if (req.type === "exposedRange") return coreCall({ op: "exposedRange", prefix: req.prefix, body: req.body });
      if (req.type === "archiveItem" || req.type === "unarchiveItem") return archive(req.id, req.type === "archiveItem");
      if (req.type === "purgeItem") return purge(req.id);
      if (req.type === "downloadAttachment") return downloadAttachment(req.cipherId, req.attachmentId);
      if (req.type === "addAttachment") return addAttachment(req.cipherId, req.file);
      if (req.type === "deleteAttachment") return deleteAttachment(req.cipherId, req.attachmentId);
      if (req.type === "exportVault") return exportVault(req.password, req.format, req.filePassword);
      if (req.type === "importVault") return importVault(req.text, req.password);
      if (req.type === "saveFolder") return saveFolder(req.name, req.id);
      if (req.type === "deleteFolder") return deleteFolder(req.id);
      if (req.type === "aliasSettings") return getAliasSettings(req.vendor);
      if (req.type === "setAliasSettings") return saveAliasSettings(req.settings);
      if (req.type === "generateAlias") return generateAlias(req.vendor);
      if (req.type === "generatorHistory") return generatorHistory();
      if (req.type === "generatorHistoryAdd") return addGeneratorHistory(req.value);
      if (req.type === "generatorHistoryClear") return clearGeneratorHistory();
      if (req.type === "itemOpened")
        return updatePrivate((d) => (d.opened[req.id] = { n: (d.opened[req.id]?.n ?? 0) + 1, at: Date.now() })).then(() => null);
      if (req.type === "clearOpened") return updatePrivate((d) => (d.opened = {})).then(() => null);
      if (req.type === "generatorPrefs") return generatorPrefs();
      if (req.type === "setGeneratorPrefs") return setGeneratorPrefs(req);
      if (req.type === "setWordlist") return setWordlist(req.text);
      if (req.type === "sendList") return sendList();
      if (req.type === "getSend") return getSend(req.id);
      if (req.type === "saveSend") return saveSend(req.send, req.file);
      if (req.type === "deleteSend") return deleteSend(req.id);
      if (req.type === "removeSendPassword") return removeSendPassword(req.id);
      return coreCall({ op: "generate", options: await withWordlist(req.options) });
    }
    case "totp": {
      // No touchAutoLock: an open item refreshes its code on a timer, which must not keep the vault unlocked.
      await requireUnlocked();
      if (repromptPending(await coreCall<VaultItem>({ op: "cipherSummary", id: req.id }))) throw new UserError("reprompt", REPROMPT_MESSAGE);
      return coreCall({ op: "totp", id: req.id });
    }
    case "takeNewLogin": {
      const { newLogin } = await getSession();
      if (newLogin) await updateSession({ newLogin: undefined });
      return newLogin ?? null;
    }
    case "startFieldPicker":
      await requireUnlocked();
      await touchAutoLock();
      return startFieldPicker(req.draft, req.panel);
    case "takeFieldPick":
      await requireUnlocked();
      return takeFieldPick();
    case "pageMatches":
    case "fill":
    case "readPageLogin":
      await requireUnlocked();
      if (!(req.type === "pageMatches" && req.passive)) await touchAutoLock();
      if (req.type === "pageMatches") return pageMatches();
      if (req.type === "fill") return fillShownTab(req.id, req.tabId, req.origin, req.anyway);
      return readPageLogin(req.tabId, req.origin);
    case "clipboardCopied":
      await scheduleClipboardClear(req.hash);
      return null;
    case "getState":
      break;
    case "setServer":
      await setServer(req.url);
      break;
    case "login":
      await login(req.email, req.password);
      break;
    case "twoFactorSubmit":
      await submitTwoFactor(req.provider, req.token, req.remember);
      break;
    case "twoFactorDuo":
      await startDuo(req.remember);
      break;
    case "twoFactorSendEmail":
      await sendTwoFactorEmail();
      break;
    case "twoFactorCancel":
      await cancelTwoFactor();
      break;
    case "ssoStart":
      await startSso();
      break;
    case "deviceLogin":
      await startDeviceLogin(req.email);
      break;
    case "deviceLoginCheck":
      await checkDeviceLogin();
      break;
    case "loginRequests":
      await requireUnlocked();
      return loginRequests();
    case "answerLoginRequest":
      await requireUnlocked();
      await answerLoginRequest(req.id, req.approve, req.fingerprint);
      return loginRequests().finally(clearLoginNote);
    case "unlock":
      await unlock(req.password);
      break;
    case "unlockPin":
      await unlockWithPin(req.pin);
      break;
    case "unlockBiometric":
      await unlockWithBiometric(req.prf);
      break;
    case "setBiometric":
      await requireUnlocked();
      await setBiometric(req.credentialId, req.prfSalt, req.prf);
      break;
    case "removeBiometric":
      await requireUnlocked();
      await removeBiometric();
      break;
    case "setPin":
      await requireUnlocked();
      await setPin(req.pin, req.pinOnly);
      break;
    case "confirmReprompt":
      await requireUnlocked();
      await confirmReprompt(req.id, req.password);
      break;
    case "repromptGranted":
      // No touchAutoLock: an item left open on screen must not keep the vault unlocked.
      await requireUnlocked();
      return repromptGranted(req.id);
    case "lock":
      await lockNow();
      break;
    case "logout":
      await logout();
      break;
    case "passkeyPrompt":
      return passkeyPrompt(req.id);
    case "passkeyDecision":
      return passkeyDecision(req.id, req.action, req.itemId, req.credentialId, req.replace === true, req.password);
    case "setSettings": {
      await updateSettings((current) => ({
        autoLockMinutes: req.autoLockMinutes ?? current.autoLockMinutes,
        timeoutAction: req.timeoutAction ?? current.timeoutAction,
        lockOnSystemLock: req.lockOnSystemLock ?? current.lockOnSystemLock,
        inlineMenu: req.inlineMenu ?? current.inlineMenu,
        savePrompt: req.savePrompt ?? current.savePrompt,
        favicons: req.favicons ?? current.favicons,
        autoCopyTotp: req.autoCopyTotp ?? current.autoCopyTotp,
        defaultUriMatch: req.defaultUriMatch ?? current.defaultUriMatch,
        clearClipboardDelay: req.clearClipboardDelay ?? current.clearClipboardDelay,
        autofillOnPageLoad: req.autofillOnPageLoad ?? current.autofillOnPageLoad,
        autofillOnPageLoadDefault: req.autofillOnPageLoadDefault ?? current.autofillOnPageLoadDefault,
        autosubmit: req.autosubmit ?? current.autosubmit,
        inlineMenuCards: req.inlineMenuCards ?? current.inlineMenuCards,
        inlineMenuIdentities: req.inlineMenuIdentities ?? current.inlineMenuIdentities,
        contextMenu: req.contextMenu ?? current.contextMenu,
        showCardsOnTab: req.showCardsOnTab ?? current.showCardsOnTab,
        showIdentitiesOnTab: req.showIdentitiesOnTab ?? current.showIdentitiesOnTab,
        quickActionMenus: req.quickActionMenus ?? current.quickActionMenus,
        badgeCounter: req.badgeCounter ?? current.badgeCounter,
      }));
      if (req.timeoutAction) await relocateRefreshToken();
      if (req.clearNeverSave || req.removeNeverSave || req.addNeverSave || req.addBlocked || req.removeBlocked) {
        await requireUnlocked(); // the lists are encrypted
        const add = (v: string | undefined) => {
          const host = v === undefined ? undefined : hostOf(v);
          if (v !== undefined && !host) throw new UserError("invalid", "Enter a website such as example.com");
          return host;
        };
        const never = add(req.addNeverSave);
        const blocked = add(req.addBlocked);
        await updatePrivate((d) => {
          if (req.clearNeverSave) d.neverSave = [];
          if (req.removeNeverSave) d.neverSave = d.neverSave.filter((h) => h !== req.removeNeverSave);
          if (never) d.neverSave = [...d.neverSave.filter((h) => h !== never), never];
          if (req.removeBlocked) d.blocked = d.blocked.filter((h) => h !== req.removeBlocked);
          if (blocked) d.blocked = [...d.blocked.filter((h) => h !== blocked), blocked];
        });
      }
      break;
    }
    case "setDefaultManager":
      await setDefaultManager(req.enabled);
      break;
  }
  const state = await getState();
  if (state.phase === "unlocked") await touchAutoLock();
  if (state.phase === "unlocked" || state.phase === "locked") void ensurePush().catch(() => undefined);
  return state;
}

function toError(e: unknown): Response<unknown> {
  let code: ErrorCode | undefined;
  let error = e instanceof Error ? e.message : String(e);
  if (e instanceof UserError) code = e.code;
  else if (e instanceof ValidationError) code = "invalid";
  else if (e instanceof NetworkError) {
    code = "network";
    error = "Cannot reach the server. Check your connection and the server address.";
  } else console.error(e);
  return { ok: false, error, ...(code ? { code } : {}) };
}

/**
 * Our own extension page behind `url`, as a path. Matched by path, not by a compare against
 * `chrome.runtime.getURL()`: menu.html/bar.html are web-accessible resources with `use_dynamic_url`,
 * so `getURL()` returns a per-session dynamic id while `sender.url` carries the static one.
 */
const extensionPath = (url: string | undefined): string | undefined => {
  if (!url?.startsWith("chrome-extension://")) return undefined;
  try {
    return new URL(url).pathname;
  } catch {
    return undefined;
  }
};

const UI_PATHS = ["/popup.html", "/sidepanel.html"];
const FRAME_PATHS = ["/menu.html", "/bar.html"];

// Serialize state-changing requests so e.g. a double-clicked "Log in" cannot interleave.
let queue: Promise<unknown> = Promise.resolve();
/** Submitted logins waiting in `queue`, at most one per tab (the latest). */
const submits = new Map<number, { req: PageRequest; sender: chrome.runtime.MessageSender }>();

chrome.runtime.onMessage.addListener((msg: unknown, sender, reply: (r: Response<unknown>) => void) => {
  // The SSO callback content script (registered only for <server>/sso-connector.html during a login).
  if (sender.id === chrome.runtime.id && sender.tab?.id !== undefined && sender.url && (msg as { type?: unknown } | null)?.type === "ssoCallback") {
    const [url, tabId] = [sender.url, sender.tab.id];
    queue = queue.then(() => finishSso(url, tabId)).catch((e: unknown) => console.error(e));
    return false;
  }
  // URL check is enough: our pages are not web-accessible, so only the extension can load them (also when opened in a tab).
  if (sender.id !== chrome.runtime.id) return false;
  const tabId = sender.tab?.id;
  // Our menu/bar iframes inside a website tab, and the content script on that website.
  const frame = FRAME_PATHS.includes(extensionPath(sender.url) ?? "");
  if (tabId !== undefined && (frame || httpUrl(sender))) {
    let run: () => Promise<unknown>;
    let read: boolean;
    try {
      if (frame) {
        const req = parseFrameRequest(msg);
        run = () => handleFrame(req, tabId);
        read = req.type === "inlineList" || req.type === "barInfo";
      } else {
        const req = parsePageRequest(msg);
        read = req.type === "inlineFocus";
        if (req.type === "loginSubmitted") {
          // A page can fire submits in a loop: keep one queued per tab, carrying the latest values.
          const queued = submits.has(tabId);
          submits.set(tabId, { req, sender });
          if (queued) {
            reply({ ok: true, data: null });
            return false;
          }
          run = () => {
            const latest = submits.get(tabId)!;
            submits.delete(tabId);
            return handlePage(latest.req, latest.sender);
          };
        } else run = () => handlePage(req, sender);
      }
    } catch (e) {
      reply(toError(e));
      return false;
    }
    const go = () => run().then((data) => reply({ ok: true, data } as Response<unknown>), (e: unknown) => reply(toError(e)));
    // Menu reads must not wait behind an unlock (Argon2id) or a sync; fills and saves stay in order.
    // A page-load opportunity changes nothing the badge or menu shows, so it skips the refresh.
    const refresh = () => (frame || (msg as { type?: unknown }).type !== "pageLoad" ? updateTabUi() : undefined);
    if (read) void go();
    else queue = queue.then(go, go).then(refresh);
    return true;
  }
  if (!UI_PATHS.includes(extensionPath(sender.url) ?? "")) return false;
  if ((msg as { target?: unknown } | null)?.target !== undefined) return false; // offscreen traffic
  let req: Request;
  try {
    req = parseRequest(msg);
  } catch (e) {
    reply(toError(e));
    return false;
  }
  const run = () => handle(req).then((data) => reply({ ok: true, data } as Response<unknown>), (e: unknown) => reply(toError(e)));
  // Reads run immediately; anything that changes state or talks to the server is queued, and may
  // change what the badge and the context menu show (unlock, lock, sync, edits).
  if (["getState", "loginRequests", "vaultList", "getItem", "totp", "generate", "aliasSettings", "generatorHistory", "downloadAttachment", "pageMatches", "takeNewLogin", "takeFieldPick", "readPageLogin", "sendList", "getSend", "passkeyPrompt", "repromptGranted"].includes(req.type)) void run();
  // Locking must not wait behind a slow server call: it ends whatever is running by killing the worker.
  else if (req.type === "lock") void run().then(updateTabUi);
  else queue = queue.then(run, run).then(updateTabUi);
  return true;
});

/** Auto-lock, system lock and browser restart: lock, or log out if the user chose that. */
const timeout = async () => {
  await ((await getSettings()).timeoutAction === "logout" ? logout() : lockNow());
  await updateTabUi();
};

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTOLOCK_ALARM) void timeout();
  if (alarm.name === CLIPBOARD_ALARM) void clearClipboard();
  if (alarm.name === PENDING_ALARM) void cancelTwoFactor();
  if (alarm.name === PUSH_ALARM) void ensurePush();
});

// ---------- push (Vaultwarden WebSocket hub) ----------

const LOGIN_REQUEST_NOTE = "loginRequest";
let pushSync: ReturnType<typeof setTimeout> | undefined;

/** Connects the hub while an account is logged in; a no-op when it is up. */
async function ensurePush(): Promise<void> {
  const epoch = ownerEpoch();
  const [server, account] = await Promise.all([getLocal("server"), getLocal("account")]);
  if (!server || !account) return stopPush();
  const owner = `${server.url}|${account.email}`;
  if (pushUp(owner)) return;
  try {
    // Server, account and token read under one owner (auth checks it): the same email on two servers is two owners.
    const { token } = await auth(epoch);
    // An update for an account that is gone (a login or logout since) changes nothing.
    startPush(server.url, owner, token, (u) => {
      if (epoch === ownerEpoch()) void onPush(u).catch((e: unknown) => console.error(e));
    });
  } catch {
    /* offline or the session ended: PUSH_ALARM tries again */
  }
}

async function clearLoginNote(): Promise<void> {
  if (!(await getSession()).loginRequests?.length) await chrome.notifications.clear(LOGIN_REQUEST_NOTE);
}

async function onPush(u: HubUpdate): Promise<void> {
  if (u.contextId && u.contextId === (await getLocal("deviceId"))) return; // our own change
  if (u.type === HUB.LogOut) {
    // The password changed or all sessions were deauthorized: our tokens are dead.
    queue = queue.then(logout).catch((e: unknown) => console.error(e)).then(updateTabUi);
  } else if (u.type === HUB.AuthRequest && u.id) {
    const { loginRequests: ids = [] } = await getSession();
    if (!ids.includes(u.id)) await updateSession({ loginRequests: [...ids, u.id] });
    const account = await getLocal("account");
    chrome.notifications.create(LOGIN_REQUEST_NOTE, {
      type: "basic",
      iconUrl: "icons/warren-128.png",
      title: chrome.i18n.getMessage("loginRequestTitle"),
      message: chrome.i18n.getMessage("loginRequestNote", account?.email ?? ""),
      requireInteraction: true,
      priority: 2,
    });
  } else if (u.type === HUB.AuthRequestResponse && u.id) {
    await dropLoginRequest(u.id);
    await clearLoginNote();
  } else if (u.type < HUB.AuthRequest) {
    // A burst of changes (an import, a bulk move) syncs once. Locked: the next unlock syncs anyway.
    clearTimeout(pushSync);
    pushSync = setTimeout(() => {
      queue = queue
        .then(async () => (await isUnlocked()) && sync(false))
        .catch((e: unknown) => console.error(e))
        .then(updateTabUi);
    }, 1000);
  }
}

chrome.notifications.onClicked.addListener((id) => {
  if (id !== LOGIN_REQUEST_NOTE) return;
  void chrome.notifications.clear(id);
  void chrome.action.openPopup().catch(() => chrome.windows.create({ url: "popup.html", type: "popup", width: 400, height: 640 }));
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === PASSKEY_PORT) onPasskeyPort(port);
});

chrome.windows.onRemoved.addListener(onWindowRemoved);

chrome.tabs.onRemoved.addListener((tabId) => void clearTabState(tabId));

// A login is usually submitted right before a navigation: show the save bar once the next page is there.
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url) void duoTabUpdated(tabId, info.url).catch((e: unknown) => console.error(e));
  if (info.status !== "complete") return;
  // In line with the bar's own Save and Close: a show that read the prompt before them must not bring it back.
  queue = queue.then(() => showBar(tabId)).catch((e: unknown) => console.error(e));
  if (tab.active) void updateTabUi();
});

chrome.tabs.onActivated.addListener(() => void updateTabUi());
chrome.windows.onFocusChanged.addListener((windowId) => {
  if (windowId !== chrome.windows.WINDOW_ID_NONE) void updateTabUi();
});

chrome.idle.onStateChanged.addListener(async (state) => {
  if (state === "locked" && (await getSettings()).lockOnSystemLock) await timeout();
});

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === AUTOFILL_COMMAND) void autofillFromGesture(tab);
});

chrome.contextMenus.onClicked.addListener((info, tab) => void onContextMenu(info, tab));

chrome.runtime.onInstalled.addListener(() => {
  void restrictStorageAccess();
  void ensurePasskeyScripts(); // passkeys are always on, like the official clients
  void updateTabUi();
});

// Test-only hook (commands and context menus cannot be triggered from automation); compiled out otherwise.
declare const E2E: boolean;
if (E2E) Object.assign(globalThis, { warrenTest: { autofillFromGesture, onContextMenu } });
chrome.runtime.onStartup.addListener(() => {
  void restrictStorageAccess();
  void ensurePasskeyScripts();
  // The restart already locked the vault (session storage is gone); "log out" goes one step further.
  void timeout();
});

// Reconnect the hub on every worker start; the alarm keeps trying after that.
void ensurePush().catch((e: unknown) => console.error(e));
// Also on a plain service-worker start (registration is idempotent): covers a fresh install where the
// worker was already running, and browsers that drop registered scripts.
void ensurePasskeyScripts().catch((e: unknown) => console.error(e));
// Content scripts must never be able to read our storage: apply the level on every worker start, so a
// cold start that precedes onStartup cannot leave the cache readable by a page.
void restrictStorageAccess();
