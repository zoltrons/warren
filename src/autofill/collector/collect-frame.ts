// CollectedPageDetails: what the classification engine gets to know about this frame. Field values are
// not part of it: nothing outside the page needs them to decide what a field is.
import type { ButtonDetails, CollectedPageDetails, FieldDetails, FormDetails } from "../../shared/messages.ts";
import { MAX_BUTTONS, MAX_DATA_ATTRS, MAX_FIELDS, MAX_FORM_TEXT, MAX_FORMS, MAX_PAGE_STRING } from "../../shared/page-limits.ts";
import { blockPath, deepAll, deepFields, type Field, idOf } from "./shadow-dom.ts";
import { extractAriaLabel, extractExplicitLabels, walkDomForLabel } from "./tree-walker.ts";

export type CollectMode = "ActiveFieldOnly" | "FullPage";

const BUTTONS = "button,input[type=submit],input[type=button],[role=button]";
const SUBMITS = "button:not([type=button],[type=reset]),input[type=submit]";

const cap = (s: string | null | undefined, max = MAX_PAGE_STRING) => (s ? s.slice(0, max) : undefined) || undefined;

/** The parent in the flat tree: through slots and out of shadow roots. */
const flatParent = (el: Element): Element | null => el.assignedSlot ?? el.parentElement ?? (el.parentNode instanceof ShadowRoot ? el.parentNode.host : null);

const CLIPS = ["hidden", "clip"];

/**
 * What of `r` is left after the ancestors that hide their overflow: a normal-size input in a zero-size
 * `overflow: hidden` box is a decoy too. Scrolling boxes are not clips (the user can scroll the field in).
 * shortcut: assumes every ancestor below a fixed one clips the field; an absolutely positioned field that escapes a
 * clipping ancestor without being its containing block is judged by that ancestor too. Upgrade if a real form trips it.
 */
function visibleRect(el: Element, r: DOMRect): { width: number; height: number } {
  let { left, top, right, bottom } = r;
  for (let p = flatParent(el); p && p !== document.body && p !== document.documentElement; p = flatParent(p)) {
    const s = getComputedStyle(p);
    const x = CLIPS.includes(s.overflowX);
    const y = CLIPS.includes(s.overflowY);
    if (x || y) {
      const c = p.getBoundingClientRect();
      if (x) [left, right] = [Math.max(left, c.left), Math.min(right, c.right)];
      if (y) [top, bottom] = [Math.max(top, c.top), Math.min(bottom, c.bottom)];
    }
    if (s.position === "fixed") break; // nothing further up clips it
  }
  return { width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

/** False for fields nobody can see: zero-size decoys are a favourite of login pages. */
export function isElementVisible(el: Field): boolean {
  if (el.disabled || (el instanceof HTMLInputElement && el.type === "hidden") || el.getAttribute("aria-hidden") === "true") return false;
  const box = el.getBoundingClientRect();
  const r = { ...visibleRect(el, box), left: box.left, right: box.right, bottom: box.bottom };
  // Too small to type in: a decoy. A checkbox is meant to be that small.
  const toggle = el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio");
  if (toggle ? !r.width || !r.height : r.width < 24 || r.height < 8) return false;
  // Off the page's origin (document coordinates, so scrolled-away fields still count): unreachable decoys.
  if (r.right + scrollX <= 0 || r.bottom + scrollY <= 0) return false;
  // Parked far to the right of the viewport, or clipped away: a trap field, not a form.
  if (r.left >= innerWidth || getComputedStyle(el).clipPath !== "none") return false;
  return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
}

/** A field a fill may write to: shown, and not a read-only copy the page only displays. */
export const isFillable = (el: Field) => isElementVisible(el) && !(!(el instanceof HTMLSelectElement) && el.readOnly);

function normalizeType(el: Field): string {
  if (el instanceof HTMLSelectElement) return "select";
  if (el instanceof HTMLTextAreaElement) return "textarea";
  return el.type;
}

function populateFieldLabels(el: Field, target: FieldDetails): void {
  target.label = cap(extractExplicitLabels(el));
  target.labelAria = cap(extractAriaLabel(el));
  target.labelData = cap(el.getAttribute("data-label"));
  target.labelBefore = cap(walkDomForLabel(el, "BACKWARD"));
  target.labelAfter = cap(walkDomForLabel(el, "FORWARD"));
}

function dataAttributes(el: Field): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(el.dataset).slice(0, MAX_DATA_ATTRS)) if (v !== undefined) out[k.slice(0, MAX_PAGE_STRING)] = v.slice(0, MAX_PAGE_STRING);
  return out;
}

