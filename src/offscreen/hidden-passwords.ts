// An organization collection with "Hide passwords" (`viewPassword: false`): the member may use the login (autofill)
// but not read its password, hidden fields or password history. Like a passkey's private key, they stay in the
// crypto worker: the item the popup gets has none, and a save puts the stored ones back, whatever the popup sent.
import { asObject as o, ci, ciKey } from "../shared/validate.ts";

type Json = Record<string, unknown>;

export const hidesPasswords = (item: Json | undefined): boolean => !!item && ci(item, "viewPassword") === false;

const HIDDEN_FIELD = 1;
const isHidden = (f: unknown) => Number(ci(f, "type")) === HIDDEN_FIELD;
const fieldsOf = (item: Json): unknown[] => (Array.isArray(ci(item, "fields")) ? (ci(item, "fields") as unknown[]) : []);

/** A copy of `item` without its password, hidden fields and password history when it hides them. */
export function withoutHiddenPasswords(item: Json): Json {
  if (!hidesPasswords(item)) return item;
  const out: Json = { ...item, [ciKey(item, "passwordHistory")]: null, [ciKey(item, "fields")]: fieldsOf(item).filter((f) => !isHidden(f)) };
  const login = o(ci(item, "login"));
  if (login) out[ciKey(item, "login")] = { ...login, [ciKey(login, "password")]: null };
  return out;
}

/**
 * `item` as the popup sent it, with the stored password, password history and hidden fields of `existing` back, each
 * hidden field at its old position. A hidden field the popup added is new and kept.
 */
export function restoreHiddenPasswords(item: Json, existing: Json | undefined): Json {
  if (!existing || !hidesPasswords(existing)) return item;
  const out: Json = { ...item, [ciKey(item, "passwordHistory")]: ci(existing, "passwordHistory") ?? null };
  const fields = [...fieldsOf(item)];
  fieldsOf(existing).forEach((f, i) => isHidden(f) && fields.splice(Math.min(i, fields.length), 0, f));
  out[ciKey(item, "fields")] = fields.length ? fields : (ci(item, "fields") ?? null);
  const login = o(ci(item, "login"));
  const stored = o(ci(existing, "login"));
  if (login) out[ciKey(item, "login")] = { ...login, [ciKey(login, "password")]: ci(stored, "password") ?? null };
  return out;
}
