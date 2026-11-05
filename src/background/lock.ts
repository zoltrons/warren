// Lock state and auto-lock (alarms + idle), and the two counters that let a lock or an account change win over
// work already in flight.
import { coreShutdown } from "./core.ts";
import { UserError } from "./errors.ts";
import { revokeReprompts } from "./reprompt.ts";
import { clearPendingSaves, getSettings, updateSession } from "./store.ts";

export const AUTOLOCK_ALARM = "autolock";

/**
 * The inline menu and the save bar are extension frames inside web pages, showing decrypted item names
 * and usernames. Locking must tear them down, or a page could keep them on screen after the lock.
 */
async function closeInPageUi(): Promise<void> {
  const tabs = await chrome.tabs.query({}).catch(() => []);
  await Promise.allSettled(
    tabs.flatMap((t) =>
      t.id === undefined || !/^https?:/.test(t.url ?? "")
        ? []
        : [
            chrome.tabs.sendMessage(t.id, { type: "inlineClose" }).catch(() => undefined),
            chrome.tabs.sendMessage(t.id, { type: "barHide" }).catch(() => undefined),
          ],
    ),
  );
}

/**
 * Bumped by every lock (a login and a logout lock too). Work that holds or uses vault secrets (an unlock, a fill, a
 * save bar, a re-prompt grant, the worker's copy of the vault) takes it before its first await and calls
 * assertEpoch right before each write or send, with no await in between: one a lock overtook never completes.
 */
let epoch = 0;
/**
 * Bumped when the account or the server changes (a login stores its account, a logout). Server credentials and
 * caches outlive a lock but not their account: a refresh, the push hub and an SSO callback check this one.
 */
let owner = 0;

export const lockEpoch = (): number => epoch;
export const ownerEpoch = (): number => owner;
/** Another account (or none) from here on: whatever began for the one before is stale. */
export const newOwner = (): number => ++owner;

export function assertEpoch(e: number): void {
  if (e !== epoch) throw new UserError("sessionExpired", "The vault was locked meanwhile, please try again");
}

/** Every owner in `taken` must still be the current one. */
export function assertOwner(...taken: number[]): void {
  if (taken.some((o) => o !== owner)) throw new UserError("sessionExpired", "The account changed meanwhile, please try again");
}

/** Resolves to the epoch this lock started: a login that begins with a lock owns that one, not a later lock's. */
export async function lockNow(): Promise<number> {
  // First and synchronous: a re-prompt grant must survive no lock, even one that fails halfway.
  const mine = ++epoch;
  revokeReprompts();
  await updateSession({ unlocked: false, unlockedUntil: undefined, pending: undefined, picker: undefined });
  await clearPendingSaves();
  await chrome.alarms.clear(AUTOLOCK_ALARM);
  await coreShutdown();
  await closeInPageUi();
  return mine;
}

/** Called on unlock and on every popup interaction while unlocked. `e`: the epoch the unlock or request began in. */
export async function touchAutoLock(e = epoch): Promise<void> {
  const { autoLockMinutes } = await getSettings();
  // A lock that came meanwhile cleared the timer: a vault that is not open gets none back.
  if (e !== epoch) return;
  if (autoLockMinutes < 0) {
    // "On browser restart": storage.session and the offscreen document die with the browser.
    await Promise.all([chrome.alarms.clear(AUTOLOCK_ALARM), updateSession({ unlockedUntil: undefined })]);
    return;
  }
  const minutes = Math.max(autoLockMinutes, 0.5);
  // Both sent in this tick, so a lock after the check above clears them again.
  await Promise.all([updateSession({ unlockedUntil: Date.now() + minutes * 60_000 }), chrome.alarms.create(AUTOLOCK_ALARM, { delayInMinutes: minutes })]);
}
