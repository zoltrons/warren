// Send screen: the user's sends, create a text or file send, edit or disable one, copy its link, delete it.
// Talks to the service worker only; the link (with its key fragment) is built there.
import type { SendItem } from "../shared/messages.ts";
import { ci } from "../shared/validate.ts";
import { type Child, day, h, plural, send, sessionNow, t, withChevron } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { copy, type Ctx, iconButton, tile, toast } from "./vault.ts";

const DELETION_DAYS = [1, 2, 3, 7, 14, 30] as const;
const MAX_FILE_BYTES = 25 * 1024 * 1024; // keep in sync with MAX_SEND_FILE_BYTES in background/vault.ts

interface Draft {
  /** Set when editing an existing send. */
  id?: string;
  /** Edit: the current deletion date, kept while `days` is 0. */
  deletionDate?: string;
  disabled: boolean;
  kind: "text" | "file";
  name: string;
  text: string;
  hidden: boolean;
  /** New sends: recipients do not see the sender's email address. */
  hideEmail: boolean;
  file?: File;
  password: string;
  days: number;
  maxAccess: string;
  /** Edit: the send currently has an access password. */
  originalHasPassword: boolean;
  /** Edit: remove the access password (PUT /sends/{id}/remove-password). */
  removePassword: boolean;
}

const newDraft = (): Draft => ({ kind: "text", name: "", text: "", hidden: false, hideEmail: false, password: "", days: 7, maxAccess: "", disabled: false, originalHasPassword: false, removePassword: false });
const editDraft = (s: SendItem): Draft => ({
  ...newDraft(),
  id: s.id,
  kind: s.type === 1 ? "file" : "text",
  name: s.name,
  days: 0,
  deletionDate: s.deletionDate,
  maxAccess: s.maxAccessCount === undefined ? "" : String(s.maxAccessCount),
  disabled: s.disabled,
  originalHasPassword: s.hasPassword,
});

const sd = {
  list: undefined as SendItem[] | undefined,
  loading: false,
  busy: false,
  error: undefined as string | undefined,
  draft: undefined as Draft | undefined,
  confirmDelete: "",
};

/** Starts a new text send holding `text` (from "Share as Send" on a vault value). */
export function startTextSend(text: string): void {
  Object.assign(sd, { draft: { ...newDraft(), text, hidden: true }, error: undefined });
}

export function resetSend(): void {
  Object.assign(sd, { list: undefined, loading: false, busy: false, error: undefined, draft: undefined, confirmDelete: "" });
}

async function load(ctx: Ctx) {
  sd.loading = true;
  const r = await send<SendItem[]>({ type: "sendList" });
  sd.loading = false;
  if (r.ok) sd.list = r.data;
  else sd.error = r.error;
  ctx.rerender();
}

function errorBox(): Child {
  return sd.error ? h("div", { class: "error", role: "alert" }, icon("error"), h("div", {}, sd.error)) : null;
}

async function remove(ctx: Ctx, id: string) {
  if (sd.confirmDelete !== id) {
    sd.confirmDelete = id;
    // Disarms on its own, as the vault's delete does (twoTap), so a stray click later cannot delete.
    setTimeout(() => {
      if (sd.confirmDelete !== id) return;
      sd.confirmDelete = "";
      ctx.rerender();
    }, 4000);
    return ctx.rerender();
  }
  sd.confirmDelete = "";
  const r = await send<SendItem[]>({ type: "deleteSend", id });
  if (r.ok) {
    sd.list = r.data;
    toast(ctx, t("sendDeleted"));
  } else sd.error = r.error;
  ctx.rerender();
}

/** Editing loads the decrypted text of a text send (the list only carries metadata). */
async function editSend(ctx: Ctx, item: SendItem) {
  const d = editDraft(item);
  if (d.kind === "text") {
    sd.busy = true;
    ctx.rerender();
    const r = await send<Record<string, unknown>>({ type: "getSend", id: item.id });
    if (r.ok) {
      // The decrypted send keeps the server's key casing (`Text` from some Vaultwarden answers).
      const text = ci(r.data, "text");
      d.text = typeof ci(text, "text") === "string" ? (ci(text, "text") as string) : "";
      d.hidden = ci(text, "hidden") === true;
    }
    sd.busy = false;
    // Never open an editor with an empty text: saving it would wipe the send. The list stays, with the error.
    if (!r.ok) {
      sd.error = r.error;
      return ctx.rerender();
    }
  }
  sd.draft = d;
  ctx.rerender();
}

