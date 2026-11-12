// Typed message bus. Every message crossing a context boundary is validated on receipt.
//   popup  --Request-->  service worker  --OffscreenRequest-->  offscreen doc  --postMessage-->  worker
import { ALIAS_VENDORS, type AliasSettings, type AliasVendor } from "./alias.ts";
import { AUTO_LOCK_CHOICES, CLEAR_CLIPBOARD_CHOICES, type ClearClipboardDelay, EXPORT_FORMATS, URI_MATCH_CHOICES } from "./constants.ts";
import { MAX_BLOCK_PATH, MAX_BUTTONS, MAX_DATA_ATTRS, MAX_FIELDS, MAX_FORM_TEXT, MAX_FORMS, MAX_PAGE_STRING } from "./page-limits.ts";
import { arr, bool, literal, num, obj, opt, record, str, u32, unknownValue, type Validator, ValidationError } from "./validate.ts";

// ---------- size caps ----------
// Anything a page, a server or a file can make arbitrarily large is bounded at the boundary.

/** A page-controlled form value: big enough for any real credential, small enough to bound storage. */
const MAX_FIELD = 8192;
/** An unencrypted Bitwarden JSON export: far above any real vault, small enough to bound the worker's memory. */
const MAX_IMPORT_CHARS = 16 * 1024 * 1024;

const capped =
  (max: number): Validator<string> =>
  (v, p) => {
    const s = str(v, p);
    if (s.length > max) throw new ValidationError(`${p}: too long`);
    return s;
  };

const field = capped(MAX_FIELD);
/** A padded HIBP range answer is about 40 KiB. */
const MAX_RANGE_CHARS = 512 * 1024;
const hibpPrefix: Validator<string> = (v, p) => {
  const s = str(v, p);
  if (!/^[0-9A-F]{5}$/.test(s)) throw new ValidationError(`${p}: not a SHA-1 prefix`);
  return s;
};
/** Per-document nonce / per-save token: a UUID or 32 hex chars. */
const secret = capped(64);

// ---------- popup -> service worker ----------

