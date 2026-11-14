// Folders, organizations (collections, move to an org) and the security report.
import type { BreachResults, SecurityReport, VaultItem } from "../shared/messages.ts";
import { type Child, h, leave, rowOf, send, t, withChevron } from "./dom.ts";
import { icon } from "./icons.ts";
import { fetchRange } from "./pwned.ts";
import { type Ctx, st, str, iconButton, errorBox, topBar, sectionTitle, progress, open } from "./vault-shared.ts";
import { itemRow, sortItems } from "./vault-list.ts";
import { vaultAction, twoTap } from "./vault-item.ts";

// ---------- folders ----------

// ---------- organizations ----------

/** Collections of `orgId` the user may add items to. */
export const writableCollections = (orgId: string) => (st.list?.collections ?? []).filter((c) => c.organizationId === orgId && !c.readOnly);
export const writableOrgs = () => (st.list?.organizations ?? []).filter((o) => writableCollections(o.id).length);

/** One switch per writable collection of `orgId`; `chosen` is changed in place. */
export function collectionPicker(ctx: Ctx, orgId: string, chosen: string[]): HTMLElement {
  return h(
    "div",
    { class: "group", role: "group", "aria-label": t("collections") },
    ...writableCollections(orgId).map((c) =>
      h(
        "label",
        { class: "row check-card" },
        icon("folder"),
        h("div", { class: "body" }, h("span", { class: "title" }, c.name)),
        h(
          "span",
          { class: "switch" },
          h("input", {
            type: "checkbox",
            checked: chosen.includes(c.id),
            onchange: (e: Event) => {
              const on = (e.target as HTMLInputElement).checked;
              const at = chosen.indexOf(c.id);
              if (on && at < 0) chosen.push(c.id);
              if (!on && at >= 0) chosen.splice(at, 1);
              ctx.rerender();
            },
          }),
          h("span"),
        ),
      ),
    ),
  );
}

/** Move a personal item into an organization, or change an organization item's collections. */
export const orgDraft = { id: "", orgId: "", ids: [] as string[] };
export function orgView(ctx: Ctx, id: string): HTMLElement {
  const item = st.item && st.item.id === id ? st.item : undefined;
  const back = () => open(ctx, { kind: "item", id });
  const current = str(item?.organizationId);
  if (orgDraft.id !== id && item) {
    const ids = Array.isArray(item?.collectionIds) ? [...(item!.collectionIds as string[])] : [];
    Object.assign(orgDraft, { id, orgId: current || (writableOrgs()[0]?.id ?? ""), ids });
  }
  const moving = !current;
  // Collections the user cannot change stay as they are (the server keeps them only if sent).
  const fixed = moving ? [] : orgDraft.ids.filter((c) => !writableCollections(current).some((x) => x.id === c));
  const submit = () => {
    const ids = [...new Set([...orgDraft.ids])];
    if (!ids.length) return ((st.error = t("pickCollection")), ctx.rerender());
    void vaultAction(ctx, moving ? { type: "moveToOrg", id, organizationId: orgDraft.orgId, collectionIds: ids } : { type: "setCollections", id, collectionIds: ids }, "saved", false).then(() => {
      if (st.route.kind === "org" && !st.error) back();
    });
  };
  return h(
    "div",
    { class: "page" },
    topBar(iconButton("back", t("back"), back), h("h1", {}, t(moving ? "moveToOrg" : "editCollections"))),
    errorBox(),
    item ? null : h("p", { class: "caption" }, t("loading")),
    moving
      ? h(
          "div",
          { class: "field" },
          h(
            "label",
            { for: "org-owner" },
            h("span", {}, t("organization")),
            withChevron(
              h(
                "select",
                { id: "org-owner", onchange: (e: Event) => ((orgDraft.orgId = (e.target as HTMLSelectElement).value), (orgDraft.ids = []), ctx.rerender()) },
                ...writableOrgs().map((o) => h("option", { value: o.id, selected: o.id === orgDraft.orgId }, o.name)),
              ),
            ),
          ),
        )
      : null,
    moving ? h("p", { class: "caption" }, t("moveToOrgHint")) : null,
    orgDraft.orgId ? collectionPicker(ctx, orgDraft.orgId, orgDraft.ids) : null,
    fixed.length ? h("p", { class: "caption" }, t("collectionsReadOnly", String(fixed.length))) : null,
    st.busy ? progress() : null,
    h("button", { type: "button", class: "btn filled wide", disabled: st.busy || !item, onclick: submit }, icon("check"), t(moving ? "moveToOrg" : "save")),
  );
}

