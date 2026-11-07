// Login, 2FA, unlock, token refresh. Pure orchestration: crypto runs in the offscreen worker,
// HTTP in src/transport.
import { KDF_ARGON2ID, PIN_KDF, TWO_FACTOR } from "../shared/constants.ts";
import type { CoreRequest, KdfParams, LoginRequest } from "../shared/messages.ts";
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
import { b64u } from "../shared/url.ts";
import { verifyPassword } from "../transport/vault.ts";
import { CoreError, coreAlive, coreCall } from "./core.ts";
import { UserError } from "./errors.ts";
import { ARGON2_MIN, kdfDowngrade, kdfText, PBKDF2_MIN, PIN_ONLY_MIN, pinOnlyStrong, raiseFloor, tooWeak } from "./kdf.ts";
import { assertEpoch, assertOwner, lockEpoch, lockNow, newOwner, ownerEpoch, touchAutoLock } from "./lock.ts";
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

export { UserError };

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

/**
 * Every KDF from the server passes here before a hash made with it is sent or stored: see kdf.ts. Keyed like
 * rememberTokens, so the floor outlives a logout without leaving the email on disk.
 */
async function guardKdf(serverUrl: string, email: string, kdf: KdfParams): Promise<KdfParams> {
  if (tooWeak(kdf))
    throw new UserError(
      "badServer",
      `This account's key derivation (${kdfText(kdf)}) is too weak: Warren does not send a hash of your master password made with less than PBKDF2 ${PBKDF2_MIN} iterations or Argon2id ${ARGON2_MIN.memory} MiB x ${ARGON2_MIN.iterations}. Raise it in the web vault (Settings → Security → Keys, Argon2id recommended) and log in again.`,
    );
  const key = await rememberKey(`kdf|${serverUrl}`, email);
  const floors = (await getLocal("kdfFloors")) ?? {};
  if (kdfDowngrade(kdf, floors[key]))
    throw new UserError("badServer", "The server asks for a much weaker key derivation than this account used before. Your master password was not sent. If you did not change the KDF in the web vault, the server may be compromised.");
  await setLocal("kdfFloors", { ...floors, [key]: raiseFloor(kdf, floors[key]) });
  return kdf;
}

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

/**
 * Runs `write` if no lock came since `epoch` (lockEpoch() from before the first await), in the same tick as the
 * check, so none can slip in between. One a lock overtook locks again instead, dropping the keys it may have loaded
 * into a fresh worker, and throws once that lock is done (the next request in the queue then starts clean).
 */
async function checkEpoch(epoch: number): Promise<void>;
async function checkEpoch<T>(epoch: number, write: () => Promise<T>): Promise<T>;
async function checkEpoch<T>(epoch: number, write?: () => Promise<T>): Promise<T | undefined> {
  if (lockEpoch() === epoch) return write?.();
  await lockNow();
  throw new UserError("sessionExpired", "The vault was locked meanwhile, please try again");
}

async function completeLogin(serverUrl: string, email: string, kdf: KdfParams, via: Opener, t: TokenResponse, epoch: number): Promise<void> {
  await checkEpoch(epoch);
  if (!t.Key) throw new UserError("badServer", "Server did not return an encrypted user key");
  // The KDF later unlocks and re-prompts use (and send a hash of): the token's, checked like prelogin's.
  const accountKdf = await guardKdf(serverUrl, email, kdfFromToken(t, kdf));
  const op: CoreRequest = via.device
    ? { op: "authRequestUnlock", key: via.device.key, encryptedPrivateKey: t.PrivateKey }
    : { op: "unlock", handle: via.handle, protectedUserKey: t.Key, encryptedPrivateKey: t.PrivateKey };
  try {
    await coreCall(op);
  } catch (e) {
    throw new UserError("badServer", `Could not decrypt the account key: ${(e as Error).message}`);
  }
  const tokens = toTokens(t);
  const account: Account = {
    email,
    userId: jwtSubject(t.access_token),
    kdf: accountKdf,
    protectedUserKey: t.Key,
    encryptedPrivateKey: t.PrivateKey,
  };
  const owner = await checkEpoch(epoch, async () => {
    // Another account from here: a refresh, a sync or a hub begun for the one before must not write over this one.
    const mine = newOwner();
    await removeLocal("vault"); // never show a previous account's cache
    return mine;
  });
  await checkEpoch(epoch, () => setLocal("account", account));
  await storeRefreshToken(tokens.refreshToken, owner);
  if (t.TwoFactorToken) {
    const remember = (await getLocal("rememberTokens")) ?? {};
    await setLocal("rememberTokens", { ...remember, [await rememberKey(serverUrl, email)]: t.TwoFactorToken });
  }
  await checkEpoch(epoch, () =>
    updateSession({
      unlocked: true,
      accessToken: tokens.accessToken,
      accessExpiresAt: tokens.expiresAt,
      pending: undefined,
      ssoError: undefined,
      sso: undefined, // an SSO login still waiting must not replace this account when its callback comes late
      pin: undefined,
    }),
  );
  await touchAutoLock(epoch);
}