export type Request =
  | { type: "getState" }
  | { type: "setServer"; url: string }
  | { type: "login"; email: string; password: string }
  | { type: "twoFactorSubmit"; provider: number; token: string; remember: boolean }
  | { type: "twoFactorSendEmail" }
  /** Opens the Duo prompt in a tab; the worker picks the result up from the server's redirect page. */
  | { type: "twoFactorDuo"; remember: boolean }
  | { type: "twoFactorCancel" }
  | { type: "ssoStart" }
  /** Log in with device: asks the account's other devices to approve this one (no master password). */
  | { type: "deviceLogin"; email: string }
  /** Polled while the request waits; finishes the login once another device approved it. */
  | { type: "deviceLoginCheck" }
  /** Pending login requests from other devices, with the fingerprint phrase each must show. */
  | { type: "loginRequests" }
  /** `fingerprint`: the phrase the user compared; approval is refused for a key that does not give it. */
  | { type: "answerLoginRequest"; id: string; approve: boolean; fingerprint: string }
  | { type: "unlock"; password: string }
  | { type: "unlockPin"; pin: string }
  /** Opens the vault with the PRF output of the biometric passkey (see src/ui/biometric.ts). */
  | { type: "unlockBiometric"; prf: string }
  /** Stores the user key wrapped with a key derived from the authenticator's PRF output. */
  | { type: "setBiometric"; credentialId: string; prfSalt: string; prf: string }
  | { type: "removeBiometric" }
  /** Without `pin`: turn PIN unlock off. */
  | { type: "setPin"; pin?: string; pinOnly?: boolean }
  | { type: "lock" }
  | { type: "logout" }
  | {
      type: "setSettings";
      autoLockMinutes?: number;
      timeoutAction?: "lock" | "logout";
      lockOnSystemLock?: boolean;
      inlineMenu?: boolean;
      savePrompt?: boolean;
      favicons?: boolean;
      autoCopyTotp?: boolean;
      /** Clear the whole list, or remove one host from it. */
      clearNeverSave?: boolean;
      removeNeverSave?: string;
      addNeverSave?: string;
      addBlocked?: string;
      removeBlocked?: string;
      defaultUriMatch?: number;
      clearClipboardDelay?: ClearClipboardDelay;
      autofillOnPageLoad?: boolean;
      autofillOnPageLoadDefault?: boolean;
      /** Submit a login after a fill the user asked for. */
      autosubmit?: boolean;
      inlineMenuCards?: boolean;
      inlineMenuIdentities?: boolean;
      /** The browser context menu entry ("Fill with Warren"). */
      contextMenu?: boolean;
      showCardsOnTab?: boolean;
      showIdentitiesOnTab?: boolean;
      quickActionMenus?: boolean;
      badgeCounter?: boolean;
    }
  | { type: "setDefaultManager"; enabled: boolean }
  // vault (unlocked only)
  /** `passive`: a background sync changed the list; reading it is not user activity (no auto-lock extension). */
  | { type: "vaultList"; passive?: boolean }
  | { type: "sync"; force: boolean }
  | { type: "getItem"; id: string }
  /** `collectionIds`: a new organization item's collections (required for one). */
  | { type: "saveItem"; item: Record<string, unknown>; collectionIds?: string[] }
  /** A personal item moves into an organization's collections (PUT /ciphers/{id}/share). */
  | { type: "moveToOrg"; id: string; organizationId: string; collectionIds: string[] }
  /** An organization item's collections (PUT /ciphers/{id}/collections_v2). */
  | { type: "setCollections"; id: string; collectionIds: string[] }
  | { type: "deleteItem"; id: string }
  | { type: "restoreItem"; id: string }
  /** PUT /ciphers/{id}/archive and /unarchive: an archived item leaves the list, search and autofill but stays in the vault. */
  | { type: "archiveItem"; id: string }
  | { type: "unarchiveItem"; id: string }
  /** The security report's lists (no secrets), then each breach-range answer the popup fetched for it. */
  | { type: "securityReport" }
  | { type: "exposedRange"; prefix: string; body: string }
  /** E-mail addresses (login usernames) to look up through the user's own server's HIBP proxy. */
  | { type: "breachEmails"; emails: string[] }
  | { type: "purgeItem"; id: string }
  | { type: "downloadAttachment"; cipherId: string; attachmentId: string }
  | { type: "deleteAttachment"; cipherId: string; attachmentId: string }
  // Bitwarden JSON (unencrypted); export re-checks the master password
  | { type: "exportVault"; password: string; format: ExportFormat; filePassword?: string }
  /** Re-checks the master password for one item flagged with `reprompt` (see background/reprompt.ts). */
  | { type: "confirmReprompt"; id: string; password: string }
  /** Whether that confirmation still holds; polled by an open item, so it never extends auto-lock. */
  | { type: "repromptGranted"; id: string }
  | { type: "importVault"; text: string; password?: string }
  | { type: "addAttachment"; cipherId: string; file: { name: string; data: string } }
  | { type: "saveFolder"; name: string; id?: string }
  | { type: "deleteFolder"; id: string }
  | { type: "totp"; id: string }
  | { type: "generate"; options: Record<string, unknown> }
  /** Forwarded email alias: the saved settings for one service (never leaves the extension). */
  | { type: "aliasSettings"; vendor: AliasVendor }
  | { type: "setAliasSettings"; settings: AliasSettings }
  /** Asks that service for a new alias for the active tab's website. */
  | { type: "generateAlias"; vendor: AliasVendor }
  | { type: "generatorHistory" }
  | { type: "generatorHistoryAdd"; value: string }
  | { type: "generatorHistoryClear" }
  /** Usage data kept encrypted (background/private.ts): an item was opened, forget the opens, the generator address. */
  | { type: "itemOpened"; id: string }
  | { type: "clearOpened" }
  | { type: "generatorPrefs" }
  | { type: "setGeneratorPrefs"; options?: Record<string, unknown>; email?: string; domain?: string }
  /** The custom passphrase list, one word per line ("" removes it); it never comes back to the popup. */
  | { type: "setWordlist"; text: string }
  /** The UI copied something itself: `hash` is its clipboardDigest, so the clear only erases that. */
  | { type: "clipboardCopied"; hash: string }
  // Send
  | { type: "sendList" }
  | { type: "getSend"; id: string }
  | { type: "saveSend"; send: Record<string, unknown>; file?: { name: string; data: string } }
  | { type: "deleteSend"; id: string }
  /** Removes the access password of an existing send (PUT /api/sends/{id}/remove-password). */
  | { type: "removeSendPassword"; id: string }
  // passkeys: the approval window opened for a website request
  | { type: "passkeyPrompt"; id: string }
  /** `replace`: the user confirmed that a new passkey takes the place of the one `itemId` holds. */
  /** `password`: the master password, when the site requires user verification and nothing verified the user yet. */
  | { type: "passkeyDecision"; id: string; action: "use" | "fallback"; itemId?: string; credentialId?: string; replace?: boolean; password?: string }
  // autofill on the active tab (host permissions cover every http(s) tab)
  /** `passive`: as for vaultList. */
  | { type: "pageMatches"; passive?: boolean }
  /** One-shot: the origin the inline menu's "Create account" asked a new login for, if any. */
  | { type: "takeNewLogin" }
  /** "Pick from page" in the item editor. `draft` is the unsaved editor, kept until the popup comes back. */
  | { type: "startFieldPicker"; draft: string; panel: boolean }
  /** One-shot: the draft to return to after a pick, with the picked field if there is one. */
  | { type: "takeFieldPick" }
  /**
   * `tabId` / `origin`: the page the popup showed (PageMatches); the fill goes there or nowhere. `anyway`: the user
   * confirmed filling a login whose URIs do not match that page.
   */
  | { type: "fill"; id: string; tabId: number; origin: string; anyway?: boolean }
  /** What the user typed on the page the popup showed (`tabId` / `origin`, like fill). */
  | { type: "readPageLogin"; tabId: number; origin: string };

/** Collection ids: a bounded list of non-empty strings. */
const collectionIds: Validator<string[]> = (v, p) => {
  const ids = arr(str)(v, p);
  if (ids.length > 200 || ids.some((x) => !x || x.length > 64)) throw new ValidationError(`${p}: not a list of collection ids`);
  return [...new Set(ids)];
};