export const REPORT_PARALLEL = 6;

export async function loadReport(ctx: Ctx) {
  st.report = { done: 0, running: false, failed: false };
  const r = await send<SecurityReport>({ type: "securityReport" });
  if (st.route.kind !== "report") return;
  if (!r.ok) return ((st.error = r.error), ctx.rerender());
  st.report.data = r.data;
  ctx.rerender();
}

/** Asks HIBP for each prefix (a few at a time) and lets the worker match the answers against its own hashes. */
export async function checkExposed(ctx: Ctx) {
  const rep = st.report;
  const prefixes = [...(rep?.data?.prefixes ?? [])];
  if (!rep || rep.running) return;
  Object.assign(rep, { running: true, failed: false, done: 0, exposed: new Map<string, number>() });
  ctx.rerender();
  const worker = async () => {
    for (let p = prefixes.pop(); p !== undefined && !rep.failed; p = prefixes.pop()) {
      try {
        const body = await fetchRange(p);
        const r = await send<{ id: string; count: number }[]>({ type: "exposedRange", prefix: p, body });
        if (!r.ok) throw new Error(r.error);
        for (const x of r.data) rep.exposed!.set(x.id, x.count);
      } catch {
        rep.failed = true;
      }
      rep.done++;
      if (st.route.kind === "report") ctx.rerender();
    }
  };
  await Promise.all(Array.from({ length: REPORT_PARALLEL }, worker));
  rep.running = false;
  if (st.route.kind === "report") ctx.rerender();
}

/** Login usernames that are e-mail addresses. */
export const loginEmails = () => [...new Set((st.list?.items ?? []).filter((i) => i.type === 1 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(i.sub)).map((i) => i.sub))];

export async function checkEmails(ctx: Ctx) {
  const rep = st.report;
  if (!rep || rep.emailsRunning) return;
  rep.emailsRunning = true;
  ctx.rerender();
  const r = await send<BreachResults>({ type: "breachEmails", emails: loginEmails() });
  rep.emailsRunning = false;
  if (!r.ok) st.error = r.error;
  else rep.emails = r.data;
  if (st.route.kind === "report") ctx.rerender();
}

