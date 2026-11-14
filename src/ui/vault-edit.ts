// Item editor (Login, Secure note, Card, Identity, SSH key, bank account): fields, URIs, custom fields, save.
import { URI_MATCH, URI_MATCH_ADVANCED } from "../shared/constants.ts";
import { cardBrand, luhnValid } from "../shared/card.ts";
import { LINKED, linkedIdFor, linkedKey } from "../shared/linked-fields.ts";
import { hasMarkup } from "../shared/markdown.ts";
import type { VaultList } from "../shared/messages.ts";
import { type Child, chipRow, enter, h, inPanel, leave, rowOf, send, t, uiPref, withChevron } from "./dom.ts";
import { type GeneratorPick, startGeneratorPick } from "./generator.ts";
import { icon, type IconName } from "./icons.ts";
import { renderMarkdown } from "./markdown.ts";
import { pwnedCount } from "./pwned.ts";
import { type Json, type Ctx, type EditDraft, st, settingsOf, str, obj, toast, iconButton, errorBox, topBar, spacer, sectionTitle, progress, refreshPageMatches, open } from "./vault-shared.ts";
import { TYPE_LABEL } from "./vault-list.ts";
import { type Spec, SCHEMA, label, strength, twoTap } from "./vault-item.ts";
import { writableCollections, writableOrgs, collectionPicker } from "./vault-tools.ts";

// ---------- editor (Login, Secure note, Card, Identity) ----------

export interface Prefill {
  name?: string;
  uris?: { uri: string; match: number | null }[];
  data?: Record<string, string>;
}

export const sitePrefill = (origin: string | undefined): Prefill => (origin ? { name: new URL(origin).hostname, uris: [{ uri: origin, match: null }] } : {});

/** A new item starts on the site of the active tab, read now: a side panel outlives tab switches. */
export async function newItem(ctx: Ctx) {
  await refreshPageMatches();
  startEdit(ctx, undefined, sitePrefill(st.page?.origin));
}

/** Back to the editor after "Pick from page", with the picked field added. */
export async function returnFromPicker(ctx: Ctx) {
  const r = await send<{ draft: string; field?: { name: string; fieldType: string; label?: string; autofillType?: string } } | null>({ type: "takeFieldPick" });
  if (!r.ok || !r.data) return;
  const { draft, isNew } = JSON.parse(r.data.draft) as { draft: EditDraft; isNew: boolean };
  const f = r.data.field;
  if (f) {
    const toggle = f.fieldType === "checkbox" || f.fieldType === "radio";
    const linkedId = toggle ? undefined : linkedIdFor(draft.type, f.autofillType);
    const type = toggle ? 2 : linkedId !== undefined ? 3 : f.fieldType === "password" ? 1 : 0;
    draft.fields.push({ name: f.name, value: toggle ? "true" : "", type, linkedId, pageLabel: f.label });
  }
  st.draft = draft;
  open(ctx, { kind: "edit", isNew });
  if (!f) return;
  // The editor opens on its Name box, at the top: take the user to the row they just added, ready for its value.
  ctx.afterRender(() => {
    const row = [...document.querySelectorAll(".field-card")].at(-1);
    row?.querySelector<HTMLElement>(".field-card-bottom input, .field-card-bottom select")?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: "center" });
  });
}

export async function pickFromPage(ctx: Ctx, isNew: boolean) {
  const r = await send({ type: "startFieldPicker", draft: JSON.stringify({ draft: st.draft, isNew }), panel: inPanel });
  if (!r.ok) {
    st.error = r.error;
    return ctx.rerender();
  }
  // The side panel stays open and hears back; a popup would close at the first click on the page anyway.
  if (!inPanel) return window.close();
  const listener = (msg: { type?: string }) => {
    if (msg.type !== "pickerDone") return;
    chrome.runtime.onMessage.removeListener(listener);
    void returnFromPicker(ctx);
  };
  chrome.runtime.onMessage.addListener(listener);
}

