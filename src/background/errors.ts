import type { ErrorCode } from "../shared/messages.ts";

/** A message in the UI's language; the key itself where there is no i18n (unit tests). */
export const msg = (key: string, ...subs: string[]): string => globalThis.chrome?.i18n?.getMessage(key, subs) || key;

/** Error with a code the popup can switch on (see ErrorCode in shared/messages.ts). */
export class UserError extends Error {
  override name = "UserError";
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