const requestValidators: { [K in Request["type"]]: Validator<Extract<Request, { type: K }>> } = {
  getState: obj({ type: literal("getState") }),
  setServer: obj({ type: literal("setServer"), url: str }),
  login: obj({ type: literal("login"), email: str, password: str }),
  twoFactorSubmit: obj({ type: literal("twoFactorSubmit"), provider: num, token: str, remember: bool }),
  twoFactorSendEmail: obj({ type: literal("twoFactorSendEmail") }),
  twoFactorDuo: obj({ type: literal("twoFactorDuo"), remember: bool }),
  twoFactorCancel: obj({ type: literal("twoFactorCancel") }),
  ssoStart: obj({ type: literal("ssoStart") }),
  deviceLogin: obj({ type: literal("deviceLogin"), email: str }),
  deviceLoginCheck: obj({ type: literal("deviceLoginCheck") }),
  loginRequests: obj({ type: literal("loginRequests") }),
  answerLoginRequest: obj({ type: literal("answerLoginRequest"), id: secret, approve: bool, fingerprint: capped(256) }),
  unlock: obj({ type: literal("unlock"), password: str }),
  unlockPin: obj({ type: literal("unlockPin"), pin: str }),
  unlockBiometric: obj({ type: literal("unlockBiometric"), prf: str }),
  setBiometric: obj({ type: literal("setBiometric"), credentialId: str, prfSalt: str, prf: str }),
  removeBiometric: obj({ type: literal("removeBiometric") }),
  setPin: (v, p) => {
    const s = obj({ type: literal("setPin"), pin: opt(str), pinOnly: opt(bool) })(v, p);
    if (s.pin !== undefined && !s.pin) throw new ValidationError("pin: required");
    return s;
  },
  lock: obj({ type: literal("lock") }),
  logout: obj({ type: literal("logout") }),
  setSettings: (v, p) => {
    const s = obj({
      type: literal("setSettings"),
      autoLockMinutes: opt(num),
      timeoutAction: opt(literal("lock", "logout")),
      lockOnSystemLock: opt(bool),
      inlineMenu: opt(bool),
      savePrompt: opt(bool),
      favicons: opt(bool),
      autoCopyTotp: opt(bool),
      clearNeverSave: opt(bool),
      removeNeverSave: opt(str),
      addNeverSave: opt(capped(300)),
      addBlocked: opt(capped(300)),
      removeBlocked: opt(str),
      defaultUriMatch: opt(num),
      clearClipboardDelay: opt(literal(...CLEAR_CLIPBOARD_CHOICES)),
      autofillOnPageLoad: opt(bool),
      autofillOnPageLoadDefault: opt(bool),
      autosubmit: opt(bool),
      inlineMenuCards: opt(bool),
      inlineMenuIdentities: opt(bool),
      contextMenu: opt(bool),
      showCardsOnTab: opt(bool),
      showIdentitiesOnTab: opt(bool),
      quickActionMenus: opt(bool),
      badgeCounter: opt(bool),
    })(v, p);
    if (s.autoLockMinutes !== undefined && !(AUTO_LOCK_CHOICES as readonly number[]).includes(s.autoLockMinutes))
      throw new ValidationError("autoLockMinutes: not an allowed choice");
    if (s.defaultUriMatch !== undefined && !(URI_MATCH_CHOICES as readonly number[]).includes(s.defaultUriMatch))
      throw new ValidationError("defaultUriMatch: not an allowed choice");
    return s;
  },
  vaultList: obj({ type: literal("vaultList"), passive: opt(bool) }),
  sync: obj({ type: literal("sync"), force: bool }),
  getItem: obj({ type: literal("getItem"), id: str }),
  saveItem: (v, p) => {
    const s = obj({ type: literal("saveItem"), item: record, collectionIds: opt(collectionIds) })(v, p);
    // Login, secure note, card, identity, SSH key, bank account, driver's license, passport.
    if (![1, 2, 3, 4, 5, 6, 7, 8].includes(s.item.type as number)) throw new ValidationError("item.type: this item type cannot be edited");
    if (typeof s.item.name !== "string" || !s.item.name.trim()) throw new ValidationError("item.name: required");
    if (s.item.organizationId && !s.item.id && !s.collectionIds?.length) throw new ValidationError("collectionIds: a new organization item needs a collection");
    return s;
  },
  moveToOrg: (v, p) => {
    const s = obj({ type: literal("moveToOrg"), id: str, organizationId: str, collectionIds })(v, p);
    if (!s.collectionIds.length) throw new ValidationError("collectionIds: pick at least one collection");
    return s;
  },
  setCollections: obj({ type: literal("setCollections"), id: str, collectionIds }),
  deleteItem: obj({ type: literal("deleteItem"), id: str }),
  restoreItem: obj({ type: literal("restoreItem"), id: str }),
  archiveItem: obj({ type: literal("archiveItem"), id: str }),
  unarchiveItem: obj({ type: literal("unarchiveItem"), id: str }),
  securityReport: obj({ type: literal("securityReport") }),
  exposedRange: obj({ type: literal("exposedRange"), prefix: hibpPrefix, body: capped(MAX_RANGE_CHARS) }),
  breachEmails: obj({ type: literal("breachEmails"), emails: (v, p) => {
    const l = arr(capped(254))(v, p);
    if (l.length > 200) throw new ValidationError(`${p}: too many addresses`);
    return l;
  } }),
  purgeItem: obj({ type: literal("purgeItem"), id: str }),
  downloadAttachment: obj({ type: literal("downloadAttachment"), cipherId: str, attachmentId: str }),
  deleteAttachment: obj({ type: literal("deleteAttachment"), cipherId: str, attachmentId: str }),
  exportVault: obj({ type: literal("exportVault"), password: str, format: literal(...EXPORT_FORMATS), filePassword: opt(str) }),
  confirmReprompt: obj({ type: literal("confirmReprompt"), id: str, password: str }),
  repromptGranted: obj({ type: literal("repromptGranted"), id: str }),
  importVault: obj({ type: literal("importVault"), text: capped(MAX_IMPORT_CHARS), password: opt(str) }),
  addAttachment: obj({ type: literal("addAttachment"), cipherId: str, file: obj({ name: str, data: str }) }),
  saveFolder: obj({ type: literal("saveFolder"), name: str, id: opt(str) }),
  deleteFolder: obj({ type: literal("deleteFolder"), id: str }),
  totp: obj({ type: literal("totp"), id: str }),
  generate: obj({ type: literal("generate"), options: record }),
  aliasSettings: obj({ type: literal("aliasSettings"), vendor: literal(...ALIAS_VENDORS) }),
  setAliasSettings: obj({
    type: literal("setAliasSettings"),
    // A vendor token is a short opaque key; the base URL and domain are user-typed, so both are capped.
    settings: obj({ vendor: literal(...ALIAS_VENDORS), token: capped(1024), baseUrl: capped(512), domain: capped(253), prefix: bool }),
  }),
  generateAlias: obj({ type: literal("generateAlias"), vendor: literal(...ALIAS_VENDORS) }),
  generatorHistory: obj({ type: literal("generatorHistory") }),
  generatorHistoryAdd: obj({ type: literal("generatorHistoryAdd"), value: str }),
  generatorHistoryClear: obj({ type: literal("generatorHistoryClear") }),
  itemOpened: obj({ type: literal("itemOpened"), id: capped(64) }),
  clearOpened: obj({ type: literal("clearOpened") }),
  generatorPrefs: obj({ type: literal("generatorPrefs") }),
  setGeneratorPrefs: obj({ type: literal("setGeneratorPrefs"), options: opt(record), email: opt(capped(320)), domain: opt(capped(253)) }),
  setWordlist: obj({ type: literal("setWordlist"), text: capped(2 * 1024 * 1024) }),
  clipboardCopied: obj({ type: literal("clipboardCopied"), hash: str }),
  sendList: obj({ type: literal("sendList") }),
  getSend: obj({ type: literal("getSend"), id: str }),
  saveSend: (v, p) => {
    const s = obj({ type: literal("saveSend"), send: record, file: opt(obj({ name: str, data: str })) })(v, p);
    if (typeof s.send.name !== "string" || !s.send.name.trim()) throw new ValidationError("send.name: required");
    // An edit (id) changes the stored send; a file send's content cannot change.
    if (s.send.id !== undefined && (typeof s.send.id !== "string" || s.file)) throw new ValidationError("send.id: invalid edit");
    return s;
  },
  deleteSend: obj({ type: literal("deleteSend"), id: str }),
  removeSendPassword: obj({ type: literal("removeSendPassword"), id: str }),
  setDefaultManager: obj({ type: literal("setDefaultManager"), enabled: bool }),
  passkeyPrompt: obj({ type: literal("passkeyPrompt"), id: str }),
  passkeyDecision: obj({ type: literal("passkeyDecision"), id: str, action: literal("use", "fallback"), itemId: opt(str), credentialId: opt(str), replace: opt(bool), password: opt(str) }),
  pageMatches: obj({ type: literal("pageMatches"), passive: opt(bool) }),
  takeNewLogin: obj({ type: literal("takeNewLogin") }),
  startFieldPicker: obj({ type: literal("startFieldPicker"), draft: str, panel: bool }),
  takeFieldPick: obj({ type: literal("takeFieldPick") }),
  fill: obj({ type: literal("fill"), id: str, tabId: num, origin: str, anyway: opt(bool) }),
  readPageLogin: obj({ type: literal("readPageLogin"), tabId: num, origin: str }),
};

