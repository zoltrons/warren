// Identity endpoints (mirrors vaultwarden src/api/identity.rs, see upstream-map.yaml).
import { CLIENT_NAME, DEVICE_NAME, DEVICE_TYPE, TWO_FACTOR } from "../shared/constants.ts";
import type { KdfParams, TwoFactorChallenge } from "../shared/messages.ts";
import { arr, bool, ci, literal, num, obj, opt, parse, str, u32 } from "../shared/validate.ts";
import { ApiError, call } from "./http.ts";

// PBKDF2 or Argon2id, and whole numbers the crypto core's u32 parameters hold: anything else is refused here,
// before kdf.ts compares it (2^32 + 5000 would reach the core as 5000).
const kdfType = literal(0, 1);
const preloginResponse = obj({ kdf: kdfType, kdfIterations: u32, kdfMemory: opt(u32), kdfParallelism: opt(u32) });

export async function prelogin(base: string, email: string): Promise<KdfParams> {
  const r = parse(preloginResponse, await call(base, "POST", "/identity/accounts/prelogin", { json: { email } }));
  return { type: r.kdf, iterations: r.kdfIterations, memory: r.kdfMemory ?? 0, parallelism: r.kdfParallelism ?? 0 };
}

const tokenResponse = obj({
  access_token: str,
  expires_in: num,
  refresh_token: opt(str),
  Key: opt(str),
  PrivateKey: opt(str),
  Kdf: opt(kdfType),
  KdfIterations: opt(u32),
  KdfMemory: opt(u32),
  KdfParallelism: opt(u32),
  TwoFactorToken: opt(str),
});
export type TokenResponse = ReturnType<typeof tokenResponse>;

export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms */
  expiresAt: number;
}

export const toTokens = (t: TokenResponse, now = Date.now()): Tokens => ({
  accessToken: t.access_token,
  refreshToken: t.refresh_token,
  expiresAt: now + t.expires_in * 1000,
});

export class TwoFactorRequired extends Error {
  override name = "TwoFactorRequired";
  readonly challenge: TwoFactorChallenge;
  constructor(challenge: TwoFactorChallenge) {
    super("Two-factor authentication required");
    this.challenge = challenge;
  }
}

/** Recognizes Vaultwarden's 400 `{"error":"invalid_grant","TwoFactorProviders":[...]}` body. */
export function parseTwoFactorChallenge(body: unknown): TwoFactorChallenge | undefined {
  const providers = ci(body, "TwoFactorProviders");
  if (!Array.isArray(providers)) return undefined;
  const ids = providers.map(Number).filter(Number.isInteger);
  // An empty (or non-numeric) list is not a challenge: Vaultwarden also sends the key on plain
  // errors, and treating those as 2FA would show a dead-end screen instead of "wrong password".
  if (!ids.length) return undefined;
  const p2 = ci(body, "TwoFactorProviders2");
  const emailInfo = ci(p2, String(TWO_FACTOR.Email));
  const emailHint = ci(emailInfo, "Email");
  const webauthn = ci(p2, String(TWO_FACTOR.WebAuthn));
  return {
    providers: ids,
    ...(typeof emailHint === "string" ? { emailHint } : {}),
    ...(webauthn && typeof webauthn === "object" ? { webauthn: JSON.stringify(webauthn) } : {}),
  };
}

interface PasswordGrant {
  email: string;
  authHash: string;
  deviceId: string;
  twoFactor?: { provider: number; token: string; remember: boolean };
  /** Log in with device: the approved auth request; `authHash` is then its access code. */
  authRequest?: string;
}

const deviceForm = (deviceId: string) => ({
  scope: "api offline_access",
  client_id: CLIENT_NAME,
  deviceType: String(DEVICE_TYPE),
  deviceIdentifier: deviceId,
  deviceName: DEVICE_NAME,
});

export async function passwordToken(base: string, g: PasswordGrant): Promise<TokenResponse> {
  const form: Record<string, string> = { grant_type: "password", username: g.email, password: g.authHash, ...deviceForm(g.deviceId) };
  if (g.twoFactor) {
    form.twoFactorProvider = String(g.twoFactor.provider);
    form.twoFactorToken = g.twoFactor.token;
    form.twoFactorRemember = g.twoFactor.remember ? "1" : "0";
  }
  if (g.authRequest) form.authRequest = g.authRequest;
  return grant(base, form);
}

