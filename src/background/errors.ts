import type { ErrorCode } from "../shared/messages.ts";

/** Error with a code the popup can switch on (see ErrorCode in shared/messages.ts). */
export class UserError extends Error {
  override name = "UserError";
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}
