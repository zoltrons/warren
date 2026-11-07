// A passkey's private key (`login.fido2Credentials[].keyValue`) stays in the crypto worker: the item the popup gets
// has none, and a save puts it back from the worker's own copy.
import { asObject as o, asString as s, ci } from "../shared/validate.ts";

type Json = Record<string, unknown>;

const keyOf = (obj: Json, name: string) => Object.keys(obj).find((k) => k.toLowerCase() === name.toLowerCase());

/** The item's passkey credentials (the server's key casing), or none. */
function passkeys(item: Json): { lk: string; login: Json; ck: string; creds: Json[] } | undefined {
  const lk = keyOf(item, "login");
  const login = lk ? o(item[lk]) : undefined;
  const ck = login && keyOf(login, "fido2Credentials");
  const creds = ck ? login[ck] : undefined;
  return lk && login && ck && Array.isArray(creds) && creds.length ? { lk, login, ck, creds: creds.map((c) => o(c) ?? {}) } : undefined;
}

const withCreds = (item: Json, p: NonNullable<ReturnType<typeof passkeys>>, creds: Json[]): Json => ({ ...item, [p.lk]: { ...p.login, [p.ck]: creds } });

const keyValue = (c: Json) => s(ci(c, "keyValue"));

/** A copy of `item` without any passkey private key. */
export function withoutPasskeyKeys(item: Json): Json {
  const p = passkeys(item);
  return p ? withCreds(item, p, p.creds.map((c) => Object.fromEntries(Object.entries(c).filter(([k]) => k.toLowerCase() !== "keyvalue")))) : item;
}

/**
 * A passkey coming back without its private key gets it again from `existing` (the same item in the worker), matched by
 * credential id. One that is not there (a clone, a credential copied from another item) is dropped: it could never
 * sign, and the official clients do not copy passkeys either.
 */
export function restorePasskeyKeys(item: Json, existing: Json | undefined): Json {
  const p = passkeys(item);
  if (!p) return item;
  const known = new Map((existing && passkeys(existing)?.creds.map((c) => [s(ci(c, "credentialId")), keyValue(c)])) ?? []);
  return withCreds(
    item,
    p,
    p.creds.flatMap((c) => {
      if (keyValue(c)) return [c];
      const key = known.get(s(ci(c, "credentialId")));
      return key ? [{ ...c, keyValue: key }] : [];
    }),
  );
}