export function parseRequest(v: unknown): Request {
  const type = (v as { type?: unknown } | null)?.type;
  if (typeof type !== "string" || !Object.hasOwn(requestValidators, type)) throw new ValidationError("unknown message type");
  return requestValidators[type as Request["type"]](v, "");
}

export type Phase = "setup" | "loggedOut" | "twoFactor" | "deviceLogin" | "locked" | "unlocked";

/** A login request from another device, as the approving popup shows it. */
export interface LoginRequest {
  id: string;
  fingerprint: string;
  device: string;
  ip: string;
  /** epoch ms */
  createdAt: number;
}

export interface TwoFactorChallenge {
  providers: number[];
  emailHint?: string;
  /** WebAuthn request options (JSON) for the server's webauthn-connector.html. */
  webauthn?: string;
  /** Duo Universal Prompt: the provider it came as (2 personal, 6 organization) and Duo's authorize URL. */
  duo?: { provider: number; url: string };
}

export interface Settings {
  autoLockMinutes: number;
  /** What auto-lock, system lock and a browser restart do: lock, or log out (forget the account). */
  timeoutAction: "lock" | "logout";
  lockOnSystemLock: boolean;
  /** Show the inline menu under login, card and identity fields. */
  inlineMenu: boolean;
  /** Offer to save / update logins after a form is submitted. */
  savePrompt: boolean;
  /** Hosts the user chose "never save" for. */
  neverSave: string[];
  /** Hosts where Warren offers no inline menu, page-load fill or passkeys (encrypted; filled in while unlocked). */
  blocked: string[];
  /** Chrome's own password saving and address/card autofill are turned off (privacy permission). */
  defaultManager: boolean;
  /** Website icons for logins, from the server's /icons service. */
  favicons: boolean;
  /** After filling a login that has a TOTP key, put the current code on the clipboard. */
  autoCopyTotp: boolean;
  /** Match strategy for saved URIs whose own `match` is null (and what "Default" means). */
  defaultUriMatch: number;
  /** How long copied values stay on the clipboard (official default: five minutes). */
  clearClipboardDelay: ClearClipboardDelay;
  /** Fill matching logins when a page loads. */
  autofillOnPageLoad: boolean;
  /** Value of a login's tri-state "Autofill on page load" when it is not set explicitly. */
  autofillOnPageLoadDefault: boolean;
  /** Submit a login after a fill the user asked for. Never on page load. */
  autosubmit: boolean;
  inlineMenuCards: boolean;
  inlineMenuIdentities: boolean;
  /** Show the "Fill with Warren" context-menu entry. */
  contextMenu: boolean;
  showCardsOnTab: boolean;
  showIdentitiesOnTab: boolean;
  /** Vault rows: a copy menu and "⋮" instead of one icon per action. */
  quickActionMenus: boolean;
  /** Number of matching logins on the toolbar icon. */
  badgeCounter: boolean;
}

export interface State {
  phase: Phase;
  serverUrl?: string;
  serverVersion?: string;
  email?: string;
  twoFactor?: TwoFactorChallenge;
  /** Log in with device: the fingerprint phrase the approving device shows too. */
  fingerprint?: string;
  /** Login requests from other devices that came in by push and are not answered yet. */
  loginRequests?: number;
  /** The last SSO login failed (it finishes in the background, after the popup closed). */
  ssoError?: string;
  /** PIN unlock is turned on for this account. */
  pinSet?: boolean;
  /** The account's master key comes from PBKDF2, not Argon2id (changed in the web vault). */
  weakKdf?: boolean;
  /** Biometric unlock is set up; the wrapped key stays in the service worker. */
  biometric?: { credentialId: string; prfSalt: string };
  /** The locked vault can be opened with the PIN (until the browser restarts). */
  pinUnlock?: boolean;
  /** epoch ms of the last successful sync. */
  syncedAt?: number;
  settings: Settings;
}