function mapLoginError(e: unknown): never {
  if (e instanceof UserError) throw e;
  if (e instanceof ApiError && (e.status === 400 || e.status === 401))
    throw new UserError("badCredentials", e.message);
  throw e;
}

/**
 * A login begins with a lock and owns that lock's epoch, not a later one: a lock that comes while it runs ends it,
 * also one that came while it read the server (`before`: lockEpoch() from before that read).
 */
async function loginLock(before: number): Promise<number> {
  const epoch = await lockNow();
  if (epoch !== before + 1) throw new UserError("sessionExpired", "The vault was locked meanwhile, please try again");
  return epoch;
}

export async function login(rawEmail: string, password: string): Promise<void> {
  const before = lockEpoch();
  const base = await requireServer();
  const email = rawEmail.trim().toLowerCase();
  if (!email || !password) throw new UserError("invalid", "Email and master password are required");
  const epoch = await loginLock(before);

  const kdf = await guardKdf(base, email, await prelogin(base, email));
  const { handle, authHash } = await prepareKey(email, password, kdf);
  try {
    await passwordLogin(base, email, kdf, authHash, { handle }, epoch);
  } catch (e) {
    // Only a live worker holds the handle: a lock that ended this login closed it, and a call would open a new one.
    if (await coreAlive()) await coreCall({ op: "freeKey", handle }).catch(() => undefined);
    mapLoginError(e);
  }
}

/**
 * The token grant of a password or device login, with the 2FA "remember me" token when we have one. A 2FA
 * challenge becomes a pending login (resolves); any other failure is thrown.
 */
async function passwordLogin(base: string, email: string, kdf: KdfParams, authHash: string, via: Opener, epoch: number): Promise<void> {
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
    await completeLogin(base, email, kdf, via, t, epoch);
  } catch (e) {
    if (!(e instanceof TwoFactorRequired)) throw e;
    await checkEpoch(epoch);
    if (remembered) {
      // The server rejected (or expired) our remember token: forget it and ask for a real code.
      const all = (await getLocal("rememberTokens")) ?? {};
      delete all[key];
      await setLocal("rememberTokens", all);
    }
    const expiresAt = Date.now() + PENDING_TTL_MS;
    await checkEpoch(epoch, () => updateSession({ pending: { email, kdf, handle: via.handle, challenge: e.challenge, expiresAt, ...(via.device ? { device: via.device } : {}) } }));
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
  const epoch = lockEpoch();
  const base = await requireServer();
  const { pending, authHash } = await requirePending();
  if (!pending.challenge.providers.includes(provider)) throw new UserError("invalid", "Provider not offered by server");
  // WebAuthn tokens are the assertion JSON from the connector page; codes may be typed with spaces.
  const code = provider === TWO_FACTOR.WebAuthn ? token : token.replace(/\s+/g, "");
  if (!code) throw new UserError("invalid", "Enter the verification code");
  const grant = { email: pending.email, authHash, deviceId: await getDeviceId(), authRequest: pending.device?.id };
  try {
    const t = await passwordToken(base, { ...grant, twoFactor: { provider, token: code, remember } });
    await completeLogin(base, pending.email, pending.kdf, pending, t, epoch);
  } catch (e) {
    if (!(e instanceof TwoFactorRequired || (e instanceof ApiError && e.status === 400))) throw e;
    if (provider === TWO_FACTOR.WebAuthn || provider === TWO_FACTOR.Duo || provider === TWO_FACTOR.OrganizationDuo) {
      // Vaultwarden deletes the WebAuthn challenge (and the Duo state) on every attempt; ask for a fresh one.
      await passwordToken(base, grant).catch(async (r: unknown) => {
        if (r instanceof TwoFactorRequired) await updateSession({ pending: { ...pending, challenge: r.challenge } });
      });
    }
    throw new UserError("badTwoFactor", e instanceof ApiError ? e.message : "Invalid verification code");
  }
}

