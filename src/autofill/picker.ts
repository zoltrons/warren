// "Pick from page": the user points at a field instead of finding out what it is called in the page's HTML.
// Also what the context menu's "Copy custom field name" reads.
import type { CollectedPageDetails } from "../shared/messages.ts";
import type { PageApi } from "./page.ts";
import { deepAll, shadowOf } from "./collector/shadow-dom.ts";

export interface PickedField {
  name: string;
  fieldType: string;
  /** What the page calls it, for the editor to say so. */
  label?: string;
  /** For the engine, to tell what the field holds. */
  details: CollectedPageDetails;
}

const NOT_PICKABLE = ["hidden", "button", "submit", "reset", "image", "file"];
// Inside the host's closed shadow root, so the page's rules cannot reach these and they need no !important.
const SEA = "position:fixed;inset:0;width:100%;height:100%;z-index:2147483647;pointer-events:none";
const BANNER = "position:fixed;top:12px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;font:13px system-ui,sans-serif;color:#fff;background:#c2113f;padding:10px 16px;border-radius:12px;box-shadow:0 1px 2px rgba(0,0,0,.3),0 2px 6px 2px rgba(0,0,0,.15)";
const SVG = "http://www.w3.org/2000/svg";

type Pickable = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

const pickable = (el: unknown): el is Pickable =>
  (el instanceof HTMLInputElement && !NOT_PICKABLE.includes(el.type) && !el.readOnly && !el.disabled) || ((el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) && !el.disabled && !(el instanceof HTMLTextAreaElement && el.readOnly));

/**
 * Generated per page load: React's useId (`:r3:`, `«r3»`, `_r_3_`), UI kits' counters (`mat-input-0`,
 * `headlessui-input-3`), `input-1234`, `a1b2c3d4`. A custom field named after one fails next time.
 */
export const looksGenerated = (id: string) => /^:|:r\w*:|[«»]|^_r_\w*_$|^(mat|headlessui|radix|react-aria|downshift)-|\d{3,}|[0-9a-f]{8,}/i.test(id);

/** The best name for a custom field that fills `el`: an attribute unique on the page, else what its label says. */
export function fieldName(el: Pickable, pw: PageApi): string {
  const root = el.getRootNode() as Document | ShadowRoot;
  const names = ["id", "name", "aria-label", "placeholder"].flatMap((a) => {
    const v = el.getAttribute(a);
    return v ? [{ v, a, unique: root.querySelectorAll(`[${a}="${CSS.escape(v)}"]`).length === 1 }] : [];
  });
  const stable = names.find((n) => n.unique && !(n.a === "id" && looksGenerated(n.v)));
  if (stable) return stable.v;
  const f = pw.collectActive(el).fields.find((d) => d.isActive);
  return (f?.label || f?.labelBefore || f?.labelAfter || names[0]?.v || "").trim();
}

/** The field a clicked element stands for: a label and what is inside one point at their control. */
export function fieldOf(clicked: Element | undefined): Pickable | undefined {
  const label = clicked?.closest("label");
  const el = clicked instanceof HTMLLabelElement || (clicked instanceof HTMLSpanElement && label) ? label?.control : clicked;
  return pickable(el) ? el : undefined;
}

/**
 * The field under the pointer. A floating label, an icon or a styled box drawn over a field takes the click, not the
 * field: look through the stack at that point, into shadow roots (closed ones too).
 */
export function fieldAt(x: number, y: number, root: Document | ShadowRoot = document): Pickable | undefined {
  for (const el of root.elementsFromPoint(x, y)) {
    if (el.getRootNode() !== root) continue; // a shadow root's list also holds its host's ancestors
    const inner = shadowOf(el);
    const f = (inner && fieldAt(x, y, inner)) || fieldOf(el);
    if (f) return f;
  }
  return undefined;
}

let stopCurrent: (() => void) | undefined;

export const picking = () => !!stopCurrent;

export const stopPicker = () => stopCurrent?.();

