// Settings → Emergency access: trusted contacts (this account as grantor) and accounts that trust this one (grantee),
// with a read-only view of a grantor's vault and a takeover. The worker does every key operation (background/emergency.ts).
import type { VaultItem } from "../shared/messages.ts";
import type { Grant } from "../transport/emergency.ts";
import { type Child, day, h, plural, send, t } from "./dom.ts";
import { icon } from "./icons.ts";
import { copyButton, type Ctx, iconButton, section, spacer, topBar } from "./vault-shared.ts";

type Json = Record<string, unknown>;
const WAIT_DAYS = [1, 2, 3, 4, 5, 6, 7, 14, 30, 90];

interface State {
  list?: { trusted: Grant[]; granted: Grant[] };
  busy?: boolean;
  error?: string;
  inviting?: boolean;
  email: string;
  kind: 0 | 1;
  wait: number;
  confirm?: { id: string; email: string; phrase: string };
  view?: { id: string; email: string; items: VaultItem[]; item?: Json };
  takeover?: { id: string; email: string; password: string; done?: boolean };
}

let em: State | undefined;
export const emergencyOpen = (): boolean => !!em;
export const closeEmergency = () => void (em = undefined);

export function openEmergency(ctx: Pick<Ctx, "rerender">) {
  em = { email: "", kind: 0, wait: 7 };
  void run(ctx, async () => void (em!.list = await call<{ trusted: Grant[]; granted: Grant[] }>({ type: "emergencyList" })));
}