/** Duo's authorize endpoint only, like the clients' duo-redirect connector: the server cannot send the user elsewhere. */
export function duoUrl(raw: string): string {
  const u = URL.parse(raw);
  if (!u || u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443") || u.pathname !== "/oauth/v1/authorize" || !/^api-[a-zA-Z0-9]+\.(duosecurity|duofederal)\.com$/.test(u.hostname))
    throw new UserError("badServer", "The server sent a Duo address that is not Duo's");
  return u.href;
}

export async function startDuo(remember: boolean): Promise<void> {
  const { pending } = await requirePending();
  const duo = pending.challenge.duo;
  if (!duo) throw new UserError("invalid", "Duo two-step login is not enabled for this account");
  const tab = await chrome.tabs.create({ url: duoUrl(duo.url) });
  if (tab.id !== undefined) await updateSession({ duo: { tabId: tab.id, provider: duo.provider, remember }, ssoError: undefined });
}

/**
 * Duo sends the user back to the server's duo-redirect-connector.html with `code` and `state`. Only in the tab we
 * opened, and only on the configured server: then the result is our pending login's second factor.
 */
export async function duoTabUpdated(tabId: number, url: string): Promise<void> {
  const { duo } = await getSession();
  if (duo?.tabId !== tabId) return;
  const server = (await getLocal("server"))?.url;
  const u = URL.parse(url);
  if (!server || !u) return;
  const connector = new URL("duo-redirect-connector.html", server.endsWith("/") ? server : `${server}/`);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state");
  if (!code || !state || !u.pathname.endsWith("/duo-redirect-connector.html")) return;
  if (u.origin !== connector.origin || u.pathname !== connector.pathname) {
    // The server's DOMAIN setting differs from the address Warren uses: say so instead of waiting forever.
    await updateSession({ duo: undefined, ssoError: `Duo returned to ${u.origin}${u.pathname}, not to ${connector.href}. Set the server address in Warren to the server's DOMAIN.` });
    return;
  }
  await updateSession({ duo: undefined });
  void chrome.tabs.remove(tabId).catch(() => undefined);
  try {
    await submitTwoFactor(duo.provider, `${code}|${state}`, duo.remember);
  } catch (e) {
    await updateSession({ ssoError: e instanceof Error ? e.message : String(e) });
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
  // Before the first await: a lock that comes during any of them ends this unlock.
  const epoch = lockEpoch();
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
  await afterUnlock(account, epoch);
}

/** Shared tail of every unlock path (master password, PIN, biometrics). */
async function afterUnlock(account: Account, epoch: number): Promise<void> {
  await checkEpoch(epoch, () => updateSession({ unlocked: true }));
  await touchAutoLock(epoch);
  // After a browser restart the PIN-wrapped key is gone: re-arm it from the stored PIN.
  const { pin } = await getSession();
  const [plain] = account.protectedPin ? await unseal([account.protectedPin]) : [];
  if (plain && account.pinKey && !pinOnlyStrong(plain)) {
    // A PIN-only key set before the strength rule, behind a short number: the PIN keeps working until the browser
    // restarts, and after one the master password is asked again.
    await armPin(account, plain, epoch);
    const fresh = await getLocal("account");
    if (fresh?.pinKey === account.pinKey) {
      const { pinKey: _, pinKdf: __, ...rest } = fresh;
      await checkEpoch(epoch, () => setLocal("account", rest));
    }
  } else if (plain && !account.pinKey && pin?.email !== account.email) {
    await armPin(account, plain, epoch);
  } else if (plain && account.pinKey && JSON.stringify(account.pinKdf) !== JSON.stringify(PIN_KDF)) {
    // A PIN-only key from an older build is wrapped through the account KDF: re-wrap it with PIN_KDF once.
    const key = await armPin(account, plain, epoch);
    const fresh = await getLocal("account");
    if (fresh?.pinKey === account.pinKey) await checkEpoch(epoch, () => setLocal("account", { ...fresh, pinKey: key, pinKdf: PIN_KDF }));
  } else if (pin?.attempts) await checkEpoch(epoch, () => updateSession({ pin: { ...pin, attempts: 0 } }));
  // Older builds kept never-save hosts and fill stamps in clear text; a failed move is retried next unlock.
  await migratePrivate().catch(() => undefined);
  await resealLegacy().catch(() => undefined);
  // Seals a token that came while locked, and the clear-text one of older builds.
  await relocateRefreshToken().catch(() => undefined);
}

// ---------- Log in with device (Bitwarden auth requests) ----------
// Another logged-in device wraps the user key for a one-off RSA key held in the crypto worker; the token is
// granted with the request's access code instead of the password hash.

/** Vaultwarden only grants a token within 5 minutes of the request. */
const DEVICE_LOGIN_TTL_MS = 5 * 60_000;

export async function startDeviceLogin(rawEmail: string): Promise<void> {
  const before = lockEpoch();
  const base = await requireServer();
  const email = rawEmail.trim().toLowerCase();
  if (!email) throw new UserError("invalid", "Enter your email address");
  const epoch = await loginLock(before);
  const { publicKey, fingerprint } = await coreCall<{ publicKey: string; fingerprint: string }>({ op: "authRequestCreate", email });
  const accessCode = b64u(crypto.getRandomValues(new Uint8Array(24)));
  const r = await createAuthRequest(base, { email, publicKey, deviceId: await getDeviceId(), accessCode }).catch((e: unknown) => {
    // Vaultwarden refuses an unknown account and a device id it has never seen log in to that account (both 400).
    if (e instanceof ApiError && e.status === 400)
      throw new UserError("badCredentials", "Log in with device works once this browser has logged in to the account with the master password");
    throw e;
  });
  const expiresAt = Date.now() + DEVICE_LOGIN_TTL_MS;
  // A lock meanwhile dropped the request's key: no request to wait for.
  await checkEpoch(epoch, () => updateSession({ deviceLogin: { email, id: r.id, accessCode, fingerprint, expiresAt }, ssoError: undefined }));
  await chrome.alarms.create(PENDING_ALARM, { when: expiresAt });
}

/** Polled by the popup: finishes the login once another device approved the request. */
export async function checkDeviceLogin(): Promise<void> {
  const epoch = lockEpoch();
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
    await passwordLogin(base, d.email, await prelogin(base, d.email), d.accessCode, { handle: 0, device: { id: d.id, accessCode: d.accessCode, key: r.key } }, epoch);
  } catch (e) {
    mapLoginError(e);
  }
}

/** Other devices' requests waiting for this one, with the phrase to compare. */
export async function loginRequests(): Promise<LoginRequest[]> {
  const owner = ownerEpoch();
  const account = await getLocal("account");
  if (!account) throw new UserError("sessionExpired", "Please log in again");
  const { base, token } = await auth(owner);
  const all = await pendingAuthRequests(base, token);
  const list: LoginRequest[] = [];
  for (const r of all) {
    const fingerprint = await coreCall<string>({ op: "authRequestFingerprint", email: account.email, publicKey: r.publicKey }).catch(() => undefined);
    if (fingerprint) list.push({ id: r.id, fingerprint, device: r.requestDeviceType ?? "", ip: r.requestIpAddress ?? "", createdAt: Date.parse(r.creationDate) });
  }
  // What the server still has pending is the truth; requests that came in by push but are gone drop out here.
  assertOwner(owner);
  await updateSession({ loginRequests: list.map((r) => r.id) });
  return list;
}

/**
 * Approves (wraps the user key for the requester) or denies a request. `fingerprint` is the phrase the user saw: the
 * key is wrapped only for a public key that gives that phrase, so a server cannot show one key and get another.
 */
export async function answerLoginRequest(id: string, approve: boolean, fingerprint: string): Promise<void> {
  const owner = ownerEpoch();
  const { base, token } = await auth(owner);
  let key = "";
  if (approve) {
    const account = await getLocal("account");
    const { publicKey } = await getAuthRequest(base, token, id);
    if (!account || (await coreCall<string>({ op: "authRequestFingerprint", email: account.email, publicKey })) !== fingerprint)
      throw new UserError("badServer", "The request changed on the server; nothing was approved");
    key = await coreCall<string>({ op: "authRequestApprove", publicKey });
  }
  const deviceId = await getDeviceId();
  // The wrapped key is this account's: it goes to its server only.
  assertOwner(owner);
  await answerAuthRequest(base, token, id, { key, deviceId, approve });
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
  const epoch = lockEpoch();
  const account = await getLocal("account");
  if (!account?.userId) throw new UserError("sessionExpired", "Please log in again");
  if (!credentialId || !prfSalt || !prf) throw new UserError("invalid", "The biometric credential is incomplete");
  const protectedUserKey = await coreCall<string>({ op: "prfProtect", prf });
  // A logout meanwhile removed biometric unlock: it stays removed.
  await checkEpoch(epoch, () => setLocal("biometric", { email: account.email, credentialId, prfSalt, protectedUserKey, createdAt: Date.now() }));
}

export const removeBiometric = () => removeLocal("biometric").then(() => undefined);

export async function unlockWithBiometric(prf: string): Promise<void> {
  const epoch = lockEpoch();
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
  await afterUnlock(account, epoch);
}

// ---------- Master password re-check ----------

/**
 * Confirms the master password with the server (it answers 400 when it is wrong). Used before a whole
 * vault export and for `reprompt` items: the derived key is freed immediately, only the auth hash is
 * used, so nothing extra stays in memory.
 */
export async function verifyMasterPassword(password: string): Promise<void> {
  const owner = ownerEpoch();
  const account = await getLocal("account");
  if (!account) throw new UserError("sessionExpired", "Please log in again");
  // An account stored by a build before the KDF floor may still have one too weak to send a hash of (see guardKdf).
  if (tooWeak(account.kdf))
    throw new UserError("badServer", `This account's key derivation (${kdfText(account.kdf)}) is too weak to confirm the master password with the server. Raise it in the web vault (Settings → Security → Keys) and log in again.`);
  const { handle, authHash } = await coreCall<Prepared>({ op: "prepareKey", email: account.email, password, kdf: account.kdf });
  await coreCall({ op: "freeKey", handle }).catch(() => undefined);
  // The hash, the account it was made for and the token are one account's: a switch meanwhile sends nothing.
  const { base, token } = await auth(owner);
  await verifyPassword(base, token, authHash).catch((e: unknown) => {
    throw e instanceof ApiError && e.status === 400 ? new UserError("wrongPassword", "Wrong master password") : e;
  });
}

/** Grants one item's re-prompt after the master password checked out. */
export async function confirmReprompt(id: string, password: string): Promise<void> {
  const epoch = lockEpoch();
  await verifyMasterPassword(password);
  assertEpoch(epoch);
  grantReprompt(id);
}

// ---------- PIN (Bitwarden "unlock with PIN", locked with the master password on browser restart) ----------

const PIN_MAX_ATTEMPTS = 5;

async function armPin(account: Account, pin: string, epoch: number): Promise<string> {
  const key = await coreCall<string>({ op: "pinProtect", pin, email: account.email, kdf: PIN_KDF });
  await checkEpoch(epoch, () => updateSession({ pin: { email: account.email, key, attempts: 0 } }));
  return key;
}

/** Turns PIN unlock on, or off without `pin`. Needs the unlocked vault. */
export async function setPin(pin?: string, pinOnly = false): Promise<void> {
  const epoch = lockEpoch();
  const account = await getLocal("account");
  if (!account) throw new UserError("wrongPhase", "Not logged in");
  if (pin === undefined) {
    const { protectedPin: _, pinKey: __, pinKdf: ___, ...rest } = account;
    await checkEpoch(epoch, () => setLocal("account", rest)); // a logout meanwhile: no account to write back
    await updateSession({ pin: undefined });
    return;
  }
  // PIN-only keeps the PIN-wrapped key on disk, where the 5-try cap does not hold: only a PIN that is not a short
  // number may open the vault alone.
  if (pinOnly && !pinOnlyStrong(pin))
    throw new UserError("invalid", `Without the master password after a restart, the PIN needs at least ${PIN_ONLY_MIN} characters and one that is not a digit`);
  const [protectedPin] = await seal([pin], BLOCK.secret);
  const key = await armPin(account, pin, epoch);
  const { pinKey: _, pinKdf: __, ...rest } = account;
  await checkEpoch(epoch, () => setLocal("account", { ...rest, protectedPin: protectedPin!, ...(pinOnly ? { pinKey: key, pinKdf: PIN_KDF } : {}) }));
}

export async function unlockWithPin(pin: string): Promise<void> {
  const epoch = lockEpoch();
  const owner = ownerEpoch();
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
    // Counted across a lock (one would otherwise reset the cap), never into the session of a later login.
    assertOwner(owner);
    await updateSession({ pin: { ...p, attempts: p.attempts + 1 } });
    throw new UserError("wrongPassword", "Wrong PIN");
  }
  await afterUnlock(account, epoch); // also resets the wrong-PIN count
}

