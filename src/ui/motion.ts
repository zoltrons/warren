/** Drill-down depth of an unlocked screen key (popup.ts screenKey): list 0, item 1, editor and folders 2. */
const depth = (key: string) => (key.startsWith("vault:item") ? 1 : key.startsWith("vault:edit") || key === "vault:folders" ? 2 : 0);
const UNLOCKED_SCREEN = /^(vault:|generator$|send$|settings$)/;

/**
 * How a screen change moves (popup.css, view transitions): deeper slides in from the right, back slides the
 * other way, another tab fades. Locks, logins and same-depth swaps change at once: a lock never waits on a frame.
 */
export function navMotion(from: string, to: string): "forward" | "back" | "fade" | undefined {
  if (!from || from === to || !UNLOCKED_SCREEN.test(from) || !UNLOCKED_SCREEN.test(to)) return;
  const d = depth(to) - depth(from);
  if (d) return d > 0 ? "forward" : "back";
  return from.split(":")[0] !== to.split(":")[0] ? "fade" : undefined;
}
