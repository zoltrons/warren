// Emergency access. As grantor this account invites trusted contacts, confirms them (its user key wrapped for their
// public key, only after the user saw the same fingerprint phrase), and approves or rejects a request. As grantee it
// asks for access, then views the grantor's vault (decrypted in the crypto worker, never stored) or takes the account
// over with a new master password. The rules are those of a login-with-device approval (SECURITY.md invariant 8c).
import type { KdfParams, VaultItem } from "../shared/messages.ts";
import * as api from "../transport/emergency.ts";
import { auth, UserError } from "./account.ts";
import { coreCall } from "./core.ts";
import { msg } from "./errors.ts";
import { kdfText, tooWeak, ARGON2_MIN, PBKDF2_MIN } from "./kdf.ts";
import { assertOwner, ownerEpoch } from "./lock.ts";

export const MAX_WAIT_DAYS = 90;

export async function emergencyList(): Promise<{ trusted: api.Grant[]; granted: api.Grant[] }> {
  const { base, token } = await auth();
  return api.grants(base, token);
}

export async function emergencyInvite(email: string, kind: 0 | 1, waitDays: number): Promise<void> {
  if (!email.includes("@")) throw new UserError("invalid", msg("errEnterYourEmailAddress"));
  const { base, token } = await auth();
  await api.invite(base, token, email.trim(), kind, Math.min(Math.max(1, Math.round(waitDays)), MAX_WAIT_DAYS));
}

export async function emergencyAction(id: string, action: "reinvite" | "initiate" | "approve" | "reject" | "delete"): Promise<void> {
  const { base, token } = await auth();
  if (action === "delete") await api.remove(base, token, id);
  else await api.act(base, token, id, action);
}

/** The grant this account is grantor of, with its grantee's public key from the server. */
async function granteeOf(base: string, token: string, id: string): Promise<{ grantee: string; publicKey: string }> {
  const g = (await api.grants(base, token)).trusted.find((x) => x.id === id);
  if (!g?.granteeId || g.status !== 1) throw new UserError("badServer", msg("errTheRequestChangedOnThe"));
  return { grantee: g.granteeId, publicKey: await api.granteeKey(base, token, g.granteeId) };
}

/** Grantor: the phrase of the grantee's public key (their user id over it), as the grantee's own client shows it. */
export async function emergencyFingerprint(id: string): Promise<string> {
  const { base, token } = await auth();
  const { grantee, publicKey } = await granteeOf(base, token, id);
  return coreCall<string>({ op: "authRequestFingerprint", email: grantee, publicKey });
}

/** Grantor: wraps the user key for the grantee, only for the key that gives the phrase the user saw. */
export async function emergencyConfirm(id: string, fingerprint: string): Promise<void> {
  const owner = ownerEpoch();
  const { base, token } = await auth(owner);
  const { grantee, publicKey } = await granteeOf(base, token, id);
  if ((await coreCall<string>({ op: "authRequestFingerprint", email: grantee, publicKey })) !== fingerprint) throw new UserError("badServer", msg("errTheRequestChangedOnThe"));
  const key = await coreCall<string>({ op: "authRequestApprove", publicKey });
  assertOwner(owner); // the wrapped key is this account's: it goes to its server only
  await api.confirm(base, token, id, key);
}

/** Grantee: the grantor's items, decrypted and kept in the worker for this view only. */
export async function emergencyView(id: string): Promise<VaultItem[]> {
  const { base, token } = await auth();
  const { keyEncrypted, ciphers } = await api.view(base, token, id);
  return coreCall<VaultItem[]>({ op: "emergencyView", grantId: id, keyEncrypted, ciphers });
}

export const emergencyItem = (id: string, itemId: string) => coreCall<Record<string, unknown>>({ op: "emergencyItem", grantId: id, id: itemId });

/** Grantee: a new master password for the grantor's account. The server picks the KDF, so it gets the same floor as a login. */
export async function emergencyTakeover(id: string, password: string): Promise<void> {
  if ([...password].length < 12) throw new UserError("invalid", msg("errMasterPasswordTooShort"));
  const owner = ownerEpoch();
  const { base, token } = await auth(owner);
  const grantor = (await api.grants(base, token)).granted.find((g) => g.id === id);
  if (!grantor?.email || grantor.type !== 1 || grantor.status !== 4) throw new UserError("badServer", msg("errTheRequestChangedOnThe"));
  const t = await api.takeover(base, token, id);
  const kdf: KdfParams = { type: t.kdf, iterations: t.kdfIterations, memory: t.kdfMemory ?? 0, parallelism: t.kdfParallelism ?? 0 };
  if (tooWeak(kdf)) throw new UserError("badServer", msg("errKdfTooWeak", kdfText(kdf), String(PBKDF2_MIN), String(ARGON2_MIN.memory), String(ARGON2_MIN.iterations)));
  const r = await coreCall<{ masterPasswordHash: string; key: string }>({ op: "emergencyTakeover", keyEncrypted: t.keyEncrypted, password, email: grantor.email, kdf });
  assertOwner(owner);
  await api.setPassword(base, token, id, r.masterPasswordHash, r.key);
}