export async function logout(): Promise<void> {
  newOwner();
  stopPush();
  await lockNow();
  await removeLocal("account", "vault", "genHistory", "aliasSettings", "biometric", "private", "wordlist");
  await chrome.storage.local.remove("lastUsed"); // clear-text stamps of older builds
  // An SSO login still waiting for its callback ends here too: a late one must not log an account back in.
  await updateSession({ accessToken: undefined, accessExpiresAt: undefined, refreshToken: undefined, pin: undefined, loginRequests: undefined, sso: undefined });
  await chrome.scripting.unregisterContentScripts({ ids: [SSO_SCRIPT] }).catch(() => undefined);
}

/**
 * The token in memory (this browser session), else the disk copy, which only an unlocked vault can open: after a
 * restart a locked vault does not reach the server until the first unlock.
 */
async function currentRefreshToken(owner: number): Promise<string | undefined> {
  const s = await getSession();
  if (s.refreshToken) return s.refreshToken;
  const account = await getLocal("account");
  if (account?.refreshToken) return account.refreshToken; // clear text of older builds, sealed on the next unlock
  if (!account?.refreshTokenEnc) return undefined;
  if (!s.unlocked) throw new UserError("wrongPhase", "Unlock to connect to the server");
  const [plain] = await unseal([account.refreshTokenEnc]);
  assertOwner(owner);
  if (plain) await updateSession({ refreshToken: plain });
  return plain || undefined;
}