/** SSO: redeems the code Vaultwarden handed to `redirectUri` (PKCE). */
export async function authorizationCodeToken(base: string, code: string, verifier: string, redirectUri: string, deviceId: string): Promise<TokenResponse> {
  return grant(base, { grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri, ...deviceForm(deviceId) });
}

/** Errors unless Vaultwarden has SSO turned on. */
export async function ssoPrevalidate(base: string): Promise<void> {
  await call(base, "GET", "/identity/sso/prevalidate");
}

async function grant(base: string, form: Record<string, string>): Promise<TokenResponse> {
  try {
    return parse(tokenResponse, await call(base, "POST", "/identity/connect/token", { form }));
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) {
      const challenge = parseTwoFactorChallenge(e.body);
      if (challenge) throw new TwoFactorRequired(challenge);
    }
    throw e;
  }
}

export async function refreshToken(base: string, refresh: string): Promise<TokenResponse> {
  const form = { grant_type: "refresh_token", client_id: CLIENT_NAME, refresh_token: refresh };
  return parse(tokenResponse, await call(base, "POST", "/identity/connect/token", { form }));
}

/** Asks Vaultwarden to mail an email-2FA code (no bearer token; authenticated by the hash). */
export async function sendEmailLogin(base: string, email: string, authHash: string, deviceId: string, authRequest?: string): Promise<void> {
  // Log in with device proves itself with the auth request's access code instead of the password hash.
  const proof = authRequest ? { authRequestId: authRequest, authRequestAccessCode: authHash } : { masterPasswordHash: authHash };
  await call(base, "POST", "/api/two-factor/send-email-login", { json: { email, ...proof, deviceIdentifier: deviceId } });
}

export async function revisionDate(base: string, token: string): Promise<number> {
  return parse(num, await call(base, "GET", "/api/accounts/revision-date", { token }));
}

/** JWT payload `sub` (user id). The token is not verified here; the server does that. */
export const jwtSubject = (token: string): string | undefined => jwtClaim(token, "sub");

export function jwtClaim(token: string, name: string): string | undefined {
  try {
    const part = token.split(".")[1];
    if (!part) return undefined;
    const json = new TextDecoder().decode(Uint8Array.fromBase64(part, { alphabet: "base64url" }));
    const v = (JSON.parse(json) as Record<string, unknown>)[name];
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

// ---------- Log in with device (auth requests, vaultwarden src/api/core/accounts.rs) ----------

const authRequestResponse = obj({
  id: str,
  publicKey: str,
  requestDeviceType: opt(str),
  requestIpAddress: opt(str),
  key: opt(str),
  masterPasswordHash: opt(str),
  creationDate: str,
  requestApproved: opt(bool),
});
export type AuthRequest = ReturnType<typeof authRequestResponse>;

/** Anonymous: asks the account's other devices to approve this one. Vaultwarden only accepts a known device id. */
export async function createAuthRequest(base: string, r: { email: string; publicKey: string; deviceId: string; accessCode: string }): Promise<AuthRequest> {
  const json = { email: r.email, publicKey: r.publicKey, deviceIdentifier: r.deviceId, accessCode: r.accessCode, type: 0 };
  return parse(authRequestResponse, await call(base, "POST", "/api/auth-requests", { json }));
}

/** Anonymous poll of our own request (authenticated by the access code). */
export async function authRequestStatus(base: string, id: string, accessCode: string): Promise<AuthRequest> {
  const q = new URLSearchParams({ code: accessCode });
  return parse(authRequestResponse, await call(base, "GET", `/api/auth-requests/${encodeURIComponent(id)}/response?${q}`));
}

export async function pendingAuthRequests(base: string, token: string): Promise<AuthRequest[]> {
  return parse(obj({ data: arr(authRequestResponse) }), await call(base, "GET", "/api/auth-requests/pending", { token })).data;
}

export async function getAuthRequest(base: string, token: string, id: string): Promise<AuthRequest> {
  return parse(authRequestResponse, await call(base, "GET", `/api/auth-requests/${encodeURIComponent(id)}`, { token }));
}

/** Approve (`key` = user key wrapped for the requester) or deny (the server deletes the request). */
export async function answerAuthRequest(base: string, token: string, id: string, a: { key: string; deviceId: string; approve: boolean }): Promise<void> {
  const json = { key: a.key, masterPasswordHash: null, deviceIdentifier: a.deviceId, requestApproved: a.approve };
  await call(base, "PUT", `/api/auth-requests/${encodeURIComponent(id)}`, { json, token });
}
