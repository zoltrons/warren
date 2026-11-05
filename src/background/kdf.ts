// KDF downgrade guard. The server picks the account's KDF (prelogin, token response) and receives the hash it
// produces, so a malicious or compromised server could ask for PBKDF2 at 5000 iterations and brute-force the master
// password offline from the hash. Each account remembers the strongest KDF it was seen with here; a weaker one is
// refused unless it is still a safe setting (a user may lower a very high KDF in the web vault on purpose).
import { KDF_ARGON2ID } from "../shared/constants.ts";
import type { KdfParams } from "../shared/messages.ts";

/** OWASP's PBKDF2-SHA256 count and RFC 9106's second recommended Argon2id setting. */
export const safeKdf = (k: KdfParams): boolean =>
  k.type === KDF_ARGON2ID ? k.memory >= 64 && k.iterations >= 3 : k.iterations >= 600_000;

/**
 * Below this a PBKDF2 hash falls to a GPU in hours, so no hash made with it is sent, even on a first login here where
 * there is no floor yet. The official clients' default has been 600 000 since 2023 (100 000 before); only very old
 * accounts or a hostile server have less.
 */
export const PBKDF2_MIN = 100_000;
export const tooWeak = (k: KdfParams): boolean => k.type !== KDF_ARGON2ID && k.iterations < PBKDF2_MIN;

/** Argon2id outranks PBKDF2; within a type, more work wins (parallelism does not slow an attacker). */
function weaker(next: KdfParams, floor: KdfParams): boolean {
  if (next.type !== floor.type) return next.type !== KDF_ARGON2ID;
  return next.type === KDF_ARGON2ID ? next.memory * next.iterations < floor.memory * floor.iterations : next.iterations < floor.iterations;
}

/** True when `next` must be refused against the account's `floor` (none yet: anything the server-side range checks allow). */
export const kdfDowngrade = (next: KdfParams, floor: KdfParams | undefined): boolean => !!floor && weaker(next, floor) && !safeKdf(next);

/** The floor to keep after `next` was accepted: never lower. */
export const raiseFloor = (next: KdfParams, floor: KdfParams | undefined): KdfParams => (!floor || weaker(floor, next) ? next : floor);