/**
 * The token is always in memory (storage.session). On disk it is sealed with the user key, so a copied profile
 * cannot use it; with "log out" as the timeout action (like the official clients) it is not on disk at all.
 * Sealing needs the vault unlocked: a token that arrives while locked (SSO login, rotation) is sealed at the next
 * unlock, and until then the previous disk copy stays. Written only while `owner` (the account it belongs to) is.
 */
async function storeRefreshToken(token: string | undefined, owner: number): Promise<void> {
  const onDisk = !!token && (await getSettings()).timeoutAction !== "logout";
  const [sealed] = onDisk ? await seal([token!], BLOCK.secret).catch(() => [undefined]) : [undefined];
  const account = await getLocal("account");
  if (account) {
    const { refreshToken: _, refreshTokenEnc: previous, ...rest } = account;
    const enc = onDisk ? (sealed ?? previous) : undefined;
    assertOwner(owner);
    await setLocal("account", enc ? { ...rest, refreshTokenEnc: enc } : rest);
  }
  assertOwner(owner);
  await updateSession({ refreshToken: token });
}

/** After the timeout action changed: moves the token to where that action keeps it. */
export async function relocateRefreshToken(): Promise<void> {
  const owner = ownerEpoch();
  await storeRefreshToken(await currentRefreshToken(owner), owner);
}

