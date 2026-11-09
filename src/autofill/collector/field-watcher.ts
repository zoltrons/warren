// Watches a frame for its first password field, which single-page apps render long after load.
const SETTLE_MS = 300;
const MAX_PENDING = 200;
const PASSWORD = "input[type=password]";
const WATCH = { childList: true, subtree: true };

/** Calls `found` once, when a password field exists; then stops looking. */
export function watchForPasswordField(found: () => void): void {
  let pending: Element[] = [];
  let overflow = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hit = () => {
    observer.disconnect();
    if (timer !== undefined) clearTimeout(timer);
    found();
  };
  // One walk per root: looks for a password field and, since mutations do not cross into shadow roots, observes each
  // one it passes. The root itself counts: an added host's own shadow root is otherwise never seen.
  const scan = (root: ParentNode): boolean => {
    // A named input ("querySelectorAll") clobbers a form's own methods: call the native ones.
    const els = root instanceof Element ? [root, ...Element.prototype.querySelectorAll.call(root, "*")] : root.querySelectorAll("*");
    for (const el of els) {
      if (Element.prototype.matches.call(el, PASSWORD)) return true;
      if (el.shadowRoot && (observer.observe(el.shadowRoot, WATCH), scan(el.shadowRoot))) return true;
    }
    return false;
  };
  const settle = () => {
    timer = undefined;
    const roots = overflow ? [document] : pending;
    pending = [];
    overflow = false;
    if (roots.some(scan)) hit();
  };
  const observer = new MutationObserver((records) => {
    for (const r of records) for (const n of r.addedNodes) if (n instanceof Element) pending.length < MAX_PENDING ? pending.push(n) : (overflow = true);
    if ((pending.length || overflow) && timer === undefined) timer = setTimeout(settle, SETTLE_MS);
  });
  const start = () => {
    observer.observe(document, WATCH);
    if (scan(document)) hit();
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", start, { once: true });
  else start();
}