export function startEdit(ctx: Ctx, item: Json | undefined, prefill: Prefill = {}, asNew = !item) {
  const base: Json = item ? structuredClone(item) : { type: 1, favorite: false, reprompt: 0, folderId: null, organizationId: null };
  const type = Number(base.type) || 1;
  const schema = SCHEMA[type];
  const data = Object.fromEntries((schema?.fields ?? []).map((f) => [f.key, str(obj(base[schema!.obj])?.[f.key])]));
  const login = obj(base.login);
  st.draft = {
    base,
    type,
    name: prefill.name ?? str(base.name),
    notes: str(base.notes),
    folderId: str(base.folderId),
    favorite: base.favorite === true,
    reprompt: Number(base.reprompt) === 1,
    collectionIds: Array.isArray(base.collectionIds) ? (base.collectionIds as string[]).filter((c) => writableCollections(str(base.organizationId)).some((x) => x.id === c)) : [],
    data: { ...data, ...prefill.data },
    uris:
      prefill.uris ??
      (Array.isArray(login?.uris) ? (login!.uris as Json[]) : [])
        .map((u) => ({ uri: str(u.uri), match: typeof u.match === "number" ? u.match : null }))
        .filter((u) => u.uri),
    autofillOnPageLoad: typeof login?.autofillOnPageLoad === "boolean" ? (login.autofillOnPageLoad as boolean) : null,
    fields: (Array.isArray(base.fields) ? (base.fields as Json[]) : []).map((f) => ({ name: str(f.name), value: str(f.value), type: Number(f.type) || 0, linkedId: f.linkedId })),
  };
  open(ctx, { kind: "edit", isNew: asNew });
}

export function buildItem(d: EditDraft): Json {
  const orNull = (s: string) => (s.trim() ? s : null);
  const item: Json = { ...d.base, type: d.type, name: d.name.trim(), notes: orNull(d.notes), folderId: d.folderId || null, favorite: d.favorite, reprompt: d.reprompt ? 1 : 0 };
  const schema = SCHEMA[d.type];
  for (const k of ["login", "secureNote", "card", "identity", "sshKey", "bankAccount", "driversLicense", "passport"]) if (k !== schema?.obj) delete item[k];
  if (schema) {
    const typed: Json = { ...obj(d.base[schema.obj]) };
    for (const f of schema.fields) typed[f.key] = orNull(d.data[f.key] ?? "");
    if (d.type === 1) {
      typed.uris = d.uris.map((u) => ({ uri: u.uri.trim(), match: u.match })).filter((u) => u.uri);
      typed.autofillOnPageLoad = d.autofillOnPageLoad;
    }
    item[schema.obj] = typed;
  } else item.secureNote = obj(d.base.secureNote) ?? { type: 0 };
  item.fields = d.fields
    // A new item's type may have changed under a linked field: it is gone with what it pointed at.
    .filter((f) => (f.type === 3 ? linkedKey(d.type, f.linkedId) : f.name.trim() || f.value))
    .map((f) =>
      f.type === 3
        ? { name: f.name, value: null, type: 3, linkedId: f.linkedId ?? null }
        : { name: f.name, value: f.type === 2 ? String(f.value === "true") : f.value || null, type: f.type, linkedId: null },
    );
  return item;
}

/** Live strength readout under the password field; updated in place so the caret stays put. */
export function strengthMeter(input: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const fill = h("i");
  const bar = h("div", { class: "meter", "aria-hidden": "true" }, fill);
  const text = h("span", { class: "meter-label" });
  const sync = (v: string) => {
    const s = strength(v);
    bar.dataset.level = String(s.level);
    text.textContent = v ? s.label : "";
    bar.hidden = !v;
  };
  sync(value);
  input.addEventListener("input", () => sync(input.value));
  return h("div", { class: "meter-wrap" }, bar, text);
}

/** The generator's strength bar, drawn once for the current value. */
export function strengthBar(value: string): HTMLElement {
  return h("div", { class: "meter", "data-level": String(strength(value).level), "aria-hidden": "true" }, h("i"));
}