/** Decrypted list entry. No passwords, TOTP secrets, notes or card numbers. */
export interface VaultItem {
  id: string;
  type: number;
  name: string;
  sub: string;
  uris: string[];
  folderId?: string;
  favorite: boolean;
  readOnly: boolean;
  hasTotp: boolean;
  /** Login only: has no password (present only when true). */
  noPassword?: boolean;
  /** Login only: holds a passkey (present only when true). */
  hasPasskey?: boolean;
  /** Login only, in the main list only: how many items share this password (absent: unique). */
  reused?: number;
  /** Login only, in the main list only: the password scores "weak". */
  weak?: boolean;
  /** Flagged for a master-password re-prompt (enforced in the service worker, see background/reprompt.ts). */
  reprompt?: boolean;
  /** Tri-state "Autofill on page load" of a login (absent: inherit the account default). */
  autofillOnPageLoad?: boolean;
  /** epoch ms; used by the list's "recently edited / created" sorting. */
  revisionDate?: number;
  creationDate?: number;
  /** Card only: the network, from the brand field or worked out from the number's leading digits. */
  brand?: string;
  failed?: boolean;
}

/** Logins matching the active tab. `host` is absent when the tab is not an http(s) page. */
export interface PageMatches {
  tabId?: number;
  host?: string;
  origin?: string;
  items: VaultItem[];
}

export interface Folder {
  id: string;
  name: string;
}

export interface Collection extends Folder {
  organizationId: string;
  /** The user may not add items to it or take them out. */
  readOnly: boolean;
}

/** The server's answer for a list of e-mail addresses; `stopped` when it failed or throttled part-way. */
export interface BreachResults {
  unconfigured?: true;
  stopped?: true;
  results: { email: string; names: string[] }[];
}

/** Item ids by problem, and what a breach check must ask HIBP for. */
export interface SecurityReport {
  reused: string[];
  weak: string[];
  insecure: string[];
  prefixes: string[];
}

export interface VaultList {
  items: VaultItem[];
  folders: Folder[];
  trash: VaultItem[];
  archive: VaultItem[];
  /** Names for organization items' details. */
  organizations?: Folder[];
  collections?: Collection[];
  syncedAt?: number;
  /** cipher id -> opens on this device ("Recently opened", "Most opened" sort); stored encrypted. */
  opened?: Record<string, { n: number; at: number }>;
}

/** A copied generator value, newest first. */
export interface HistoryEntry {
  /** epoch ms */
  date: number;
  value: string;
}

export interface PasskeyCandidate {
  itemId: string;
  name: string;
  userName: string;
  /** base64url; empty for a create, where candidates are the logins a new passkey can join. */
  credentialId: string;
  /** Create only: the login holds a passkey, which the new one replaces once the user confirms. */
  replaces?: boolean;
}

/** What the approval window shows for a pending website passkey request. */
export interface PasskeyPrompt {
  kind: "create" | "get";
  origin: string;
  rpId: string;
  rpName?: string;
  userName?: string;
  candidates: PasskeyCandidate[];
  /** Get with no candidates: how many passkeys the vault holds for this RP ID that the site did not ask for. */
  others?: number;
  /** The site requires user verification and nothing verified the user for this request yet: ask for the master password. */
  verify?: boolean;
}

/** Decrypted send for the list. `link` carries the decryption secret in its fragment. */
export interface SendItem {
  id: string;
  type: number;
  name: string;
  link: string;
  deletionDate: string;
  hasPassword: boolean;
  disabled: boolean;
  accessCount: number;
  maxAccessCount?: number;
  failed?: boolean;
}

export type Response<T = State> = { ok: true; data: T } | { ok: false; error: string; code?: ErrorCode };

export type ErrorCode =
  | "invalid"
  | "network"
  | "alias"
  | "badServer"
  | "badCredentials"
  | "badTwoFactor"
  | "wrongPassword"
  | "badBiometric"
  | "reprompt"
  | "sessionExpired"
  | "wrongPhase"
  /** UI only (ui/dom.ts send): the answer was asked for before a lock or account change the screen has seen since. */
  | "stale";

// ---------- service worker -> offscreen -> worker ----------

export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface KdfParams {
  type: number;
  iterations: number;
  memory: number;
  parallelism: number;
}