/** Lets the user pick a field of this frame. `done` gets it, or nothing on Escape; `stopPicker` is silent. */
export function startPicker(pw: PageApi, done: (field: PickedField | undefined) => void): void {
  stopCurrent?.();
  const host = document.createElement("warren-picker");
  host.style.cssText = "all:initial!important;display:block!important";
  const shadow = host.attachShadow({ mode: "closed" });
  // Like uBlock Origin's picker: the page goes dark, with a lit hole where the pick would land.
  const sea = document.createElementNS(SVG, "svg");
  sea.style.cssText = SEA;
  const ocean = document.createElementNS(SVG, "path");
  ocean.setAttribute("fill", "rgba(0,0,0,.5)");
  ocean.setAttribute("fill-rule", "evenodd");
  const island = document.createElementNS(SVG, "path");
  island.setAttribute("fill", "rgba(255,79,123,.2)");
  island.setAttribute("stroke", "#c2113f");
  island.setAttribute("stroke-width", "2");
  // Each frame darkens its own part of the page and leaves its child frames to darken theirs: a field in an iframe gets
  // its lit hole from its own frame, under one layer of dark like any other.
  sea.append(ocean);
  sea.append(island);
  shadow.append(sea);
  if (window === top) {
    const banner = document.createElement("div");
    banner.setAttribute("role", "status");
    banner.style.cssText = BANNER;
    banner.textContent = chrome.i18n.getMessage("pickFieldBanner");
    shadow.append(banner);
  }
  document.documentElement.append(host);
  // The top layer, like the inline menu: above a modal <dialog> or a fullscreen element, whose fields can be picked too.
  host.popover = "manual";
  try {
    host.showPopover();
  } catch {
    // The page took the attribute off: z-index it is.
  }

  // Only frames the content script runs in darken themselves; about:blank, srcdoc, data: and the like stay under ours.
  const frames = deepAll(document, "iframe, frame").filter((f) => /^https?:/.test((f as HTMLIFrameElement).src));
  let shown: Pickable | undefined;
  const show = (el: Pickable | undefined) => {
    shown = el;
    const r = el?.getBoundingClientRect();
    const box = (b: DOMRect) => `M${b.left} ${b.top}h${b.width}v${b.height}h${-b.width}z`;
    const hole = r ? box(r) : "";
    // A frame's hole is its inner box: its border stays dark, the frame darkens the rest.
    const inner = (f: Element) => {
      const b = f.getBoundingClientRect();
      return box(new DOMRect(b.left + f.clientLeft, b.top + f.clientTop, f.clientWidth, f.clientHeight));
    };
    ocean.setAttribute("d", `M0 0h${innerWidth}v${innerHeight}h${-innerWidth}z${hole}${frames.map(inner).join("")}`);
    island.setAttribute("d", hole);
  };
  const redraw = () => show(shown);
  const target = (e: Event) => fieldOf(e.composedPath()[0] as Element) ?? (e instanceof MouseEvent ? fieldAt(e.clientX, e.clientY) : undefined);
  const pick = (el: Pickable) => {
    const name = fieldName(el, pw);
    // Nothing to call it by: stay in the picker, the user can point at another one.
    if (!name) return;
    stop();
    const details = pw.collectActive(el);
    const f = details.fields.find((d) => d.isActive);
    done({ name, fieldType: el.type, label: (f?.label || f?.labelAria || f?.labelBefore || f?.labelAfter || f?.placeholder)?.trim(), details });
  };
  const swallow = (e: Event) => {
    if (!e.isTrusted) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  };
  const onClick = (e: Event) => {
    if (!e.isTrusted) return;
    swallow(e);
    const el = target(e);
    if (el) pick(el);
  };
  const onMove = (e: Event) => show(target(e));
  const onHover = (e: Event) => {
    swallow(e);
    onMove(e);
  };
  const onKey = (e: KeyboardEvent) => {
    if (!e.isTrusted) return;
    if (e.key === "Escape") {
      swallow(e);
      stop();
      done(undefined);
    } else if (e.key === "Enter" && target(e)) {
      swallow(e);
      pick(target(e)!);
    }
  };
  // Like uBlock Origin's picker, the page hears nothing of the pointer: no menu opens on hover, no link follows a
  // middle click. (uBlock covers the page with a layer that takes the pointer; one over a cross-site frame keeps
  // Chrome from sending that frame the click, and a frame picks its own fields.)
  const blocked = ["mousedown", "mouseup", "pointerdown", "pointerup", "pointermove", "auxclick", "dblclick", "contextmenu", "submit"];
  for (const edge of ["over", "out", "enter", "leave"]) blocked.push(`mouse${edge}`, `pointer${edge}`);
  const stop = () => {
    stopCurrent = undefined;
    host.remove();
    for (const type of blocked) removeEventListener(type, swallow, true);
    removeEventListener("click", onClick, true);
    removeEventListener("mousemove", onHover, true);
    removeEventListener("focusin", onMove, true);
    removeEventListener("keydown", onKey, true);
    removeEventListener("scroll", redraw, true);
    removeEventListener("resize", redraw);
    clearTimeout(timer);
  };
  // A forgotten picker must not keep eating the page's clicks.
  const timer = setTimeout(() => {
    stop();
    done(undefined);
  }, 120_000);
  for (const type of blocked) addEventListener(type, swallow, true);
  addEventListener("click", onClick, true);
  addEventListener("mousemove", onHover, true);
  addEventListener("focusin", onMove, true); // Tab and Enter pick too
  addEventListener("keydown", onKey, true);
  addEventListener("scroll", redraw, true);
  addEventListener("resize", redraw);
  show(undefined);
  stopCurrent = stop;
}