function listView(ctx: Ctx): HTMLElement {
  const items = sd.list ?? [];
  const date = (iso: string) => (iso ? day(iso) : "");
  return h(
    "div",
    { class: "page" },
    h(
      "div",
      { class: "top" },
      h("h1", { class: "grow" }, t("send")),
      // The empty list leads with its own "New Send": the header one would say it twice.
      h("button", { type: "button", class: "icon-btn sm add", hidden: !(sd.loading && !sd.list) && !items.length, "aria-label": t("newSend"), title: t("newSend"), onclick: () => ((sd.draft = newDraft()), (sd.error = undefined), ctx.rerender()) }, icon("plus")),
    ),
    errorBox(),
    sd.loading && !sd.list
      ? h("div", { class: "progress" })
      : items.length
        ? h(
            "div",
            { class: "group", role: "list" },
            ...items.map((s) =>
              h(
                "div",
                { class: "row", role: "listitem" },
                // The name opens the Send for editing, as a vault row opens its item; status is written out under it.
                h(
                  s.failed ? "div" : "button",
                  s.failed ? { class: "row-main" } : { type: "button", class: "row-main", onclick: () => ((sd.error = undefined), void editSend(ctx, s)) },
                  // What the Send holds, at a glance: a file or a text.
                  h("span", { class: "tile glyph", "aria-hidden": "true" }, icon(s.type === 1 ? "attach" : "note")),
                  h(
                    "div",
                    { class: "body" },
                    h("span", { class: "title" }, s.failed ? t("decryptFailed") : s.name),
                    h("span", { class: "sub wrap" }, t("sendDeletes", date(s.deletionDate))),
                    s.hasPassword || s.disabled
                      ? h("span", { class: "sub wrap" }, [s.hasPassword ? t("sendPasswordProtected") : "", s.disabled ? t("sendDisabled") : ""].filter(Boolean).join(", "))
                      : null,
                    sd.confirmDelete === s.id ? h("span", { class: "sub wrap warn-text", role: "status" }, t("tapAgainToDelete")) : null,
                  ),
                ),
                h(
                  "span",
                  { class: "field-actions hover-actions" },
                  s.failed ? null : iconButton("copy", t("copyLinkNamed", s.name), () => void copy(ctx, s.link)),
                  // Armed, the icon turns red in place (the row does not shift) and the row says it in words below.
                  sd.confirmDelete === s.id
                    ? iconButton("trash", t("tapAgainToDelete"), () => void remove(ctx, s.id), { class: "icon-btn danger" })
                    : iconButton("trash", t("deleteNamed", s.name), () => void remove(ctx, s.id)),
                ),
              ),
            ),
          )
        : h(
            "div",
            { class: "empty" },
            h("strong", {}, t("noSends")),
            h("p", {}, t("noSendsHint")),
            h("button", { type: "button", class: "btn filled small", onclick: () => ((sd.draft = newDraft()), (sd.error = undefined), ctx.rerender()) }, icon("plus"), t("newSend")),
          ),
  );
}

async function create(ctx: Ctx, d: Draft) {
  if (!d.name.trim()) return ((sd.error = t("nameRequired")), ctx.rerender());
  if (!d.id && d.kind === "file" && !d.file) return ((sd.error = t("chooseFile")), ctx.rerender());
  if (d.file && d.kind === "file" && d.file.size > MAX_FILE_BYTES) return ((sd.error = t("fileTooLarge")), ctx.rerender());
  sd.busy = true;
  sd.error = undefined;
  ctx.rerender();
  const common = {
    name: d.name.trim(),
    ...(d.password ? { password: d.password } : {}),
    ...(d.days ? { deletionDate: new Date(Date.now() + d.days * 86_400_000).toISOString() } : {}),
    maxAccessCount: d.maxAccess ? Number(d.maxAccess) : null,
    disabled: d.disabled,
  };
  const body = d.id
    ? { id: d.id, ...common, ...(d.kind === "text" ? { text: { text: d.text, hidden: d.hidden } } : {}) }
    : { ...common, ...(d.kind === "text" ? { text: { text: d.text, hidden: d.hidden } } : {}), hideEmail: d.hideEmail };
  const asked = sessionNow();
  const file = !d.id && d.kind === "file" && d.file ? { name: d.file.name, data: new Uint8Array(await d.file.arrayBuffer()).toBase64() } : undefined;
  // A lock or another account while the file was read: this send was meant for the session before.
  if (asked !== sessionNow()) return void ((sd.busy = false), ctx.rerender());
  const before = new Set((sd.list ?? []).map((s) => s.id));
  const r = await send<SendItem[]>({ type: "saveSend", send: body, ...(file ? { file } : {}) });
  if (!r.ok) return ((sd.busy = false), (sd.error = r.error), ctx.rerender());
  let next = r.data;
  if (d.id && d.removePassword) {
    const removed = await send<SendItem[]>({ type: "removeSendPassword", id: d.id });
    if (!removed.ok) return ((sd.busy = false), (sd.error = removed.error), ctx.rerender());
    next = removed.data;
  }
  sd.busy = false;
  sd.list = next;
  sd.draft = undefined;
  const created = r.data.find((s) => !before.has(s.id));
  if (created) await copy(ctx, created.link).catch(() => toast(ctx, t("saved")));
  else toast(ctx, t("saved"));
  ctx.rerender();
}

