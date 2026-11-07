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
 * OWASP Password Storage minimums: no hash made below them is sent, even on a first login here where there is no floor
 * yet. The official clients' PBKDF2 default has been 600 000 since 2023, so only very old accounts or a hostile server
 * have less; the server-side Argon2id range starts at 16 MiB x 2.
 */
export const PBKDF2_MIN = 600_000;
export const ARGON2_MIN = { memory: 19, iterations: 2 };
export const tooWeak = (k: KdfParams): boolean =>
  k.type === KDF_ARGON2ID ? k.memory < ARGON2_MIN.memory || k.iterations < ARGON2_MIN.iterations : k.iterations < PBKDF2_MIN;
export const kdfText = (k: KdfParams): string =>
  k.type === KDF_ARGON2ID ? `Argon2id, ${k.memory} MiB x ${k.iterations}` : `PBKDF2, ${k.iterations} iterations`;

/** Argon2id outranks PBKDF2; within a type, more work wins (parallelism does not slow an attacker). */
function weaker(next: KdfParams, floor: KdfParams): boolean {
  if (next.type !== floor.type) return next.type !== KDF_ARGON2ID;
  return next.type === KDF_ARGON2ID ? next.memory * next.iterations < floor.memory * floor.iterations : next.iterations < floor.iterations;
}

/** True when `next` must be refused against the account's `floor` (none yet: anything the server-side range checks allow). */
export const kdfDowngrade = (next: KdfParams, floor: KdfParams | undefined): boolean => !!floor && weaker(next, floor) && !safeKdf(next);

/** The floor to keep after `next` was accepted: never lower. */
export const raiseFloor = (next: KdfParams, floor: KdfParams | undefined): KdfParams => (!floor || weaker(floor, next) ? next : floor);

/**
 * A PIN that unlocks alone after a restart sits on disk wrapped by PIN_KDF and can be tried offline from a copied
 * profile: it must not be a short number (a 6-digit PIN falls in hours to days).
 */
export const PIN_ONLY_MIN = 8;
export const pinOnlyStrong = (pin: string): boolean => [...pin].length >= PIN_ONLY_MIN && /\D/.test(pin);
