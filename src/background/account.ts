// Login, 2FA, unlock, token refresh. Pure orchestration: crypto runs in the offscreen worker,
// HTTP in src/transport.
import { KDF_ARGON2ID, PIN_KDF, TWO_FACTOR } from "../shared/constants.ts";
import type { CoreRequest, ErrorCode, KdfParams, LoginRequest } from "../shared/messages.ts";
import {
  answerAuthRequest,
  authorizationCodeToken,
  authRequestStatus,
  createAuthRequest,
  getAuthRequest,
  jwtClaim,
  jwtSubject,
  passwordToken,
  pendingAuthRequests,
  prelogin,
  refreshToken,
  sendEmailLogin,
  ssoPrevalidate,
  type TokenResponse,
  toTokens,
  TwoFactorRequired,
} from "../transport/auth.ts";
import { ApiError } from "../transport/http.ts";
import { verifyPassword } from "../transport/vault.ts";
import { CoreError, coreAlive, coreCall } from "./core.ts";
import { lockNow, touchAutoLock } from "./lock.ts";
import { migratePrivate } from "./private.ts";
import { stopPush } from "./push.ts";
import { grantReprompt } from "./reprompt.ts";
import { BLOCK, resealLegacy, seal, unseal } from "./seal.ts";
import {
  type Account,
  getDeviceId,
  getLocal,
  getSession,
  getSettings,
  removeLocal,
  setLocal,
  updateSession,
} from "./store.ts";