/** Labels for Bitwarden's UriMatchStrategy, as the clients name them. */
export function uriMatchLabel(match: number): string {
  const key =
    match === URI_MATCH.Host ? "uriMatchHost"
    : match === URI_MATCH.StartsWith ? "uriMatchStartsWith"
    : match === URI_MATCH.Exact ? "uriMatchExact"
    : match === URI_MATCH.RegularExpression ? "uriMatchRegex"
    : match === URI_MATCH.Never ? "uriMatchNever"
    : "uriMatchBaseDomainShort";
  return t(key);
}

/** The default's name, for the "Default (…)" option. */
export function defaultUriMatchLabel(): string {
  return uriMatchLabel(settingsOf()?.defaultUriMatch ?? URI_MATCH.Domain);
}


/** The editor's website rows: URI + match detection, with Add / Remove. */
export function uriEditor(ctx: Ctx): Child[] {
  const d = st.draft!;
  const rows = d.uris.map((u, i) => {
    const open = st.uriOpen.has(i);
    const select = withChevron(
      h(
        "select",
        {
          "aria-label": t("matchDetection"),
          onchange: (e: Event) => {
            const v = (e.target as HTMLSelectElement).value;
            u.match = v === "" ? null : Number(v);
            ctx.rerender();
          },
        },
        h("option", { value: "", selected: u.match === null }, t("defaultLabelWithValue", defaultUriMatchLabel())),
        h("option", { value: String(URI_MATCH.Domain), selected: u.match === URI_MATCH.Domain }, t("uriMatchBaseDomainShort")),
        h("option", { value: String(URI_MATCH.Host), selected: u.match === URI_MATCH.Host }, t("uriMatchHost")),
        h("option", { value: String(URI_MATCH.Exact), selected: u.match === URI_MATCH.Exact }, t("uriMatchExact")),
        h("option", { value: String(URI_MATCH.Never), selected: u.match === URI_MATCH.Never }, t("uriMatchNever")),
        h(
          "optgroup",
          { label: t("uriMatchAdvanced") },
          h("option", { value: String(URI_MATCH.StartsWith), selected: u.match === URI_MATCH.StartsWith }, t("uriMatchStartsWith")),
          h("option", { value: String(URI_MATCH.RegularExpression), selected: u.match === URI_MATCH.RegularExpression }, t("uriMatchRegex")),
        ),
      ),
    );
    return h(
      "div",
      { class: "field-card", "data-row": "uri" },
      h(
        "div",
        { class: "field-card-top" },
        h("input", {
          class: "name",
          value: u.uri,
          placeholder: "https://example.com",
          "aria-label": t("uriLabel", String(i + 1)),
          autocapitalize: "off",
          spellcheck: false,
          oninput: (e: Event) => (u.uri = (e.target as HTMLInputElement).value),
        }),
        iconButton("tune", t("matchDetection"), () => (open ? st.uriOpen.delete(i) : st.uriOpen.add(i), ctx.rerender()), {
          class: `icon-btn sm${open ? " on" : ""}`,
          "aria-pressed": String(open),
        }),
        ...moveButtons(ctx, d.uris, i, () => st.uriOpen.clear()),
        d.uris.length > 1
          ? iconButton("trash", t("removeWebsite"), (e) => leave(rowOf(e, ".field-card"), () => (d.uris.splice(i, 1), st.uriOpen.clear(), ctx.rerender())), { class: "icon-btn sm" })
          : null,
      ),
      open ? h("div", { class: "field-card-bottom" }, select) : null,
      open ? h("p", { class: "caption" }, t("uriMatchHint")) : null,
      open && u.match !== null && URI_MATCH_ADVANCED.includes(u.match)
        ? h("p", { class: "caption warn" }, t(u.match === URI_MATCH.RegularExpression ? "uriMatchRegExHint" : "uriMatchStartsWithHint"))
        : null,
    );
  });
  return [
    sectionTitle(t("websites")),
    ...rows,
    h("button", { type: "button", class: "btn text small add-field", onclick: () => (d.uris.push({ uri: "", match: null }), ctx.rerender(), enter([...document.querySelectorAll("[data-row=uri]")].at(-1))) }, icon("plus"), t("addWebsite")),
  ];
}