// prepareKey derives the master key once and caches its server auth hash next to it in the worker,
// so a 2FA round trip does not need the password again. Result: { handle, authHash }.
export type CoreRequest =
  | { op: "prepareKey"; email: string; password: string; kdf: KdfParams }
  | { op: "authHash"; handle: number }
  | { op: "unlock"; handle: number; protectedUserKey: string; encryptedPrivateKey?: string }
  // PIN: the user key wrapped with a key derived from the PIN (PIN_KDF, or the account KDF for older keys, and email)
  | { op: "pinProtect"; pin: string; email: string; kdf: KdfParams }
  | { op: "unlockPin"; pin: string; email: string; kdf: KdfParams; protectedUserKey: string; encryptedPrivateKey?: string }
  // biometric: the user key wrapped with a key derived from a WebAuthn PRF output (base64)
  | { op: "prfProtect"; prf: string }
  | { op: "unlockPrf"; prf: string; protectedUserKey: string; encryptedPrivateKey?: string }
  | { op: "freeKey"; handle: number }
  // log in with device (auth requests): RSA key pair here, user key wrapped for / by the other device
  | { op: "authRequestCreate"; email: string }
  | { op: "authRequestUnlock"; key: string; encryptedPrivateKey?: string }
  | { op: "authRequestApprove"; publicKey: string }
  | { op: "authRequestFingerprint"; email: string; publicKey: string }
  | { op: "lock" }
  /** Whether the decrypted vault is in memory (a fresh worker, or a sign-in, has none yet). */
  | { op: "vaultLoaded" }
  // vault: the worker keeps the decrypted vault in memory
  | { op: "loadVault"; ciphers: unknown[]; folders: unknown[]; sends: unknown[]; orgKeys: Record<string, string>; collections: unknown[]; orgs: Folder[] }
  | { op: "upsertCipher"; cipher: Record<string, unknown> }
  | { op: "listVault" }
  | { op: "getCipher"; id: string }
  /** The list entry of one item: no secrets. Enough for a re-prompt or type check. */
  | { op: "cipherSummary"; id: string }
  /** Reused / weak / insecure-site login ids and the SHA-1 prefixes to look up; no secret. */
  | { op: "securityReport" }
  /** One HIBP range answer for `prefix` (5 upper-case hex digits): the items it exposes, with counts. */
  | { op: "exposedRange"; prefix: string; body: string }
  | { op: "prepareSave"; item: Record<string, unknown> }
  | { op: "prepareShare"; id: string; organizationId: string }
  /** Save bar: the item with a new password, encrypted; the service worker never sees the item. */
  /** `revisionDate`: the item's revision (epoch ms) the save bar asked about; refused if the item changed since. */
  | { op: "preparePassword"; id: string; password: string; revisionDate?: number }
  | { op: "totp"; id: string }
  | { op: "generate"; options: Record<string, unknown> }
  // free text encrypted with the user key (like a folder name)
  | { op: "encryptText"; values: string[] }
  | { op: "decryptText"; values: string[] }
  | { op: "matchUri"; url: string; defaultMatch: number }
  | { op: "fillData"; id: string }
  | { op: "formValues"; id: string }
  | { op: "customFieldValues"; id: string }
  | { op: "stashDraft"; draft: string }
  | { op: "takeDraft" }
  // attachments (bodies base64)
  | { op: "decryptAttachment"; cipherId: string; attachmentId: string; data: string }
  | { op: "exportVault"; format: ExportFormat; password?: string; kdf?: KdfParams }
  | { op: "prepareImport"; text: string; password?: string }
  | { op: "encryptAttachment"; cipherId: string; fileName: string; data: string }
  // Send
  | { op: "listSends" }
  | { op: "getSend"; id: string }
  | { op: "prepareSend"; send: Record<string, unknown> }
  | { op: "encryptSendFile"; key: string; data: string }
  | { op: "upsertSend"; send: Record<string, unknown> }
  | { op: "removeSend"; id: string }
  // passkeys (all ids and binary values base64url)
  | { op: "passkeyCandidates"; rpId: string; origin: string; ids: string[] }
  | { op: "passkeyAssert"; itemId: string; credentialId: string; rpId: string; origin: string; challenge: string; uv: boolean }
  /** Result: the item to save, already encrypted (the new private key never leaves the worker), and the page's response. */
  | { op: "passkeyCreate"; input: PasskeyCreateInput; itemId?: string }
  // handled by the offscreen document itself, not the worker
  | { op: "writeClipboard"; text: string }
  /** Empties the clipboard, but with a `hash` only while it still holds the text with that clipboardDigest. */
  | { op: "clearClipboard"; hash?: string };

export type CoreResult = { ok: true; value: unknown } | { ok: false; error: string };

export const OFFSCREEN_TARGET = "warren-offscreen";

// Exactly what the core's u8/u32 parameters hold: a value that would wrap there never reaches it.
const kdfParams: Validator<KdfParams> = obj({ type: literal(0, 1), iterations: u32, memory: u32, parallelism: u32 });

/**
 * WebAuthn bounds. The spec sets no upper limit on a challenge and sites use it to carry signed state:
 * Google's is about 14 000 base64url characters. 64 KiB lets those through and still bounds the work.
 * Names and ids are small by spec.
 */
const rpIdField = capped(253);
const challengeField = capped(64 * 1024);
const user = obj({ id: capped(1024), name: capped(1024), displayName: capped(1024) });
/** A page-supplied array of credential ids: bounded, so it cannot ask for unbounded work. */
const credIdList = (v: unknown, p: string): string[] => {
  const list = arr(capped(1024))(v, p);
  if (list.length > 64) throw new ValidationError(`${p}: too many entries`);
  return list;
};
const passkeyCreateInput: Validator<PasskeyCreateInput> = obj({
  origin: str,
  rpId: rpIdField,
  rpName: capped(1024),
  challenge: challengeField,
  user,
  discoverable: bool,
  uv: bool,
});