/** Error with a code the popup can switch on (see ErrorCode in shared/messages.ts). */
export class UserError extends Error {
  override name = "UserError";
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const PENDING_TTL_MS = 10 * 60_000;
export const PENDING_ALARM = "pendingLogin";

/**
 * A 2FA "remember me" token is only valid for the server that issued it, so it is stored per server:
 * changing the configured server (or pointing at another one) must never replay it there.
 */
const rememberKey = async (serverUrl: string, email: string) =>
  // Hashed: the token outlives a logout, and the account's email address should not stay on disk with it.
  new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${serverUrl}|${email}`))).toHex();

async function requireServer(): Promise<string> {
  const server = await getLocal("server");
  if (!server) throw new UserError("wrongPhase", "No server configured");
  return server.url;
}

interface Prepared {
  handle: number;
  authHash: string;
}

const prepareKey = (email: string, password: string, kdf: KdfParams) =>
  coreCall<Prepared>({ op: "prepareKey", email, password, kdf });

function kdfFromToken(t: TokenResponse, fallback: KdfParams): KdfParams {
  if (t.Kdf === undefined || t.KdfIterations === undefined) return fallback;
  const argon = t.Kdf === KDF_ARGON2ID;
  return {
    type: t.Kdf,
    iterations: t.KdfIterations,
    memory: argon ? (t.KdfMemory ?? 0) : 0,
    parallelism: argon ? (t.KdfParallelism ?? 0) : 0,
  };
}

/** How a login opens the vault: the master key behind `handle`, or the user key another device sent (`device.key`). */
type Opener = { handle: number; device?: { id: string; accessCode: string; key: string } };

async function completeLogin(serverUrl: string, email: string, kdf: KdfParams, via: Opener, t: TokenResponse): Promise<void> {
  if (!t.Key) throw new UserError("badServer", "Server did not return an encrypted user key");
  const op: CoreRequest = via.device
    ? { op: "authRequestUnlock", key: via.device.key, encryptedPrivateKey: t.PrivateKey }
    : { op: "unlock", handle: via.handle, protectedUserKey: t.Key, encryptedPrivateKey: t.PrivateKey };
  try {
    await coreCall(op);
  } catch (e) {
    throw new UserError("badServer", `Could not decrypt the account key: ${(e as Error).message}`);
  }
  const tokens = toTokens(t);
  await removeLocal("vault"); // never show a previous account's cache
  const account: Account = {
    email,
    userId: jwtSubject(t.access_token),
    kdf: kdfFromToken(t, kdf),
    protectedUserKey: t.Key,
    encryptedPrivateKey: t.PrivateKey,
  };
  await setLocal("account", account);
  await storeRefreshToken(tokens.refreshToken);
  if (t.TwoFactorToken) {
    const remember = (await getLocal("rememberTokens")) ?? {};
    await setLocal("rememberTokens", { ...remember, [await rememberKey(serverUrl, email)]: t.TwoFactorToken });
  }
  await updateSession({
    unlocked: true,
    accessToken: tokens.accessToken,
    accessExpiresAt: tokens.expiresAt,
    pending: undefined,
    ssoError: undefined,
    pin: undefined,
  });
  await touchAutoLock();
}

function mapLoginError(e: unknown): never {
  if (e instanceof UserError) throw e;
  if (e instanceof ApiError && (e.status === 400 || e.status === 401))
    throw new UserError("badCredentials", e.message);
  throw e;
}

export async function login(rawEmail: string, password: string): Promise<void> {
  const base = await requireServer();
  const email = rawEmail.trim().toLowerCase();
  if (!email || !password) throw new UserError("invalid", "Email and master password are required");
  await lockNow();

  const kdf = await prelogin(base, email);
  const { handle, authHash } = await prepareKey(email, password, kdf);
  try {
    await passwordLogin(base, email, kdf, authHash, { handle });
  } catch (e) {
    await coreCall({ op: "freeKey", handle }).catch(() => undefined);
    mapLoginError(e);
  }
}

/**
 * The token grant of a password or device login, with the 2FA "remember me" token when we have one. A 2FA
 * challenge becomes a pending login (resolves); any other failure is thrown.
 */
async function passwordLogin(base: string, email: string, kdf: KdfParams, authHash: string, via: Opener): Promise<void> {
  const deviceId = await getDeviceId();
  const key = await rememberKey(base, email);
  const tokens = (await getLocal("rememberTokens")) ?? {};
  const legacy = `${base}|${email}`; // clear-text key of older builds
  if (tokens[legacy]) {
    tokens[key] ??= tokens[legacy];
    delete tokens[legacy];
    await setLocal("rememberTokens", tokens);
  }
  const remembered = tokens[key];
  try {
    const t = await passwordToken(base, {
      email,
      authHash,
      deviceId,
      authRequest: via.device?.id,
      ...(remembered ? { twoFactor: { provider: TWO_FACTOR.Remember, token: remembered, remember: false } } : {}),
    });
    await completeLogin(base, email, kdf, via, t);
  } catch (e) {
    if (!(e instanceof TwoFactorRequired)) throw e;
    if (remembered) {
      // The server rejected (or expired) our remember token: forget it and ask for a real code.
      const all = (await getLocal("rememberTokens")) ?? {};
      delete all[key];
      await setLocal("rememberTokens", all);
    }
    const expiresAt = Date.now() + PENDING_TTL_MS;
    await updateSession({ pending: { email, kdf, handle: via.handle, challenge: e.challenge, expiresAt, ...(via.device ? { device: via.device } : {}) } });
    // The pending login holds the master key: free it on time even if the popup is never opened again.
    await chrome.alarms.create(PENDING_ALARM, { when: expiresAt });
  }
}

async function requirePending() {
  const { pending } = await getSession();
  if (!pending) throw new UserError("wrongPhase", "No login in progress");
  if (pending.expiresAt < Date.now()) {
    await cancelTwoFactor();
    throw new UserError("sessionExpired", "The login attempt expired, please log in again");
  }
  try {
    return { pending, authHash: pending.device?.accessCode ?? (await coreCall<string>({ op: "authHash", handle: pending.handle })) };
  } catch (e) {
    if (!(e instanceof CoreError)) throw e;
    await updateSession({ pending: undefined });
    throw new UserError("sessionExpired", "The login attempt expired, please log in again");
  }
}

export async function submitTwoFactor(provider: number, token: string, remember: boolean): Promise<void> {
  const base = await requireServer();
  const { pending, authHash } = await requirePending();
  if (!pending.challenge.providers.includes(provider)) throw new UserError("invalid", "Provider not offered by server");
  // WebAuthn tokens are the assertion JSON from the connector page; codes may be typed with spaces.
  const code = provider === TWO_FACTOR.WebAuthn ? token : token.replace(/\s+/g, "");
  if (!code) throw new UserError("invalid", "Enter the verification code");
  const grant = { email: pending.email, authHash, deviceId: await getDeviceId(), authRequest: pending.device?.id };
  try {
    const t = await passwordToken(base, { ...grant, twoFactor: { provider, token: code, remember } });
    await completeLogin(base, pending.email, pending.kdf, pending, t);
  } catch (e) {
    if (!(e instanceof TwoFactorRequired || (e instanceof ApiError && e.status === 400))) throw e;
    if (provider === TWO_FACTOR.WebAuthn) {
      // Vaultwarden deletes the WebAuthn challenge on every attempt; ask for a fresh one.
      await passwordToken(base, grant).catch(async (r: unknown) => {
        if (r instanceof TwoFactorRequired) await updateSession({ pending: { ...pending, challenge: r.challenge } });
      });
    }
    throw new UserError("badTwoFactor", e instanceof ApiError ? e.message : "Invalid verification code");
  }
}

export async function sendTwoFactorEmail(): Promise<void> {
  const base = await requireServer();
  const { pending, authHash } = await requirePending();
  if (!pending.challenge.providers.includes(TWO_FACTOR.Email))
    throw new UserError("invalid", "Email two-step login is not enabled for this account");
  await sendEmailLogin(base, pending.email, authHash, await getDeviceId(), pending.device?.id);
}

export async function cancelTwoFactor(): Promise<void> {
  const { pending, deviceLogin, unlocked } = await getSession();
  await updateSession({ pending: undefined, deviceLogin: undefined });
  // Only a live worker can hold the handle: do not spin one up just to free it.
  if (!(await coreAlive())) return;
  if (pending) await coreCall({ op: "freeKey", handle: pending.handle }).catch(() => undefined);
  // A device login's RSA key sits in the (still locked) worker: a lock drops it.
  if ((deviceLogin || pending?.device) && !unlocked) await coreCall({ op: "lock" }).catch(() => undefined);
}

export async function unlock(password: string): Promise<void> {
  const account = await getLocal("account");
  if (!account) throw new UserError("wrongPhase", "Not logged in");
  const { handle } = await prepareKey(account.email, password, account.kdf);
  try {
    await coreCall({
      op: "unlock",
      handle,
      protectedUserKey: account.protectedUserKey,
      encryptedPrivateKey: account.encryptedPrivateKey,
    });
  } catch (e) {
    await coreCall({ op: "freeKey", handle }).catch(() => undefined);
    if (e instanceof CoreError) throw new UserError("wrongPassword", "Wrong master password");
    throw e;
  }
  await afterUnlock(account);
}

/** Shared tail of every unlock path (master password, PIN, biometrics). */
async function afterUnlock(account: Account): Promise<void> {
  await updateSession({ unlocked: true });
  await touchAutoLock();
  // After a browser restart the PIN-wrapped key is gone: re-arm it from the stored PIN.
  const { pin } = await getSession();
  if (account.protectedPin && !account.pinKey && pin?.email !== account.email) {
    const [plain] = await unseal([account.protectedPin]);
    if (plain) await armPin(account, plain);
  } else if (account.pinKey && account.protectedPin && JSON.stringify(account.pinKdf) !== JSON.stringify(PIN_KDF)) {
    // A PIN-only key from an older build is wrapped through the account KDF: re-wrap it with PIN_KDF once.
    const [plain] = await unseal([account.protectedPin]);
    const key = plain ? await armPin(account, plain) : undefined;
    const fresh = await getLocal("account");
    if (key && fresh?.pinKey === account.pinKey) await setLocal("account", { ...fresh, pinKey: key, pinKdf: PIN_KDF });
  } else if (pin?.attempts) await updateSession({ pin: { ...pin, attempts: 0 } });
  // Older builds kept never-save hosts and fill stamps in clear text; a failed move is retried next unlock.
  await migratePrivate().catch(() => undefined);
  await resealLegacy().catch(() => undefined);
}

// ---------- Log in with device (Bitwarden auth requests) ----------
// Another logged-in device wraps the user key for a one-off RSA key held in the crypto worker; the token is
// granted with the request's access code instead of the password hash.

/** Vaultwarden only grants a token within 5 minutes of the request. */
const DEVICE_LOGIN_TTL_MS = 5 * 60_000;

export async function startDeviceLogin(rawEmail: string): Promise<void> {
  const base = await requireServer();
  const email = rawEmail.trim().toLowerCase();
  if (!email) throw new UserError("invalid", "Enter your email address");
  await lockNow();
  const { publicKey, fingerprint } = await coreCall<{ publicKey: string; fingerprint: string }>({ op: "authRequestCreate", email });
  const accessCode = b64u(crypto.getRandomValues(new Uint8Array(24)));
  const r = await createAuthRequest(base, { email, publicKey, deviceId: await getDeviceId(), accessCode }).catch((e: unknown) => {
    // Vaultwarden refuses an unknown account and a device id it has never seen log in to that account (both 400).
    if (e instanceof ApiError && e.status === 400)
      throw new UserError("badCredentials", "Log in with device works once this browser has logged in to the account with the master password");
    throw e;
  });
  const expiresAt = Date.now() + DEVICE_LOGIN_TTL_MS;
  await updateSession({ deviceLogin: { email, id: r.id, accessCode, fingerprint, expiresAt }, ssoError: undefined });
  await chrome.alarms.create(PENDING_ALARM, { when: expiresAt });
}

/** Polled by the popup: finishes the login once another device approved the request. */
export async function checkDeviceLogin(): Promise<void> {
  const base = await requireServer();
  const { deviceLogin: d } = await getSession();
  if (!d) throw new UserError("wrongPhase", "No login request in progress");
  if (d.expiresAt < Date.now()) {
    await cancelTwoFactor();
    throw new UserError("sessionExpired", "The login request expired, please try again");
  }
  const r = await authRequestStatus(base, d.id, d.accessCode).catch(async (e: unknown) => {
    if (!(e instanceof ApiError && e.status === 400)) throw e;
    await cancelTwoFactor(); // a denied request is deleted
    throw new UserError("badCredentials", "The login request was denied");
  });
  if (!r.requestApproved || !r.key) return;
  // Clients before 2023 sent the master key instead of the user key; none still in support does.
  if (r.masterPasswordHash) {
    await cancelTwoFactor();
    throw new UserError("badServer", "Approve the request from an up-to-date app");
  }
  await updateSession({ deviceLogin: undefined });
  try {
    await passwordLogin(base, d.email, await prelogin(base, d.email), d.accessCode, { handle: 0, device: { id: d.id, accessCode: d.accessCode, key: r.key } });
  } catch (e) {
    mapLoginError(e);
  }
}

/** Other devices' requests waiting for this one, with the phrase to compare. */
export async function loginRequests(): Promise<LoginRequest[]> {
  const base = await requireServer();
  const account = await getLocal("account");
  if (!account) throw new UserError("sessionExpired", "Please log in again");
  const all = await pendingAuthRequests(base, await accessToken());
  const list: LoginRequest[] = [];
  for (const r of all) {
    const fingerprint = await coreCall<string>({ op: "authRequestFingerprint", email: account.email, publicKey: r.publicKey }).catch(() => undefined);
    if (fingerprint) list.push({ id: r.id, fingerprint, device: r.requestDeviceType ?? "", ip: r.requestIpAddress ?? "", createdAt: Date.parse(r.creationDate) });
  }
  // What the server still has pending is the truth; requests that came in by push but are gone drop out here.
  await updateSession({ loginRequests: list.map((r) => r.id) });
  return list;
}

/**
 * Approves (wraps the user key for the requester) or denies a request. `fingerprint` is the phrase the user saw: the
 * key is wrapped only for a public key that gives that phrase, so a server cannot show one key and get another.
 */
export async function answerLoginRequest(id: string, approve: boolean, fingerprint: string): Promise<void> {
  const base = await requireServer();
  const token = await accessToken();
  let key = "";
  if (approve) {
    const account = await getLocal("account");
    const { publicKey } = await getAuthRequest(base, token, id);
    if (!account || (await coreCall<string>({ op: "authRequestFingerprint", email: account.email, publicKey })) !== fingerprint)
      throw new UserError("badServer", "The request changed on the server; nothing was approved");
    key = await coreCall<string>({ op: "authRequestApprove", publicKey });
  }
  await answerAuthRequest(base, token, id, { key, deviceId: await getDeviceId(), approve });
  await dropLoginRequest(id);
}

export async function dropLoginRequest(id: string): Promise<void> {
  const { loginRequests: ids = [] } = await getSession();
  await updateSession({ loginRequests: ids.filter((x) => x !== id) });
}

// ---------- Biometrics (WebAuthn PRF) ----------

/**
 * Turns biometric unlock on: wraps the unlocked user key with a key derived from the
 * authenticator's PRF output. Only the wrapped key is stored; the PRF secret never leaves the
 * platform authenticator, and every unlock requires its user verification (Touch ID / Hello).
 */
export async function setBiometric(credentialId: string, prfSalt: string, prf: string): Promise<void> {
  const account = await getLocal("account");
  if (!account?.userId) throw new UserError("sessionExpired", "Please log in again");
  if (!credentialId || !prfSalt || !prf) throw new UserError("invalid", "The biometric credential is incomplete");
  const protectedUserKey = await coreCall<string>({ op: "prfProtect", prf });
  await setLocal("biometric", { email: account.email, credentialId, prfSalt, protectedUserKey, createdAt: Date.now() });
}

export const removeBiometric = () => removeLocal("biometric").then(() => undefined);

export async function unlockWithBiometric(prf: string): Promise<void> {
  const [account, bio] = await Promise.all([getLocal("account"), getLocal("biometric")]);
  if (!account || !bio || bio.email !== account.email) throw new UserError("wrongPhase", "Biometric unlock is not set up");
  try {
    await coreCall({
      op: "unlockPrf",
      prf,
      protectedUserKey: bio.protectedUserKey,
      encryptedPrivateKey: account.encryptedPrivateKey,
    });
  } catch (e) {
    // A different authenticator/user (or a broken credential) fails the MAC: never retry silently.
    if (e instanceof CoreError) throw new UserError("badBiometric", "Biometric verification failed. Unlock with your master password and set it up again.");
    throw e;
  }
  await afterUnlock(account);
}

// ---------- Master password re-check ----------

/**
 * Confirms the master password with the server (it answers 400 when it is wrong). Used before a whole
 * vault export and for `reprompt` items: the derived key is freed immediately, only the auth hash is
 * used, so nothing extra stays in memory.
 */
export async function verifyMasterPassword(password: string): Promise<void> {
  const base = await requireServer();
  const account = await getLocal("account");
  if (!account) throw new UserError("sessionExpired", "Please log in again");
  const { handle, authHash } = await coreCall<Prepared>({ op: "prepareKey", email: account.email, password, kdf: account.kdf });
  await coreCall({ op: "freeKey", handle }).catch(() => undefined);
  await verifyPassword(base, await accessToken(), authHash).catch((e: unknown) => {
    throw e instanceof ApiError && e.status === 400 ? new UserError("wrongPassword", "Wrong master password") : e;
  });
}

/** Grants one item's re-prompt after the master password checked out. */
export async function confirmReprompt(id: string, password: string): Promise<void> {
  await verifyMasterPassword(password);
  grantReprompt(id);
}

// ---------- PIN (Bitwarden "unlock with PIN", locked with the master password on browser restart) ----------

const PIN_MAX_ATTEMPTS = 5;

async function armPin(account: Account, pin: string): Promise<string> {
  const key = await coreCall<string>({ op: "pinProtect", pin, email: account.email, kdf: PIN_KDF });
  await updateSession({ pin: { email: account.email, key, attempts: 0 } });
  return key;
}

/** Turns PIN unlock on, or off without `pin`. Needs the unlocked vault. */
export async function setPin(pin?: string, pinOnly = false): Promise<void> {
  const account = await getLocal("account");
  if (!account) throw new UserError("wrongPhase", "Not logged in");
  if (pin === undefined) {
    const { protectedPin: _, pinKey: __, pinKdf: ___, ...rest } = account;
    await setLocal("account", rest);
    await updateSession({ pin: undefined });
    return;
  }
  const [protectedPin] = await seal([pin], BLOCK.secret);
  const key = await armPin(account, pin);
  // shortcut: PIN-only keeps the PIN-wrapped key on disk: the 5-try cap holds only in this browser, a copied profile
  // can be brute-forced offline (a 6-digit PIN through the KDF takes hours to days). Parity with the official clients.
  const { pinKey: _, pinKdf: __, ...rest } = account;
  await setLocal("account", { ...rest, protectedPin: protectedPin!, ...(pinOnly ? { pinKey: key, pinKdf: PIN_KDF } : {}) });
}

export async function unlockWithPin(pin: string): Promise<void> {
  const account = await getLocal("account");
  const { pin: s } = await getSession();
  // A key armed this session is always PIN_KDF; one on disk records its KDF (older builds: the account's).
  const p =
    s && s.email === account?.email
      ? { ...s, kdf: s.kdf ?? PIN_KDF }
      : account?.pinKey
        ? { email: account.email, key: account.pinKey, attempts: 0, kdf: account.pinKdf ?? account.kdf }
        : undefined;
  if (!account?.protectedPin || !p) throw new UserError("wrongPhase", "Unlock with the master password");
  try {
    await coreCall({ op: "unlockPin", pin, email: account.email, kdf: p.kdf, protectedUserKey: p.key, encryptedPrivateKey: account.encryptedPrivateKey });
  } catch (e) {
    if (!(e instanceof CoreError)) throw e;
    // Like the official clients: a few wrong PINs end the session instead of allowing a slow brute force.
    if (p.attempts + 1 >= PIN_MAX_ATTEMPTS) {
      await logout();
      throw new UserError("wrongPassword", "Too many wrong PINs, you have been logged out");
    }
    await updateSession({ pin: { ...p, attempts: p.attempts + 1 } });
    throw new UserError("wrongPassword", "Wrong PIN");
  }
  await afterUnlock(account); // also resets the wrong-PIN count
}

export async function logout(): Promise<void> {
  stopPush();
  await lockNow();
  await removeLocal("account", "vault", "genHistory", "aliasSettings", "biometric", "private", "wordlist");
  await chrome.storage.local.remove("lastUsed"); // clear-text stamps of older builds
  await updateSession({ accessToken: undefined, accessExpiresAt: undefined, refreshToken: undefined, pin: undefined, loginRequests: undefined });
}

const currentRefreshToken = async (): Promise<string | undefined> => (await getSession()).refreshToken ?? (await getLocal("account"))?.refreshToken;

/**
 * Like the official clients: with "log out" as the timeout action the refresh token is kept in memory only
 * (storage.session), so a copied profile holds none and the session ends with the browser. Otherwise it is on
 * disk, where it lets a locked vault sync after a restart without a new login and 2FA.
 */
async function storeRefreshToken(token: string | undefined): Promise<void> {
  const inMemory = (await getSettings()).timeoutAction === "logout";
  const account = await getLocal("account");
  if (account) {
    const { refreshToken: _, ...rest } = account;
    await setLocal("account", token && !inMemory ? { ...rest, refreshToken: token } : rest);
  }
  await updateSession({ refreshToken: token && inMemory ? token : undefined });
}

/** After the timeout action changed: moves the token to where that action keeps it. */
export const relocateRefreshToken = async (): Promise<void> => storeRefreshToken(await currentRefreshToken());

/** The refresh in flight, if any. The server may rotate the refresh token, so a second concurrent
 * refresh would be sent a spent one and fail (and end in a logout). Rebuildable: a restart just starts over. */
let refreshing: Promise<string> | undefined;

/** Returns a valid access token, refreshing it when it expires within a minute. */
export async function accessToken(): Promise<string> {
  const s = await getSession();
  if (s.accessToken && (s.accessExpiresAt ?? 0) - 60_000 > Date.now()) return s.accessToken;
  refreshing ??= refreshAccessToken().finally(() => (refreshing = undefined));
  return refreshing;
}

async function refreshAccessToken(): Promise<string> {
  const base = await requireServer();
  const current = await currentRefreshToken();
  if (!current) {
    // Kept in memory only ("log out" timeout action) and gone with an extension update: the session is over.
    if ((await getSettings()).timeoutAction === "logout" && (await getLocal("account"))) await logout();
    throw new UserError("sessionExpired", "Please log in again");
  }
  let t: TokenResponse;
  try {
    t = await refreshToken(base, current);
  } catch (e) {
    if (e instanceof ApiError && (e.status === 400 || e.status === 401)) {
      await logout();
      throw new UserError("sessionExpired", "Your session expired, please log in again");
    }
    throw e;
  }
  const tokens = toTokens(t);
  if (tokens.refreshToken && tokens.refreshToken !== current) await storeRefreshToken(tokens.refreshToken);
  await updateSession({ accessToken: tokens.accessToken, accessExpiresAt: tokens.expiresAt });
  return tokens.accessToken;
}

// ---------- SSO (Vaultwarden OpenID Connect) ----------
// client_id "browser" makes Vaultwarden redirect to <server>/sso-connector.html. A content script
// registered for exactly that page reports the URL back (finishSso). SSO only authenticates: the
// vault is still unlocked with the master password, so the account ends up "locked".

const SSO_SCRIPT = "warren-sso-callback";
const b64u = (b: Uint8Array) => b.toBase64({ alphabet: "base64url", omitPadding: true });
const connectorUrl = (base: string) => `${base}/sso-connector.html`;

export async function startSso(): Promise<void> {
  const base = await requireServer();
  await ssoPrevalidate(base).catch((e: unknown) => {
    if (e instanceof ApiError) throw new UserError("badServer", "SSO is not enabled on this server");
    throw e;
  });
  const verifier = b64u(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64u(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
  // The suffix makes the connector page show its hand-off message instead of starting a web vault login.
  const state = `${b64u(crypto.getRandomValues(new Uint8Array(16)))}:clientId=browser`;
  await updateSession({ sso: { state, verifier, expiresAt: Date.now() + PENDING_TTL_MS }, ssoError: undefined });
  await chrome.scripting.unregisterContentScripts({ ids: [SSO_SCRIPT] }).catch(() => undefined);
  await chrome.scripting.registerContentScripts([{ id: SSO_SCRIPT, js: ["sso-callback.js"], matches: [`${connectorUrl(base)}*`], runAt: "document_start" }]);
  const q = new URLSearchParams({
    client_id: "browser",
    redirect_uri: connectorUrl(base),
    response_type: "code",
    scope: "api offline_access",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  await chrome.tabs.create({ url: `${base}/identity/connect/authorize?${q}` });
}

/** `url` is the connector page URL as seen by the browser (sender.url), never a value from the page. */
export async function finishSso(url: string, tabId: number): Promise<void> {
  const base = await requireServer();
  if (!url.startsWith(`${connectorUrl(base)}?`)) return;
  const { sso } = await getSession();
  await chrome.scripting.unregisterContentScripts({ ids: [SSO_SCRIPT] }).catch(() => undefined);
  const params = new URL(url).searchParams;
  try {
    if (!sso || sso.expiresAt < Date.now() || params.get("state") !== sso.state)
      throw new UserError("sessionExpired", "The SSO login expired or did not come from this browser, please try again");
    const code = params.get("code");
    if (!code) throw new UserError("badCredentials", "The identity provider did not sign you in");
    let t: TokenResponse;
    try {
      t = await authorizationCodeToken(base, code, sso.verifier, connectorUrl(base), await getDeviceId());
    } catch (e) {
      if (e instanceof TwoFactorRequired) throw new UserError("badTwoFactor", "Two-step login together with SSO is not supported yet");
      mapLoginError(e);
    }
    const email = jwtClaim(t.access_token, "email");
    if (!email) throw new UserError("badServer", "The server did not return the account email");
    if (!t.Key) throw new UserError("badServer", "This account has no master password yet; set one in the web vault first");
    await lockNow();
    await removeLocal("vault");
    const tokens = toTokens(t);
    await setLocal("account", {
      email,
      userId: jwtSubject(t.access_token),
      kdf: kdfFromToken(t, await prelogin(base, email)),
      protectedUserKey: t.Key,
      encryptedPrivateKey: t.PrivateKey,
    });
    await storeRefreshToken(tokens.refreshToken);
    await updateSession({ sso: undefined, pin: undefined, accessToken: tokens.accessToken, accessExpiresAt: tokens.expiresAt });
  } catch (e) {
    await updateSession({ sso: undefined, ssoError: e instanceof Error ? e.message : String(e) });
    if (!(e instanceof UserError)) throw e;
  } finally {
    // Closed only once the outcome is stored, so a popup opened right after shows it.
    await chrome.tabs.remove(tabId).catch(() => undefined);
  }
}