function createView(ctx: Ctx, d: Draft): HTMLElement {
  const field = (id: string, label: string, control: HTMLElement) => {
    control.id = id;
    return h("div", { class: "field" }, h("label", { for: id }, h("span", {}, label), control));
  };
  const input = (key: "name" | "password" | "maxAccess", props: Record<string, unknown>) =>
    h("input", { ...props, value: d[key], oninput: (e: Event) => (d[key] = (e.target as HTMLInputElement).value) });
  const kindChip = (kind: Draft["kind"], label: string, ic: IconName) =>
    h("button", { type: "button", class: "chip", "aria-pressed": String(d.kind === kind), onclick: () => ((d.kind = kind), ctx.rerender()) }, icon(ic), label);
  const hidden = h("input", { type: "checkbox", checked: d.hidden, "aria-label": t("hideText"), onchange: (e: Event) => (d.hidden = (e.target as HTMLInputElement).checked) });
  const hideEmail = h("input", { type: "checkbox", checked: d.hideEmail, "aria-label": t("hideEmail"), onchange: (e: Event) => (d.hideEmail = (e.target as HTMLInputElement).checked) });
  const disabled = h("input", { type: "checkbox", checked: d.disabled, "aria-label": t("disableSend"), onchange: (e: Event) => (d.disabled = (e.target as HTMLInputElement).checked) });
  const isNew = !d.id;
  // Edit: 0 keeps the current deletion date.
  const dayChoices: number[] = isNew ? [...DELETION_DAYS] : [0, ...DELETION_DAYS];
  const dayLabel = (n: number) => (n ? plural("days", n) : t("sendDeletes", d.deletionDate ? day(d.deletionDate) : ""));
  return h(
    "form",
    { class: "page", onsubmit: (e: Event) => (e.preventDefault(), void create(ctx, d)) },
    h("div", { class: "top" }, iconButton("back", t("cancel"), () => ((sd.draft = undefined), (sd.error = undefined), ctx.rerender())), h("h1", {}, t(isNew ? "newSend" : "editSend"))),
    isNew ? h("div", { class: "chips segmented", role: "group", "aria-label": t("sendType") }, kindChip("text", t("sendText"), "note"), kindChip("file", t("sendFile"), "attach")) : null,
    field("send-name", t("name"), input("name", { required: true, "data-autofocus": "1" })),
    d.kind === "text"
      ? field("send-text", t("sendText"), h("textarea", { rows: 4, value: d.text, oninput: (e: Event) => (d.text = (e.target as HTMLTextAreaElement).value) }))
      : isNew
        ? // The app's own row instead of the browser's "Choose File / no file selected"; it names the chosen file.
          h(
            "label",
            { class: "row form-row" },
            icon("attach"),
            h("div", { class: "body" }, h("span", { class: "title" }, d.file?.name ?? t("chooseFile"))),
            h("input", { type: "file", class: "sr-only", "aria-label": t("sendFile"), onchange: (e: Event) => ((d.file = (e.target as HTMLInputElement).files?.[0]), ctx.rerender()) }),
          )
        : null,
    d.kind === "text" ? h("label", { class: "row form-row" }, icon("eyeOff"), h("div", { class: "body" }, t("hideText")), h("span", { class: "switch" }, hidden, h("span"))) : null,
    field(
      "send-days",
      t("deleteAfter"),
      withChevron(h("select", { onchange: (e: Event) => (d.days = Number((e.target as HTMLSelectElement).value)) }, ...dayChoices.map((n) => h("option", { value: String(n), selected: n === d.days }, dayLabel(n))))),
    ),
    field("send-password", t(isNew || !d.originalHasPassword || d.removePassword ? "sendPasswordOptional" : "newPasswordOptional"), input("password", { type: "password", autocomplete: "new-password", disabled: d.removePassword })),
    field("send-max", t("maxAccessOptional"), input("maxAccess", { type: "number", min: 1, inputMode: "numeric" })),
    !isNew && d.originalHasPassword
      ? h(
          "label",
          { class: "row" },
          icon("lock"),
          h("div", { class: "body" }, h("span", { class: "title" }, t("removePassword")), h("span", { class: "sub wrap" }, t("removeSendPasswordHint"))),
          h("span", { class: "switch" }, h("input", { type: "checkbox", checked: d.removePassword, "aria-label": t("removePassword"), onchange: (e: Event) => ((d.removePassword = (e.target as HTMLInputElement).checked), (d.password = ""), ctx.rerender()) }), h("span")),
        )
      : null,
    isNew ? h("label", { class: "row form-row" }, icon("eyeOff"), h("div", { class: "body" }, t("hideEmail")), h("span", { class: "switch" }, hideEmail, h("span"))) : null,
    isNew ? null : h("label", { class: "row" }, icon("lock"), h("div", { class: "body" }, t("disableSend")), h("span", { class: "switch" }, disabled, h("span"))),
    errorBox(),
    sd.busy ? h("div", { class: "progress" }) : null,
    h("button", { type: "submit", class: "btn filled wide", disabled: sd.busy }, t(isNew ? "createSendCopyLink" : "save")),
  );
}

export function sendScreen(ctx: Ctx): HTMLElement {
  if (!sd.list && !sd.loading && !sd.error) void load(ctx);
  return sd.draft ? createView(ctx, sd.draft) : listView(ctx);
}