const coreValidators: { [K in CoreRequest["op"]]: Validator<Extract<CoreRequest, { op: K }>> } = {
  prepareKey: obj({ op: literal("prepareKey"), email: str, password: str, kdf: kdfParams }),
  authHash: obj({ op: literal("authHash"), handle: num }),
  unlock: obj({ op: literal("unlock"), handle: num, protectedUserKey: str, encryptedPrivateKey: opt(str) }),
  pinProtect: obj({ op: literal("pinProtect"), pin: str, email: str, kdf: kdfParams }),
  unlockPin: obj({ op: literal("unlockPin"), pin: str, email: str, kdf: kdfParams, protectedUserKey: str, encryptedPrivateKey: opt(str) }),
  prfProtect: obj({ op: literal("prfProtect"), prf: str }),
  unlockPrf: obj({ op: literal("unlockPrf"), prf: str, protectedUserKey: str, encryptedPrivateKey: opt(str) }),
  freeKey: obj({ op: literal("freeKey"), handle: num }),
  authRequestCreate: obj({ op: literal("authRequestCreate"), email: str }),
  authRequestUnlock: obj({ op: literal("authRequestUnlock"), key: str, encryptedPrivateKey: opt(str) }),
  authRequestApprove: obj({ op: literal("authRequestApprove"), publicKey: str }),
  authRequestFingerprint: obj({ op: literal("authRequestFingerprint"), email: str, publicKey: str }),
  lock: obj({ op: literal("lock") }),
  vaultLoaded: obj({ op: literal("vaultLoaded") }),
  loadVault: obj({
    op: literal("loadVault"),
    ciphers: arr(unknownValue),
    folders: arr(unknownValue),
    sends: arr(unknownValue),
    orgKeys: record as Validator<Record<string, string>>,
    collections: arr(unknownValue),
    orgs: arr(obj({ id: str, name: str })),
  }),
  upsertCipher: obj({ op: literal("upsertCipher"), cipher: record }),
  listVault: obj({ op: literal("listVault") }),
  getCipher: obj({ op: literal("getCipher"), id: str }),
  cipherSummary: obj({ op: literal("cipherSummary"), id: str }),
  securityReport: obj({ op: literal("securityReport") }),
  exposedRange: obj({ op: literal("exposedRange"), prefix: hibpPrefix, body: capped(MAX_RANGE_CHARS) }),
  prepareSave: obj({ op: literal("prepareSave"), item: record }),
  prepareShare: obj({ op: literal("prepareShare"), id: str, organizationId: str }),
  preparePassword: obj({ op: literal("preparePassword"), id: str, password: str, revisionDate: opt(num) }),
  totp: obj({ op: literal("totp"), id: str }),
  generate: obj({ op: literal("generate"), options: record }),
  encryptText: obj({ op: literal("encryptText"), values: arr(str) }),
  decryptText: obj({ op: literal("decryptText"), values: arr(str) }),
  matchUri: obj({ op: literal("matchUri"), url: str, defaultMatch: num }),
  fillData: obj({ op: literal("fillData"), id: str }),
  formValues: obj({ op: literal("formValues"), id: str }),
  customFieldValues: obj({ op: literal("customFieldValues"), id: str }),
  stashDraft: obj({ op: literal("stashDraft"), draft: str }),
  takeDraft: obj({ op: literal("takeDraft") }),
  decryptAttachment: obj({ op: literal("decryptAttachment"), cipherId: str, attachmentId: str, data: str }),
  exportVault: obj({ op: literal("exportVault"), format: literal(...EXPORT_FORMATS), password: opt(str), kdf: opt(kdfParams) }),
  prepareImport: obj({ op: literal("prepareImport"), text: str, password: opt(str) }),
  encryptAttachment: obj({ op: literal("encryptAttachment"), cipherId: str, fileName: str, data: str }),
  listSends: obj({ op: literal("listSends") }),
  getSend: obj({ op: literal("getSend"), id: str }),
  prepareSend: obj({ op: literal("prepareSend"), send: record }),
  encryptSendFile: obj({ op: literal("encryptSendFile"), key: str, data: str }),
  upsertSend: obj({ op: literal("upsertSend"), send: record }),
  removeSend: obj({ op: literal("removeSend"), id: str }),
  passkeyCandidates: obj({ op: literal("passkeyCandidates"), rpId: str, origin: str, ids: arr(str) }),
  passkeyAssert: obj({ op: literal("passkeyAssert"), itemId: str, credentialId: str, rpId: str, origin: str, challenge: str, uv: bool }),
  passkeyCreate: obj({ op: literal("passkeyCreate"), input: passkeyCreateInput, itemId: opt(str) }),
  writeClipboard: obj({ op: literal("writeClipboard"), text: str }),
  clearClipboard: obj({ op: literal("clearClipboard"), hash: opt(str) }),
};

export function parseCoreRequest(v: unknown): CoreRequest {
  const op = (v as { op?: unknown } | null)?.op;
  if (typeof op !== "string" || !Object.hasOwn(coreValidators, op)) throw new ValidationError("unknown core op");
  return coreValidators[op as CoreRequest["op"]](v, "");
}

// ---------- page (passkey shim) -> isolated relay -> service worker, over a "passkey" port ----------

export const PASSKEY_PORT = "warren-passkey";

interface PasskeyCreateInput {
  origin: string;
  rpId: string;
  rpName: string;
  challenge: string;
  user: { id: string; name: string; displayName: string };
  discoverable: boolean;
  /** The UV flag: set only when the user was verified for this request (see passkey.ts `verified`). */
  uv: boolean;
}

/** The RP's `userVerification`. WebAuthn: an unknown value is ignored, which means "preferred". */
type UserVerification = "required" | "preferred" | "discouraged";
const uvField: Validator<UserVerification> = (v) => (v === "required" || v === "discouraged" ? v : "preferred");

/** Sent by the relay. The origin is never taken from here: the service worker uses port.sender.origin. */
export type PasskeyCall =
  | {
      kind: "create";
      options: { rpId?: string; rpName: string; user: { id: string; name: string; displayName: string }; challenge: string; exclude: string[]; discoverable: boolean; userVerification: UserVerification };
    }
  | { kind: "get"; conditional: boolean; options: { rpId?: string; challenge: string; allow: string[]; userVerification: UserVerification } };

/** Credential fields (base64url) or a reason to let the browser handle the call. */
export type PasskeyResult = { credential: Record<string, unknown> } | { fallback: true } | { error: { name: string; message: string } };

export function parsePasskeyCall(v: unknown): PasskeyCall {
  const kind = (v as { kind?: unknown } | null)?.kind;
  if (kind === "create")
    return obj({
      kind: literal("create"),
      options: obj({ rpId: opt(rpIdField), rpName: capped(1024), user, challenge: challengeField, exclude: credIdList, discoverable: bool, userVerification: uvField }),
    })(v, "");
  return obj({ kind: literal("get"), conditional: bool, options: obj({ rpId: opt(rpIdField), challenge: challengeField, allow: credIdList, userVerification: uvField }) })(v, "");
}

// ---------- content script (every page) and our menu.html / bar.html iframes -> service worker ----------

export type FieldKind = "login" | "card" | "identity";

// What the content script reports about a frame. All of it is page-controlled. See crates/autofill-cpd.

const pageString = opt(capped(MAX_PAGE_STRING));

const bounded =
  <T>(max: number, inner: Validator<T>): Validator<T[]> =>
  (v, p) => {
    if (Array.isArray(v) && v.length > max) throw new ValidationError(`${p}: too many`);
    return arr(inner)(v, p);
  };

const blockPathField = bounded(MAX_BLOCK_PATH, num);

const dataAttributesField: Validator<Record<string, string>> = (v, p) => {
  const rec = record(v, p);
  const entries = Object.entries(rec);
  if (entries.length > MAX_DATA_ATTRS) throw new ValidationError(`${p}: too many`);
  const out: Record<string, string> = {};
  for (const [k, val] of entries) {
    if (k.length > MAX_PAGE_STRING) throw new ValidationError(`${p}: key too long`);
    out[k] = capped(MAX_PAGE_STRING)(val, `${p}.${k}`);
  }
  return out;
};