/** The usernames used most across the vault's logins (list summaries only: no secrets involved). */
export function usernameSuggestions(): string[] {
  const counts = new Map<string, number>();
  for (const i of st.list?.items ?? []) if (i.type === 1 && i.sub) counts.set(i.sub, (counts.get(i.sub) ?? 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([u]) => u);
}

export type Detector = new (o: { formats: string[] }) => { detect(i: ImageBitmapSource): Promise<{ rawValue: string }[]> };
/** The platform's QR reader (macOS, Android, ChromeOS builds); absent elsewhere, where the button is hidden. */
export const barcodeDetector = (): Detector | undefined => (globalThis as { BarcodeDetector?: Detector }).BarcodeDetector;

export async function scanQr(file: File): Promise<string | undefined> {
  const Reader = barcodeDetector();
  if (!Reader) return undefined;
  return (await new Reader({ formats: ["qr_code"] }).detect(await createImageBitmap(file)))[0]?.rawValue;
}

/** Swap `list[i]` with its neighbour, for the editor's move up / down buttons. */
export function moveItem<T>(list: T[], i: number, by: -1 | 1) {
  const j = i + by;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j]!, list[i]!];
}

export const moveButtons = (ctx: Ctx, list: unknown[], i: number, reset?: () => void): Child[] => [
  i > 0 ? iconButton("arrowUp", t("moveUp"), () => (moveItem(list, i, -1), reset?.(), ctx.rerender()), { class: "icon-btn sm up" }) : null,
  i < list.length - 1 ? iconButton("arrowUp", t("moveDown"), () => (moveItem(list, i, 1), reset?.(), ctx.rerender()), { class: "icon-btn sm down" }) : null,
];