export function reportView(ctx: Ctx): HTMLElement {
  const rep = st.report;
  const byId = new Map((st.list?.items ?? []).map((i) => [i.id, i]));
  const rows = (ids: string[]) => ids.map((id) => byId.get(id)).filter((i): i is VaultItem => !!i);
  const block = (title: string, ids: string[]): Child[] => {
    const items = rows(ids);
    return items.length ? [sectionTitle(`${title} (${items.length})`), h("div", { class: "group", role: "list" }, ...sortItems(items).map((i) => itemRow(ctx, i)))] : [];
  };
  const d = rep?.data;
  const total = d?.prefixes.length ?? 0;
  const exposedIds = [...(rep?.exposed?.keys() ?? [])];
  const clean = !!d && !rows(d.reused).length && !rows(d.weak).length && !rows(d.insecure).length && !rows(d.noTotp).length;
  return h(
    "div",
    { class: "page" },
    topBar(iconButton("back", t("back"), () => open(ctx, { kind: "list" })), h("h1", {}, t("securityReport"))),
    errorBox(),
    !d ? progress() : null,
    d && clean && !exposedIds.length && !rep?.exposed ? h("div", { class: "empty" }, icon("shield"), h("p", { class: "title" }, t("reportClean")), h("p", { class: "caption" }, t("reportCleanHint"))) : null,
    ...(d ? [...block(t("reportReused"), d.reused), ...block(t("reportWeak"), d.weak), ...block(t("reportInsecure"), d.insecure), ...block(t("reportNoTotp"), d.noTotp)] : []),
    d && total
      ? h(
          "div",
          { class: "group" },
          h("button", { type: "button", class: "row", disabled: rep!.running, onclick: () => void checkExposed(ctx) }, icon("shield"), h("div", { class: "body" }, h("span", { class: "title" }, rep!.running ? t("reportChecking", String(rep!.done), String(total)) : t("reportCheckExposed")))),
        )
      : null,
    d && total ? h("p", { class: "caption" }, t("reportExposedNote")) : null,
    rep?.failed ? h("div", { class: "notice warn" }, icon("error"), h("div", {}, t("reportFailed"))) : null,
    d && loginEmails().length
      ? h("div", { class: "group" }, h("button", { type: "button", class: "row", disabled: rep!.emailsRunning, onclick: () => void checkEmails(ctx) }, icon("mail"), h("div", { class: "body" }, h("span", { class: "title" }, t("reportCheckEmails")))))
      : null,
    d && loginEmails().length ? h("p", { class: "caption" }, t("reportEmailsNote")) : null,
    rep?.emails?.unconfigured ? h("div", { class: "notice" }, icon("error"), h("div", {}, t("reportEmailsUnconfigured"))) : null,
    rep?.emails?.stopped ? h("div", { class: "notice warn" }, icon("error"), h("div", {}, t("reportEmailsStopped"))) : null,
    ...(rep?.emails && !rep.emails.unconfigured
      ? rep.emails.results.length
        ? [sectionTitle(`${t("reportEmailsFound")} (${rep.emails.results.length})`), h("div", { class: "group" }, ...rep.emails.results.map((x) => h("div", { class: "row" }, icon("mail"), h("div", { class: "body" }, h("span", { class: "title" }, x.email), h("span", { class: "sub" }, x.names.join(", "))))))]
        : rep.emails.stopped ? [] : [h("p", { class: "caption" }, t("reportEmailsNone"))]
      : []),
    ...(rep?.exposed && !rep.running ? (exposedIds.length ? block(t("reportExposed"), exposedIds) : rep.failed ? [] : [h("p", { class: "caption" }, t("reportExposedNone"))]) : []),
  );
}

export function foldersView(ctx: Ctx): HTMLElement {
  const names = new Map((st.list?.folders ?? []).map((f) => [f.id, f.name]));
  const fresh = { name: "" };
  // One compact row per folder: the name edits in place, the actions sit next to it.
  const folderRow = (id: string) =>
    h(
      "div",
      { class: "row" },
      icon("folder"),
      h("input", { class: "row-input", value: names.get(id) ?? "", "aria-label": t("folderName"), spellcheck: false, oninput: (e: Event) => names.set(id, (e.target as HTMLInputElement).value) }),
      h(
        "span",
        { class: "field-actions" },
        iconButton("edit", t("rename"), () => void vaultAction(ctx, { type: "saveFolder", id, name: names.get(id) ?? "" }, "saved", false), { class: "icon-btn sm" }),
        // Two clicks, like the other deletes that cannot be undone: the folder and every item's place in it go.
        st.confirmDelete && st.armed === `folder:${id}`
          ? iconButton("trash", t("tapAgainToDelete"), (e) => twoTap(ctx, () => leave(rowOf(e), () => void vaultAction(ctx, { type: "deleteFolder", id }, "deleted", false)), `folder:${id}`), { class: "icon-btn sm danger" })
          : iconButton("trash", t("deleteFolder"), () => twoTap(ctx, () => {}, `folder:${id}`), { class: "icon-btn sm delete" }),
      ),
    );
  return h(
    "div",
    { class: "page" },
    topBar(iconButton("back", t("back"), () => open(ctx, { kind: "list" })), h("h1", {}, t("folders"))),
    errorBox(),
    h(
      "div",
      { class: "group" },
      ...(st.list?.folders ?? []).map((f) => folderRow(f.id)),
      h(
        "form",
        {
          class: "row",
          onsubmit: (e: Event) => {
            e.preventDefault();
            if (fresh.name.trim()) void vaultAction(ctx, { type: "saveFolder", name: fresh.name.trim() }, "saved", false);
          },
        },
        icon("plus"),
        h("input", { class: "row-input", placeholder: t("newFolder"), "aria-label": t("newFolder"), oninput: (e: Event) => (fresh.name = (e.target as HTMLInputElement).value) }),
        h("button", { type: "submit", class: "btn tonal small" }, t("add")),
      ),
    ),
  );
}
