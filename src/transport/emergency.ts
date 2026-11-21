// Emergency access (vaultwarden src/api/core/emergency_access.rs): trusted contacts who may view or take over an
// account after a waiting period the grantor can cut short or refuse. No keys here: the core wraps and unwraps.
import { arr, literal, obj, opt, parse, str, u32, unknownValue } from "../shared/validate.ts";
import { call } from "./http.ts";

/** 0 invited, 1 accepted, 2 confirmed, 3 recovery initiated, 4 recovery approved. */
const status = literal(0, 1, 2, 3, 4);
/** 0 view, 1 takeover. */
const kind = literal(0, 1);

const grant = obj({
  id: str,
  status,
  type: kind,
  waitTimeDays: u32,
  email: opt(str),
  name: opt(str),
  granteeId: opt(str),
  grantorId: opt(str),
  recoveryInitiatedDate: opt(str),
});
export type Grant = ReturnType<typeof grant>;

const path = (id: string, action = "") => `/api/emergency-access/${encodeURIComponent(id)}${action ? `/${action}` : ""}`;

/** People this account trusts (it is their grantor), and accounts that trust it (it is their grantee). */
export async function grants(base: string, token: string): Promise<{ trusted: Grant[]; granted: Grant[] }> {
  const list = async (which: string) => parse(obj({ data: arr(grant) }), await call(base, "GET", `/api/emergency-access/${which}`, { token })).data;
  const [trusted, granted] = await Promise.all([list("trusted"), list("granted")]);
  return { trusted, granted };
}

export async function invite(base: string, token: string, email: string, type: 0 | 1, waitTimeDays: number): Promise<void> {
  await call(base, "POST", "/api/emergency-access/invite", { token, json: { email, type, waitTimeDays } });
}

/** Grantor: reinvite, approve, reject; grantee: initiate. */
export async function act(base: string, token: string, id: string, action: "reinvite" | "initiate" | "approve" | "reject"): Promise<void> {
  await call(base, "POST", path(id, action), { token });
}

export async function remove(base: string, token: string, id: string): Promise<void> {
  await call(base, "DELETE", path(id), { token });
}

/** Grantor: the grantee's public key, read from the server for the grant (never from a message). */
export async function granteeKey(base: string, token: string, granteeId: string): Promise<string> {
  return parse(obj({ publicKey: str }), await call(base, "GET", `/api/users/${encodeURIComponent(granteeId)}/public-key`, { token })).publicKey;
}

/** Grantor: the user key wrapped for the grantee's public key. */
export async function confirm(base: string, token: string, id: string, key: string): Promise<void> {
  await call(base, "POST", path(id, "confirm"), { token, json: { key } });
}

/** Grantee, after approval: the grantor's ciphers and their user key wrapped for this account. */
export async function view(base: string, token: string, id: string): Promise<{ keyEncrypted: string; ciphers: unknown[] }> {
  return parse(obj({ keyEncrypted: str, ciphers: arr(unknownValue) }), await call(base, "POST", path(id, "view"), { token }));
}

const kdfType = literal(0, 1);
/** Grantee, after approval of a takeover: the grantor's KDF and their user key wrapped for this account. */
export async function takeover(base: string, token: string, id: string) {
  return parse(obj({ keyEncrypted: str, kdf: kdfType, kdfIterations: u32, kdfMemory: opt(u32), kdfParallelism: opt(u32) }), await call(base, "POST", path(id, "takeover"), { token }));
}

export async function setPassword(base: string, token: string, id: string, newMasterPasswordHash: string, key: string): Promise<void> {
  await call(base, "POST", path(id, "password"), { token, json: { newMasterPasswordHash, key } });
}