export function editView(ctx: Ctx, isNew: boolean): HTMLElement {
  const d = st.draft!;
  const exit = () => open(ctx, isNew ? { kind: "list" } : { kind: "item", id: str(d.base.id) });
  // Edits are not dropped on one click: the first says so and offers Discard; a second click within 4 s leaves.
  const back = () => {
    if (JSON.stringify(st.draft) === st.draftAtOpen) return exit();
    if (!(st.confirmDelete && st.armed === "discard")) toast(ctx, t("unsavedChanges"), { action: { label: t("discard"), run: exit } });
    twoTap(ctx, exit, "discard");
  };
  const field = (id: string, title: string, control: HTMLElement, trailing?: Child) => {
    // A select is wrapped for its chevron: the label must point at the select itself.
    (control.querySelector("select") ?? control).id = id;
    return h("div", { class: "field" }, h("label", { for: id }, h("span", {}, title), control), trailing);
  };
  const text = (get: () => string, set: (v: string) => void, props: Record<string, unknown> = {}) => {
    const { area, ...rest } = props;
    return h(area ? "textarea" : "input", { ...rest, value: get(), oninput: (e: Event) => set((e.target as HTMLInputElement).value) });
  };
  const select = (get: () => string, set: (v: string) => void, options: [string, string][], id?: string) =>
    withChevron(h("select", { id, onchange: (e: Event) => set((e.target as HTMLSelectElement).value) }, ...options.map(([v, l]) => h("option", { value: v, selected: v === get() }, l))));

  const specField = (f: Spec) => {
    const get = () => d.data[f.key] ?? "";
    const set = (v: string) => (d.data[f.key] = v);
    const id = `edit-${f.key}`;
    if (f.options) return field(id, label(f.key), select(get, set, [["", "—"], ...f.options.map((o): [string, string] => [o, o])]));
    // Card number: fill in the brand once the number is entered, and warn (never block) on a typo.
    const cardNumber = d.type === 3 && f.key === "number";
    const cardWarn = () => !!get() && !luhnValid(get());
    const shownWarn = cardNumber && cardWarn();
    const onchange = cardNumber
      ? () => {
          const brand = d.data.brand ? undefined : cardBrand(get());
          if (brand) d.data.brand = brand;
          if (brand || cardWarn() !== shownWarn) ctx.rerender();
        }
      : undefined;
    const below: Child[] = [];
    if (shownWarn) below.push(h("p", { class: "caption warn", role: "status" }, t("invalidCardNumber")));
    if (d.type === 1 && f.key === "username" && !get()) {
      const known = usernameSuggestions();
      if (known.length) below.push(chipRow({ role: "group", "aria-label": t("suggestions") }, ...known.map((u) => h("button", { type: "button", class: "chip", onclick: () => ((d.data.username = u), ctx.rerender()) }, u))));
    }
    const wrap = (block: HTMLElement) => (below.length ? h("div", { class: "field-block" }, block, ...below) : block);
    const openGenerator = (field: GeneratorPick["field"]) => {
      startGeneratorPick(field);
      st.picking = field;
      ctx.rerender();
    };
    const generateUsername = d.type === 1 && f.key === "username" ? h("span", { class: "trailing" }, iconButton("generator", t("generateUsername"), () => openGenerator("username"))) : undefined;
    if (!f.secret) return wrap(field(id, label(f.key), text(get, set, { autocomplete: "off", spellcheck: false, area: f.area }), generateUsername));
    const reveal = st.reveal.has(id);
    // A multi-line secret (a private key) stays a textarea, masked by CSS: an input would drop its line breaks.
    const control = f.area
      ? text(get, set, { area: true, autocomplete: "off", spellcheck: false, class: reveal ? "mono" : "mono masked" })
      : text(get, set, { type: reveal ? "text" : "password", autocomplete: "new-password", spellcheck: false, class: "mono", onchange, inputMode: cardNumber ? "numeric" : undefined });
    const block = field(
      id,
      label(f.key),
      control,
      h(
        "span",
        { class: "trailing" },
        iconButton(reveal ? "eyeOff" : "eye", t(reveal ? "hidePassword" : "showPassword"), () => {
          if (reveal) st.reveal.delete(id);
          else st.reveal.add(id);
          ctx.rerender();
        }),
        d.type === 1 && f.key === "password"
          ? iconButton("generator", t("generatePassword"), () => openGenerator("password"))
          : null,
        d.type === 1 && f.key === "totp" && barcodeDetector()
          ? h(
              "label",
              { class: "icon-btn", title: t("scanQrImage") },
              icon("search"),
              h("span", { class: "sr-only" }, t("scanQrImage")),
              h("input", {
                type: "file",
                accept: "image/*",
                class: "sr-only",
                onchange: async (e: Event) => {
                  const file = (e.target as HTMLInputElement).files?.[0];
                  const text = file ? await scanQr(file).catch(() => undefined) : undefined;
                  if (text?.startsWith("otpauth://")) d.data.totp = text;
                  else st.error = t(text ? "qrNotAuthenticator" : "qrNotFound");
                  ctx.rerender();
                },
              }),
            )
          : null,
      ),
    );
    return d.type === 1 && f.key === "password" ? h("div", { class: "field-block" }, block, strengthMeter(control, get())) : wrap(block);
  };

  const onsubmit = async (e: Event) => {
    e.preventDefault();
    if (!d.name.trim()) return ((st.error = t("nameRequired")), ctx.rerender());
    st.busy = true;
    st.error = undefined;
    ctx.rerender();
    const org = isNew ? str(d.base.organizationId) : "";
    if (org && !d.collectionIds.length) return ((st.error = t("pickCollection")), ctx.rerender());
    const r = await send<VaultList>({ type: "saveItem", item: buildItem(d), ...(org ? { collectionIds: d.collectionIds } : {}) });
    st.busy = false;
    if (!r.ok) return ((st.error = r.error), ctx.rerender());
    st.list = r.data;
    st.item = undefined;
    await refreshPageMatches(); // a new login for this site joins "On this site"
    open(ctx, isNew ? { kind: "list" } : { kind: "item", id: str(d.base.id) });
    toast(ctx, t("saved"));
    // Opt-in: a new login password is checked once, on save, and only warns.
    const pw = d.data.password ?? "";
    if (d.type === 1 && pw && pw !== str(obj(d.base.login)?.password) && uiPref("breachSave") === "on")
      void pwnedCount(pw).then((n) => n > 0 && toast(ctx, t("pwnedFound", n.toLocaleString()), { error: true })).catch(() => undefined);
  };
  const typeChip = (type: number, ic: IconName) =>
    h("button", { type: "button", class: "chip", "aria-pressed": String(d.type === type), onclick: () => {
      // The site's name only fits a login: a card or a note started from a site tab starts unnamed.
      if (type !== 1 && d.name === URL.parse(d.uris[0]?.uri ?? "")?.hostname) d.name = "";
      d.type = type;
      ctx.rerender();
    } }, icon(ic), t(TYPE_LABEL[type]!));
  const fav = h("input", { type: "checkbox", checked: d.favorite, "aria-label": t("favorite"), onchange: (e: Event) => (d.favorite = (e.target as HTMLInputElement).checked) });
  const customRow = (f: EditDraft["fields"][number], i: number) => {
    const linkable = LINKED[d.type] ?? [];
    const hint = h("p", { class: "field-card-hint" });
    const syncHint = () => {
      const on = (f.pageLabel || f.name).trim();
      const linked = linkedKey(d.type, f.linkedId);
      hint.textContent = !on
        ? t("fieldHintEmpty")
        : f.type === 3 && linked
          ? t("fieldHintLinked", on, label(linked))
          : f.type === 2
            ? t(f.value === "true" ? "fieldHintChecked" : "fieldHintUnchecked", on)
            : t(f.type === 1 ? "fieldHintHidden" : "fieldHintText", on);
    };
    syncHint();
    const col = (id: string, caption: string, control: Child, grow = true) => h("div", { class: `field-card-col${grow ? " grow" : ""}` }, h("label", { for: id }, caption), control);
    const valueId = `field-value-${i}`;
    const typeId = `field-type-${i}`;
    return h(
      "div",
      { class: "field-card", "data-row": "field" },
      h(
        "div",
        { class: "field-card-top" },
        col(
          `field-name-${i}`,
          t("fieldName"),
          h("input", {
            id: `field-name-${i}`, // a re-render gives focus back by id; without one it jumps to the Name box
            class: "name",
            value: f.name,
            oninput: (e: Event) => {
              f.name = (e.target as HTMLInputElement).value;
              f.pageLabel = undefined; // the user renamed it: the page's label no longer says which field this is
              syncHint();
            },
          }),
        ),
        ...moveButtons(ctx, d.fields, i),
        iconButton("trash", t("removeField"), (e) => leave(rowOf(e, ".field-card"), () => (d.fields.splice(i, 1), ctx.rerender())), { class: "icon-btn sm" }),
      ),
      h(
        "div",
        { class: "field-card-bottom" },
        f.type === 3
          ? col(
              valueId,
              t("fieldLinkedTo"),
              select(
                () => String(f.linkedId ?? ""),
                (v) => {
                  f.linkedId = Number(v);
                  syncHint();
                },
                linkable.map((l): [string, string] => [String(l.id), label(l.key)]),
                valueId,
              ),
            )
          : f.type === 2
            ? col(
                valueId,
                t("fieldChecked"),
                select(
                  () => (f.value === "true" ? "true" : "false"),
                  (v) => {
                    f.value = v;
                    syncHint();
                  },
                  [["false", t("no")], ["true", t("yes")]],
                  valueId,
                ),
              )
            : col(
                valueId,
                t("fieldValue"),
                h("input", {
                  id: valueId,
                  value: f.value,
                  type: f.type === 1 ? "password" : "text",
                  oninput: (e: Event) => (f.value = (e.target as HTMLInputElement).value),
                }),
              ),
        col(
          typeId,
          t("fieldKind"),
          select(
            () => String(f.type),
            (v) => {
              f.type = Number(v);
              if (f.type === 3) f.linkedId = linkable[0]?.id;
              ctx.rerender();
            },
            [["0", t("fieldText")], ["1", t("fieldHidden")], ["2", t("fieldBoolean")], ...(linkable.length ? [["3", t("fieldLinked")] as [string, string]] : [])],
            typeId,
          ),
          false,
        ),
      ),
      hint,
    );
  };

  return h(
    "form",
    { class: "page editor", onsubmit },
    topBar(iconButton("back", t("cancel"), back), h("h1", {}, t(isNew ? "newItem" : "editItem")), spacer()),
    errorBox(),
    isNew ? h("div", { class: "chips", role: "group", "aria-label": t("itemType") }, typeChip(1, "key"), typeChip(3, "card"), typeChip(4, "user"), typeChip(2, "note"), typeChip(5, "server"), typeChip(6, "landmark"), typeChip(7, "card"), typeChip(8, "globe")) : null,
    field("edit-name", t("name"), text(() => d.name, (v) => (d.name = v), { required: true, "data-autofocus": "1" })),
    ...(SCHEMA[d.type]?.fields ?? []).map(specField),
    ...(d.type === 1 ? uriEditor(ctx) : []),
    d.type === 1 && settingsOf()?.autofillOnPageLoad
      ? field(
          "edit-auto-pageload",
          t("autofillOnPageLoad"),
          select(
            () => (d.autofillOnPageLoad === null ? "" : String(d.autofillOnPageLoad)),
            (v) => (d.autofillOnPageLoad = v === "" ? null : v === "true"),
            [["", t("defaultLabelWithValue", settingsOf()?.autofillOnPageLoadDefault === false ? t("off") : t("on"))], ["true", t("on")], ["false", t("off")]],
          ),
        )
      : null,
    sectionTitle(t("customFields")),
    ...d.fields.map(customRow),
    h(
      "div",
      { class: "add-field-row" },
      h("button", { type: "button", class: "btn text small add-field", onclick: () => (d.fields.push({ name: "", value: "", type: 0 }), ctx.rerender(), enter([...document.querySelectorAll("[data-row=field]")].at(-1))) }, icon("plus"), t("addField")),
      h("button", { type: "button", class: "btn text small add-field", onclick: () => void pickFromPage(ctx, isNew) }, icon("globe"), t("pickField")),
    ),
    field("edit-notes", t("notes"), text(() => d.notes, (v) => (d.notes = v), { area: true, rows: 3 })),
    hasMarkup(d.notes)
      ? h("button", { type: "button", class: "chip small", "aria-pressed": String(st.notesPreview), onclick: () => ((st.notesPreview = !st.notesPreview), ctx.rerender()) }, t("previewNotes"))
      : null,
    st.notesPreview && hasMarkup(d.notes) ? renderMarkdown(d.notes) : null,
    isNew && writableOrgs().length
      ? field(
          "edit-owner",
          t("owner"),
          select(
            () => str(d.base.organizationId),
            (v) => ((d.base.organizationId = v || null), (d.collectionIds = []), ctx.rerender()),
            [["", t("ownerMe")], ...writableOrgs().map((o): [string, string] => [o.id, o.name])],
          ),
        )
      : null,
    isNew && str(d.base.organizationId) ? collectionPicker(ctx, str(d.base.organizationId), d.collectionIds) : null,
    field("edit-folder", t("folder"), select(() => d.folderId, (v) => (d.folderId = v), [["", t("noFolder")], ...(st.list?.folders ?? []).map((f): [string, string] => [f.id, f.name])])),
    h("label", { class: "row check-card" }, h("div", { class: "body" }, h("span", { class: "title" }, t("favorite"))), h("span", { class: "switch" }, fav, h("span"))),
    h(
      "label",
      { class: "row check-card" },
      h("div", { class: "body" }, h("span", { class: "title" }, t("repromptToggle")), h("span", { class: "sub wrap" }, t("repromptToggleHint"))),
      h("span", { class: "switch" }, h("input", { type: "checkbox", checked: d.reprompt, onchange: (e: Event) => (d.reprompt = (e.target as HTMLInputElement).checked) }), h("span")),
    ),
    st.busy ? progress() : null,
    h("div", { class: "editor-footer" }, h("button", { type: "submit", class: "btn filled wide", disabled: st.busy }, icon("check"), t("save"))),
  );
}