/** The refresh in flight, if any, and whose. The server may rotate the refresh token, so a second concurrent
 * refresh would be sent a spent one and fail (and end in a logout). Rebuildable: a restart just starts over. */
let refreshing: Promise<{ token: string; owner: number }> | undefined;

/**
 * The server and a valid access token for it (refreshed when it expires within a minute), read as one under
 * `owner` and checked against it: a token never goes to a server or account it was not issued for. Pass the owner
 * taken before reading other account data (the email, the user id) the request goes out with.
 */
export async function auth(owner = ownerEpoch()): Promise<{ base: string; token: string }> {
  const base = await requireServer();
  const s = await getSession();
  let token = s.accessToken;
  if (!token || (s.accessExpiresAt ?? 0) - 60_000 <= Date.now()) {
    refreshing ??= refreshAccessToken().finally(() => (refreshing = undefined));
    const r = await refreshing;
    assertOwner(owner, r.owner); // a refresh begun for an account before this one shares nothing with it
    token = r.token;
  }
  assertOwner(owner);
  return { base, token };
}

async function refreshAccessToken(): Promise<{ token: string; owner: number }> {
  const owner = ownerEpoch();
  const base = await requireServer();
  const current = await currentRefreshToken(owner);
  if (!current) {
    // Kept in memory only ("log out" timeout action) and gone with an extension update: the session is over.
    if ((await getSettings()).timeoutAction === "logout" && (await getLocal("account")) && owner === ownerEpoch()) await logout();
    throw new UserError("sessionExpired", "Please log in again");
  }
  let t: TokenResponse;
  try {
    // The server and the token read above belong to one account: never send a server another one's token.
    assertOwner(owner);
    t = await refreshToken(base, current);
  } catch (e) {
    // A login, logout or server change while the request was out: the refusal is the old account's, not this one's.
    if (e instanceof ApiError && (e.status === 400 || e.status === 401) && owner === ownerEpoch()) {
      await logout();
      throw new UserError("sessionExpired", "Your session expired, please log in again");
    }
    throw e;
  }
  assertOwner(owner);
  const tokens = toTokens(t);
  if (tokens.refreshToken && tokens.refreshToken !== current) await storeRefreshToken(tokens.refreshToken, owner);
  assertOwner(owner);
  await updateSession({ accessToken: tokens.accessToken, accessExpiresAt: tokens.expiresAt });
  return { token: tokens.accessToken, owner };
}