async function call<T>(req: Parameters<typeof send>[0]): Promise<T> {
  const r = await send<T>(req);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

/** One action at a time; the list reloads after any change. */
async function run(ctx: Pick<Ctx, "rerender">, fn: () => Promise<void>, reload = false) {
  if (!em || em.busy) return;
  Object.assign(em, { busy: true, error: undefined });
  ctx.rerender();
  try {
    await fn();
    if (reload && em) em.list = await call({ type: "emergencyList" });
  } catch (e) {
    if (em) em.error = (e as Error).message;
  }
  if (em) em.busy = false;
  ctx.rerender();
}

const statusLabel = (g: Grant) => t(`emStatus${g.status}`);
const kindLabel = (k: number) => t(k === 1 ? "emKindTakeover" : "emKindView");
const action = (ctx: Ctx, id: string, a: "reinvite" | "initiate" | "approve" | "reject" | "delete") => () => void run(ctx, () => call({ type: "emergencyAction", id, action: a }), true);
const btn = (label: string, onclick: () => void, cls = "btn text small") => h("button", { type: "button", class: cls, disabled: em?.busy, onclick }, label);

function trustedRow(ctx: Ctx, g: Grant): HTMLElement {
  const actions: Child[] = [];
  if (g.status === 0) actions.push(btn(t("emReinvite"), action(ctx, g.id, "reinvite")));
  if (g.status === 1)
    actions.push(
      btn(t("emConfirm"), () =>
        void run(ctx, async () => void (em!.confirm = { id: g.id, email: g.email ?? "", phrase: await call<string>({ type: "emergencyFingerprint", id: g.id }) })),
      ),
    );
  if (g.status === 3) actions.push(btn(t("emApprove"), action(ctx, g.id, "approve")), btn(t("emReject"), action(ctx, g.id, "reject")));
  if (g.status === 4) actions.push(btn(t("emReject"), action(ctx, g.id, "reject")));
  actions.push(iconButton("trash", t("deleteNamed", g.email ?? ""), action(ctx, g.id, "delete"), { class: "icon-btn sm", disabled: em?.busy }));
  return h(
    "div",
    { class: "row" },
    icon("user"),
    h("div", { class: "body" }, h("span", { class: "title ellipsis" }, g.email || g.name || "--"), h("span", { class: "sub wrap" }, `${kindLabel(g.type)} · ${plural("days", g.waitTimeDays)} · ${statusLabel(g)}`)),
    h("span", { class: "trailing" }, ...actions),
  );
}

function grantedRow(ctx: Ctx, g: Grant): HTMLElement {
  const actions: Child[] = [];
  if (g.status === 2) actions.push(btn(t("emRequest"), action(ctx, g.id, "initiate")));
  if (g.status === 4 && g.type === 0)
    actions.push(btn(t("emView"), () => void run(ctx, async () => void (em!.view = { id: g.id, email: g.email ?? "", items: await call<VaultItem[]>({ type: "emergencyView", id: g.id }) }))));
  if (g.status === 4 && g.type === 1) actions.push(btn(t("emTakeover"), () => ((em!.takeover = { id: g.id, email: g.email ?? "", password: "" }), ctx.rerender())));
  const waiting = g.status === 3 && g.recoveryInitiatedDate ? ` · ${t("emWaitsUntil", day(Date.parse(g.recoveryInitiatedDate) + g.waitTimeDays * 86_400_000))}` : "";
  return h(
    "div",
    { class: "row" },
    icon("shield"),
    h("div", { class: "body" }, h("span", { class: "title ellipsis" }, g.email || g.name || "--"), h("span", { class: "sub wrap" }, `${kindLabel(g.type)} · ${statusLabel(g)}${waiting}`)),
    actions.length ? h("span", { class: "trailing" }, ...actions) : null,
  );
}

function inviteForm(ctx: Ctx): HTMLElement {
  const s = em!;
  return h(
    "form",
    {
      class: "row stack",
      onsubmit: (e: Event) => {
        e.preventDefault();
        void run(ctx, async () => {
          await call({ type: "emergencyInvite", email: s.email, kind: s.kind, waitDays: s.wait });
          Object.assign(s, { inviting: false, email: "" });
        }, true);
      },
    },
    h("input", { type: "email", required: true, "data-autofocus": "1", "aria-label": t("email"), placeholder: t("email"), value: s.email, oninput: (e: Event) => (s.email = (e.target as HTMLInputElement).value) }),
    h(
      "select",
      { "aria-label": t("emAccess"), onchange: (e: Event) => (s.kind = Number((e.target as HTMLSelectElement).value) as 0 | 1) },
      ...[0, 1].map((k) => h("option", { value: String(k), selected: s.kind === k }, kindLabel(k))),
    ),
    h(
      "select",
      { "aria-label": t("emWait"), onchange: (e: Event) => (s.wait = Number((e.target as HTMLSelectElement).value)) },
      ...WAIT_DAYS.map((d) => h("option", { value: String(d), selected: s.wait === d }, plural("days", d))),
    ),
    h("p", { class: "caption" }, t(s.kind === 1 ? "emKindTakeoverHint" : "emKindViewHint")),
    h("button", { type: "submit", class: "btn tonal small", disabled: s.busy }, t("emInvite")),
  );
}

function confirmView(ctx: Ctx): HTMLElement {
  const c = em!.confirm!;
  return h(
    "div",
    { class: "page" },
    topBar(iconButton("back", t("back"), () => ((em!.confirm = undefined), ctx.rerender())), h("h1", { class: "grow" }, t("emConfirm"))),
    em!.error ? h("div", { class: "error", role: "alert" }, icon("error"), h("div", {}, em!.error)) : null,
    h("p", {}, t("emConfirmHint", c.email)),
    h("div", { class: "field" }, h("label", {}, h("span", {}, t("fingerprintPhrase")), h("output", { class: "phrase" }, c.phrase))),
    h(
      "div",
      { class: "actions" },
      btn(t("cancel"), () => ((em!.confirm = undefined), ctx.rerender())),
      btn(
        t("emConfirm"),
        () =>
          void run(ctx, async () => {
            await call({ type: "emergencyConfirm", id: c.id, fingerprint: c.phrase });
            em!.confirm = undefined;
          }, true),
        "btn tonal small",
      ),
    ),
  );
}

/** A grantor's item, read only: its name, the login, card or note fields that hold text, and notes. */
function itemView(ctx: Ctx, item: Json): HTMLElement {
  const back = () => ((em!.view!.item = undefined), ctx.rerender());
  const obj = (k: string) => (item[k] && typeof item[k] === "object" ? (item[k] as Json) : {});
  const rows: Child[] = [];
  for (const k of ["login", "card", "identity", "sshKey", "bankAccount", "driversLicense", "passport"])
    for (const [key, v] of Object.entries(obj(k)))
      // Only fields with a label: internal values (passwordRevisionDate, ...) stay out.
      if (typeof v === "string" && v && t(`field_${key}`) !== `field_${key}`) rows.push(h("div", { class: "row field-row" }, h("div", { class: "body" }, h("span", { class: "label" }, t(`field_${key}`)), h("span", { class: "value" }, v)), copyButton(ctx, `em.${key}`, v, t("copyField", t(`field_${key}`)))));
  for (const u of Array.isArray(obj("login").uris) ? (obj("login").uris as Json[]) : []) if (typeof u.uri === "string") rows.push(h("div", { class: "row" }, icon("globe"), h("div", { class: "body" }, h("span", { class: "value" }, u.uri))));
  for (const f of Array.isArray(item.fields) ? (item.fields as Json[]) : []) if (typeof f.value === "string" && f.value) rows.push(h("div", { class: "row field-row" }, h("div", { class: "body" }, h("span", { class: "label" }, String(f.name ?? "")), h("span", { class: "value" }, f.value)), copyButton(ctx, `em.f.${String(f.name)}`, f.value, t("copyField", String(f.name ?? "")))));
  return h(
    "div",
    { class: "page" },
    topBar(iconButton("back", t("back"), back), h("h1", { class: "grow ellipsis" }, String(item.name ?? "")), spacer()),
    rows.length ? h("div", { class: "group" }, ...rows) : null,
    typeof item.notes === "string" && item.notes ? h("div", { class: "notes" }, item.notes) : null,
  );
}

function vaultView(ctx: Ctx): HTMLElement {
  const v = em!.view!;
  if (v.item) return itemView(ctx, v.item);
  return h(
    "div",
    { class: "page" },
    topBar(iconButton("back", t("back"), () => ((em!.view = undefined), ctx.rerender())), h("h1", { class: "grow ellipsis" }, t("emVaultOf", v.email))),
    em!.error ? h("div", { class: "error", role: "alert" }, icon("error"), h("div", {}, em!.error)) : null,
    h("p", { class: "caption" }, t("emViewHint")),
    h(
      "div",
      { class: "group" },
      ...v.items.map((i) =>
        h(
          "button",
          { type: "button", class: "row", onclick: () => void run(ctx, async () => void (v.item = await call<Json>({ type: "emergencyItem", id: v.id, itemId: i.id }))) },
          h("div", { class: "body" }, h("span", { class: "title ellipsis" }, i.name || t("untitled")), h("span", { class: "sub" }, i.sub)),
        ),
      ),
    ),
  );
}

function takeoverView(ctx: Ctx): HTMLElement {
  const o = em!.takeover!;
  return h(
    "div",
    { class: "page" },
    topBar(iconButton("back", t("back"), () => ((em!.takeover = undefined), ctx.rerender())), h("h1", { class: "grow" }, t("emTakeover"))),
    em!.error ? h("div", { class: "error", role: "alert" }, icon("error"), h("div", {}, em!.error)) : null,
    o.done
      ? h("div", { class: "notice", role: "status" }, icon("check"), h("div", {}, t("emTakeoverDone", o.email)))
      : h(
          "form",
          {
            class: "stack",
            onsubmit: (e: Event) => {
              e.preventDefault();
              const password = o.password;
              o.password = "";
              void run(ctx, async () => {
                await call({ type: "emergencyTakeover", id: o.id, password });
                o.done = true;
              });
            },
          },
          h("p", {}, t("emTakeoverHint", o.email)),
          h("input", { type: "password", autocomplete: "new-password", required: true, minlength: 12, "data-autofocus": "1", "aria-label": t("emNewPassword"), placeholder: t("emNewPassword"), oninput: (e: Event) => (o.password = (e.target as HTMLInputElement).value) }),
          h("button", { type: "submit", class: "btn tonal small", disabled: em!.busy }, t("emTakeover")),
        ),
  );
}

export function emergencyScreen(ctx: Ctx): HTMLElement {
  const s = em!;
  if (s.confirm) return confirmView(ctx);
  if (s.view) return vaultView(ctx);
  if (s.takeover) return takeoverView(ctx);
  return h(
    "div",
    { class: "page" },
    topBar(iconButton("back", t("back"), () => ((em = undefined), ctx.rerender())), h("h1", { class: "grow" }, t("emergencyAccess"))),
    s.error ? h("div", { class: "error", role: "alert" }, icon("error"), h("div", {}, s.error)) : null,
    h("p", { class: "caption" }, t("emergencyAccessHint")),
    ...section(
      t("emTrusted"),
      ...(s.list?.trusted ?? []).map((g) => trustedRow(ctx, g)),
      s.inviting ? inviteForm(ctx) : h("button", { type: "button", class: "row", onclick: () => ((s.inviting = true), ctx.rerender()) }, icon("plus"), h("div", { class: "body" }, h("span", { class: "title" }, t("emAdd")))),
    ),
    ...section(t("emGranted"), ...(s.list?.granted ?? []).map((g) => grantedRow(ctx, g))),
    s.list && !s.list.granted.length ? h("p", { class: "caption" }, t("emGrantedNone")) : null,
  );
}