const fieldDetails = obj({
  fieldId: num,
  formId: opt(num),
  type: capped(32),
  htmlId: pageString,
  htmlName: pageString,
  htmlClass: pageString,
  autocompleteType: pageString,
  placeholder: pageString,
  maxLength: opt(num),
  minLength: opt(num),
  tabIndex: opt(num),
  title: pageString,
  passwordRules: pageString,
  dataAttributes: dataAttributesField,
  isActive: opt(bool),
  isChecked: opt(bool),
  isHidden: opt(bool),
  isReadOnly: opt(bool),
  isDisabled: opt(bool),
  isAriaDisabled: opt(bool),
  isAriaHasPopup: opt(bool),
  isAriaHidden: opt(bool),
  label: pageString,
  labelAria: pageString,
  labelData: pageString,
  labelBefore: pageString,
  labelAfter: pageString,
  blockPath: blockPathField,
});

const formDetails = obj({ formId: num, htmlId: pageString, htmlName: pageString, action: pageString, text: opt(capped(MAX_FORM_TEXT)) });

const buttonDetails = obj({ fieldId: num, formId: opt(num), text: pageString, isSubmit: opt(bool), isHidden: opt(bool), blockPath: blockPathField });

const collectedPageDetails = obj({
  origin: capped(MAX_FIELD),
  forms: bounded(MAX_FORMS, formDetails),
  fields: bounded(MAX_FIELDS, fieldDetails),
  buttons: bounded(MAX_BUTTONS, buttonDetails),
  buttonsTruncated: opt(bool),
});

export type FieldDetails = ReturnType<typeof fieldDetails>;
export type FormDetails = ReturnType<typeof formDetails>;
export type ButtonDetails = ReturnType<typeof buttonDetails>;
export type CollectedPageDetails = ReturnType<typeof collectedPageDetails>;

/** Page details also come back from `chrome.scripting`, which crosses the same boundary. */
export const parsePageDetails = (v: unknown): CollectedPageDetails => collectedPageDetails(v, "details");

/** From the content script. Sender tab, frame and URL come from the browser (sender), never from here. */
export type PageRequest =
  /**
   * `nonce` is a per-document secret, echoed by the menu frame it opens (see FrameRequest). `details`
   * describes the frame, with the focused field marked active; the worker decides what that field is.
   * All a page can claim here is a different menu for its own frame.
   */
  | { type: "inlineFocus"; nonce: string; details: CollectedPageDetails }
  | { type: "loginSubmitted"; username: string; password: string }
  /** Sent once per document, when the frame has a password field; the worker decides whether to fill. */
  | { type: "pageLoad" }
  /** The user's pick for a picker the worker started in this tab; an empty name is a cancel. */
  | { type: "fieldPicked"; name: string; fieldType: string; label?: string; details?: CollectedPageDetails };

/** A page-controlled form value: big enough for any real credential, small enough to bound storage. */
const pageValidators: { [K in PageRequest["type"]]: Validator<Extract<PageRequest, { type: K }>> } = {
  inlineFocus: obj({ type: literal("inlineFocus"), nonce: secret, details: collectedPageDetails }),
  loginSubmitted: obj({ type: literal("loginSubmitted"), username: field, password: field }),
  pageLoad: obj({ type: literal("pageLoad") }),
  fieldPicked: obj({ type: literal("fieldPicked"), name: capped(MAX_PAGE_STRING), fieldType: capped(32), label: pageString, details: opt(collectedPageDetails) }),
};

/**
 * From menu.html / bar.html, which run as extension pages inside the website's tab. The `inline*`
 * requests carry the nonce of the document that opened the menu: the page cannot read it (it lives in
 * the iframe's fragment, and the menu is inside a closed shadow root), so a menu the page frames
 * itself cannot be used to drive a fill.
 */
export type FrameRequest =
  | { type: "inlineList"; nonce: string }
  | { type: "inlineFill"; id: string; nonce: string }
  | { type: "inlinePasskey"; nonce: string }
  /** Opens the popup: to unlock, or from the menu's "Manage passwords" row. */
  | { type: "inlineOpen"; nonce: string }
  | { type: "inlineNewLogin"; nonce: string }
  | { type: "barInfo"; token: string }
  | { type: "barAction"; action: "save" | "never" | "close"; token: string };

const frameValidators: { [K in FrameRequest["type"]]: Validator<Extract<FrameRequest, { type: K }>> } = {
  inlineList: obj({ type: literal("inlineList"), nonce: secret }),
  inlineFill: obj({ type: literal("inlineFill"), id: str, nonce: secret }),
  inlinePasskey: obj({ type: literal("inlinePasskey"), nonce: secret }),
  inlineOpen: obj({ type: literal("inlineOpen"), nonce: secret }),
  inlineNewLogin: obj({ type: literal("inlineNewLogin"), nonce: secret }),
  barInfo: obj({ type: literal("barInfo"), token: secret }),
  barAction: obj({ type: literal("barAction"), action: literal("save", "never", "close"), token: secret }),
};

const parseBy =
  <T>(validators: Record<string, Validator<unknown>>) =>
  (v: unknown): T => {
    const type = (v as { type?: unknown } | null)?.type;
    if (typeof type !== "string" || !Object.hasOwn(validators, type)) throw new ValidationError("unknown message type");
    return validators[type]!(v, "") as T;
  };

export const parsePageRequest = parseBy<PageRequest>(pageValidators);
export const parseFrameRequest = parseBy<FrameRequest>(frameValidators);

export interface MenuItem {
  id: string;
  type: number;
  name: string;
  sub: string;
}

export interface MenuData {
  kind: FieldKind;
  locked: boolean;
  items: MenuItem[];
  /** A website's conditional passkey sign-in is waiting: offer "Sign in with a passkey". */
  passkey: boolean;
  /** No login for this site yet, or a registration form: offer "Create account". */
  create: boolean;
}

export interface BarInfo {
  kind: "add" | "update";
  host: string;
  username: string;
}