// ---------- SSO (Vaultwarden OpenID Connect) ----------
// client_id "browser" makes Vaultwarden redirect to <server>/sso-connector.html. A content script
// registered for exactly that page reports the URL back (finishSso). SSO only authenticates: the
// vault is still unlocked with the master password, so the account ends up "locked".

const SSO_SCRIPT = "warren-sso-callback";
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

/**
 * `url` is the connector page URL as seen by the browser (sender.url), never a value from the page. A login or
 * logout since startSso dropped `sso` (so the state check fails); one while this runs changes the owner.
 */
export async function finishSso(url: string, tabId: number): Promise<void> {
  const owner = ownerEpoch();
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
    // Normalized like login(): the KDF floor is keyed by the email, and the server writes this one.
    const email = jwtClaim(t.access_token, "email")?.trim().toLowerCase();
    if (!email) throw new UserError("badServer", "The server did not return the account email");
    if (!t.Key) throw new UserError("badServer", "This account has no master password yet; set one in the web vault first");
    const kdf = await guardKdf(base, email, kdfFromToken(t, await prelogin(base, email)));
    const tokens = toTokens(t);
    assertOwner(owner);
    // Another account from here: whatever began for the one before is stale.
    const mine = newOwner();
    await lockNow();
    assertOwner(mine);
    await removeLocal("vault");
    assertOwner(mine);
    await setLocal("account", { email, userId: jwtSubject(t.access_token), kdf, protectedUserKey: t.Key, encryptedPrivateKey: t.PrivateKey });
    await storeRefreshToken(tokens.refreshToken, mine);
    assertOwner(mine);
    await updateSession({ sso: undefined, pin: undefined, accessToken: tokens.accessToken, accessExpiresAt: tokens.expiresAt });
  } catch (e) {
    await updateSession({ sso: undefined, ssoError: e instanceof Error ? e.message : String(e) });
    if (!(e instanceof UserError)) throw e;
  } finally {
    // Closed only once the outcome is stored, so a popup opened right after shows it.
    await chrome.tabs.remove(tabId).catch(() => undefined);
  }
}