function extractFieldDetails(el: Field, isActive: boolean, mode: CollectMode): FieldDetails {
  const input = el instanceof HTMLInputElement ? el : undefined;
  const text = el instanceof HTMLSelectElement ? undefined : el;
  const details: FieldDetails = {
    fieldId: idOf(el),
    formId: el.form ? idOf(el.form) : undefined,
    type: normalizeType(el),
    htmlId: cap(el.id),
    htmlName: cap(el.name),
    htmlClass: typeof el.className === "string" ? cap(el.className) : undefined,
    autocompleteType: cap(el.getAttribute("autocomplete")),
    placeholder: cap(text?.placeholder),
    maxLength: text && text.maxLength > 0 ? text.maxLength : undefined,
    minLength: text && text.minLength > 0 ? text.minLength : undefined,
    tabIndex: el.tabIndex || undefined,
    title: cap(el.title),
    passwordRules: cap(input?.getAttribute("passwordrules")),
    dataAttributes: dataAttributes(el),
    isActive: isActive || undefined,
    isChecked: input?.checked || undefined,
    isHidden: !isElementVisible(el) || undefined,
    isReadOnly: text?.readOnly || undefined,
    isDisabled: el.disabled || undefined,
    isAriaDisabled: el.getAttribute("aria-disabled") === "true" || undefined,
    isAriaHasPopup: el.getAttribute("aria-haspopup") === "true" || undefined,
    isAriaHidden: el.getAttribute("aria-hidden") === "true" || undefined,
    label: undefined,
    labelAria: undefined,
    labelData: undefined,
    labelBefore: undefined,
    labelAfter: undefined,
    blockPath: blockPath(el),
  };
  // Walking for labels is the expensive part, and a focus only asks about one field.
  if (mode === "FullPage" || isActive) populateFieldLabels(el, details);
  return details;
}

function extractForm(form: HTMLFormElement): FormDetails {
  // Named inputs clobber form.id, form.innerText and the like: read the attributes, and only trust strings.
  const attr = (name: string) => cap(Element.prototype.getAttribute.call(form, name));
  const text = [form.innerText, form.textContent].find((v) => typeof v === "string") as string | undefined;
  return { formId: idOf(form), htmlId: attr("id"), htmlName: attr("name"), action: attr("action"), text: cap(text, MAX_FORM_TEXT) };
}

function extractButton(el: HTMLElement): ButtonDetails {
  const b = el as HTMLButtonElement;
  const form = b.form instanceof HTMLFormElement ? b.form : el.closest("form");
  return {
    fieldId: idOf(el),
    formId: form ? idOf(form) : undefined,
    text: cap((el.textContent || b.value || el.getAttribute("aria-label") || "").trim(), MAX_PAGE_STRING),
    isSubmit: Element.prototype.matches.call(el, SUBMITS) || undefined,
    isHidden: !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) || undefined,
    blockPath: blockPath(el),
  };
}

/** Everything the engine needs about this frame. `active` is the field the user is in. */
export function collectFrame(active: Element | undefined, mode: CollectMode): CollectedPageDetails {
  let found = deepFields().filter((el) => !(el instanceof HTMLInputElement && el.type === "hidden"));
  if (found.length > MAX_FIELDS) {
    // A huge page must not lose the one field it is about.
    const keep = found.slice(0, MAX_FIELDS);
    if (active && found.includes(active as Field) && !keep.includes(active as Field)) keep[MAX_FIELDS - 1] = active as Field;
    found = keep;
  }
  const forms = new Set<HTMLFormElement>();
  for (const el of found) if (el.form && forms.size < MAX_FORMS) forms.add(el.form);
  const buttons = deepAll(document, BUTTONS) as HTMLElement[];
  return {
    origin: location.origin,
    forms: [...forms].map(extractForm),
    fields: found.map((el) => extractFieldDetails(el, el === active, mode)),
    buttons: buttons.slice(0, MAX_BUTTONS).map(extractButton),
    // The engine then never plans Enter: it would press whatever submit button was left out.
    buttonsTruncated: buttons.length > MAX_BUTTONS || undefined,
  };
}

export const allButtons = () => deepAll(document, BUTTONS) as HTMLElement[];
