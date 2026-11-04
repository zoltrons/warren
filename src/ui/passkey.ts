// Approval window for a website's passkey request. The service worker opens popup.html?passkey=<id>;
// after unlocking (if needed) the user picks a passkey, saves a new one, or hands the call back to the browser.
import type { PasskeyCandidate, PasskeyPrompt } from "../shared/messages.ts";
import { h, send, t } from "./dom.ts";
import { icon } from "./icons.ts";
import { type Ctx, tile } from "./vault.ts";

export const passkeyRequestId = new URLSearchParams(location.search).get("passkey");

const pk = {
  prompt: undefined as PasskeyPrompt | undefined,
  loading: false,
  busy: false,
  error: undefined as string | undefined,
  /** Create: the login whose passkey the user is being asked to replace. */
  confirm: undefined as PasskeyCandidate | undefined,
};

async function load(ctx: Ctx) {
  pk.loading = true;
  const r = await send<PasskeyPrompt>({ type: "passkeyPrompt", id: passkeyRequestId! });
  pk.loading = false;
  if (r.ok) pk.prompt = r.data;
  else pk.error = r.error;
  ctx.rerender();
}

async function decide(ctx: Ctx, action: "use" | "fallback", itemId?: string, credentialId?: string, replace = false) {
  pk.busy = true;
  pk.confirm = undefined;
  ctx.rerender();
  const r = await send<null>({ type: "passkeyDecision", id: passkeyRequestId!, action, ...(itemId ? { itemId, credentialId } : {}), ...(replace ? { replace } : {}) });
  if (r.ok) return window.close();
  pk.busy = false;
  pk.error = r.error;
  ctx.rerender();
}

/** One login to pick: a stored passkey to sign in with, or (create) the item a new passkey joins. */
const list = (ctx: Ctx, candidates: PasskeyCandidate[]) =>
  h(
    "div",
    { class: "group", role: "list" },
    ...candidates.map((c) =>
      h(
        "button",
        {
          type: "button",
          class: "row",
          role: "listitem",
          disabled: pk.busy,
          // A login that holds a passkey is only replaced after the user confirms it.
          onclick: () => (c.replaces ? ((pk.confirm = c), ctx.rerender()) : void decide(ctx, "use", c.itemId, c.credentialId)),
        },
        tile(c.name, 1),
        h("div", { class: "body" }, h("span", { class: "title" }, c.name), h("span", { class: "sub" }, c.replaces ? t("passkeyHasOne", c.userName) : c.userName)),
        icon("chevron"),
      ),
    ),
  );

export function passkeyScreen(ctx: Ctx): HTMLElement {
  if (!pk.prompt && !pk.loading && !pk.error) void load(ctx);
  const p = pk.prompt;
  const create = p?.kind === "create";
  return h(
    "div",
    { class: "page" },
    h("div", { class: "brand" }, h("div", { class: "logo" }, icon("fingerprint")), h("h1", {}, t(create ? "passkeySaveTitle" : "passkeySignInTitle")), p ? h("p", {}, p.origin) : null),
    pk.error ? h("div", { class: "error", role: "alert" }, icon("error"), h("div", {}, pk.error)) : null,
    pk.confirm
      ? h(
          "div",
          { class: "actions", role: "alertdialog", "aria-label": t("passkeyReplaceTitle") },
          h("p", { class: "note" }, t("passkeyReplaceConfirm", pk.confirm.name)),
          h("button", { type: "button", class: "btn filled wide", disabled: pk.busy, onclick: () => void decide(ctx, "use", pk.confirm!.itemId, "", true) }, t("passkeyReplace")),
          h("button", { type: "button", class: "btn text", disabled: pk.busy, onclick: () => ((pk.confirm = undefined), ctx.rerender()) }, t("cancel")),
        )
      : null,
    pk.confirm
      ? null
      : !p
      ? pk.error ? null : h("div", { class: "progress" })
      : create
        ? h(
            "div",
            { class: "actions" },
            h("p", { class: "note" }, t("passkeySaveFor", p.userName ?? "", p.rpName || p.rpId)),
            h("button", { type: "button", class: "btn filled wide", disabled: pk.busy, onclick: () => void decide(ctx, "use") }, t(p.candidates.length ? "passkeySaveNew" : "passkeySave")),
            p.candidates.length ? h("p", { class: "note" }, t("passkeySaveTo")) : null,
            p.candidates.length ? list(ctx, p.candidates) : null,
          )
        : p.candidates.length
          ? list(ctx, p.candidates)
          : h(
              "div",
              { class: "empty" },
              icon("fingerprint"),
              h("strong", {}, t("passkeyNone")),
              h("p", {}, p.others ? t("passkeyNotAsked", p.rpId) : t("passkeyNoneFor", p.rpId)),
            ),
    pk.busy ? h("div", { class: "progress" }) : null,
    h("button", { type: "button", class: "btn text", disabled: pk.busy, onclick: () => void decide(ctx, "fallback") }, t("passkeyUseBrowser")),
  );
}
