// Item view: the per-type field schema, reveal/copy, TOTP, attachments, reprompt, history.
import { cardBrand, groupCardNumber } from "../shared/card.ts";
import { linkedKey } from "../shared/linked-fields.ts";
import { hasMarkup } from "../shared/markdown.ts";
import { MAX_QR_BYTES } from "../shared/qr.ts";
import { passwordLevel } from "../shared/strength.ts";
import { isInsecureUri, mainPage, toHttps } from "../shared/uri-tools.ts";
import type { VaultList } from "../shared/messages.ts";
import { type Child, h, plural, send, t, when } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { renderMarkdown } from "./markdown.ts";
import { pwnedCount } from "./pwned.ts";
import { qrSvg } from "./qr.ts";
import { type Json, type Ctx, st, timers, TOTP_SOON, REPROMPT_CHECK_MS, stopRepromptWatch, str, obj, webUrl, tile, toast, copy, iconButton, copyButton, errorBox, topBar, spacer, sectionTitle, progress, type MenuItem, menu, copyOnClick, refreshPageMatches, open, colorize, section } from "./vault-shared.ts";
import { TYPE_LABEL, fill } from "./vault-list.ts";
import { startEdit, uriMatchLabel } from "./vault-edit.ts";
import { writableCollections, writableOrgs } from "./vault-tools.ts";

// ---------- item types ----------

export interface Spec {
  key: string;
  icon: IconName;
  secret?: boolean;
  mono?: boolean;
  options?: string[];
  area?: boolean;
}

export const BRANDS = ["Visa", "Mastercard", "Amex", "Discover", "Diners Club", "JCB", "Maestro", "UnionPay", "RuPay", "Other"];
/** Type-specific fields per cipher type, in display order (labels: `field_<key>` in messages.json). */
export const SCHEMA: Record<number, { obj: string; fields: Spec[] }> = {
  1: {
    obj: "login",
    fields: [
      { key: "username", icon: "user" },
      { key: "password", icon: "key", secret: true, mono: true },
      { key: "totp", icon: "timer", secret: true, mono: true },
    ],
  },
  3: {
    obj: "card",
    fields: [
      { key: "cardholderName", icon: "user" },
      { key: "brand", icon: "card", options: BRANDS },
      { key: "number", icon: "card", secret: true, mono: true },
      { key: "expMonth", icon: "calendar", options: Array.from({ length: 12 }, (_, i) => String(i + 1)) },
      { key: "expYear", icon: "calendar" },
      { key: "code", icon: "key", secret: true, mono: true },
    ],
  },
  4: {
    obj: "identity",
    fields: [
      { key: "title", icon: "user", options: ["Mr", "Mrs", "Ms", "Mx", "Dr"] },
      { key: "firstName", icon: "user" },
      { key: "middleName", icon: "user" },
      { key: "lastName", icon: "user" },
      { key: "username", icon: "user" },
      { key: "company", icon: "home" },
      { key: "email", icon: "mail" },
      { key: "phone", icon: "phone" },
      { key: "ssn", icon: "key", secret: true },
      { key: "passportNumber", icon: "key", secret: true },
      { key: "licenseNumber", icon: "key", secret: true },
      { key: "address1", icon: "home" },
      { key: "address2", icon: "home" },
      { key: "address3", icon: "home" },
      { key: "city", icon: "home" },
      { key: "state", icon: "home" },
      { key: "postalCode", icon: "home" },
      { key: "country", icon: "globe" },
    ],
  },
  6: {
    obj: "bankAccount",
    fields: [
      { key: "bankName", icon: "landmark" },
      { key: "nameOnAccount", icon: "user" },
      { key: "accountType", icon: "landmark" },
      { key: "accountNumber", icon: "key", secret: true, mono: true },
      { key: "routingNumber", icon: "key", mono: true },
      { key: "branchNumber", icon: "key", mono: true },
      { key: "pin", icon: "key", secret: true, mono: true },
      { key: "swiftCode", icon: "key", mono: true },
      { key: "iban", icon: "key", secret: true, mono: true },
      { key: "bankContactPhone", icon: "phone" },
    ],
  },
  7: {
    obj: "driversLicense",
    fields: [
      { key: "firstName", icon: "user" },
      { key: "middleName", icon: "user" },
      { key: "lastName", icon: "user" },
      { key: "dateOfBirth", icon: "calendar" },
      { key: "licenseNumber", icon: "key", secret: true, mono: true },
      { key: "issuingCountry", icon: "globe" },
      { key: "issuingState", icon: "globe" },
      { key: "issueDate", icon: "calendar" },
      { key: "expirationDate", icon: "calendar" },
      { key: "issuingAuthority", icon: "home" },
      { key: "licenseClass", icon: "card" },
    ],
  },
  8: {
    obj: "passport",
    fields: [
      { key: "givenName", icon: "user" },
      { key: "surname", icon: "user" },
      { key: "dateOfBirth", icon: "calendar" },
      { key: "sex", icon: "user" },
      { key: "birthPlace", icon: "globe" },
      { key: "nationality", icon: "globe" },
      { key: "passportNumber", icon: "key", secret: true, mono: true },
      { key: "passportType", icon: "card" },
      { key: "nationalIdentificationNumber", icon: "key", secret: true, mono: true },
      { key: "issuingCountry", icon: "globe" },
      { key: "issuingAuthority", icon: "home" },
      { key: "issueDate", icon: "calendar" },
      { key: "expirationDate", icon: "calendar" },
    ],
  },
  5: {
    obj: "sshKey",
    fields: [
      { key: "privateKey", icon: "key", secret: true, mono: true, area: true },
      { key: "publicKey", icon: "key", mono: true },
      { key: "keyFingerprint", icon: "key", mono: true },
    ],
  },
};
export const label = (key: string) => t(`field_${key}`);

export function strength(pw: string): { label: string; level: number } {
  const level = passwordLevel(pw);
  return { level, label: t(["strengthWeak", "strengthFair", "strengthStrong", "strengthVeryStrong"][level]!) };
}

// ---------- item view ----------

/**
 * Master-password re-prompt, for items the user flagged in the web vault (`reprompt`). The worker
 * enforces it too: this screen only asks for the password that lifts the gate.
 */
export function repromptView(ctx: Ctx, id: string): HTMLElement {
  const input = h("input", { id: "reprompt-password", type: "password", autocomplete: "current-password", required: true, "data-autofocus": "1", spellcheck: false });
  const onsubmit = async (e: Event) => {
    e.preventDefault();
    const password = input.value;
    input.value = "";
    st.busy = true;
    st.error = undefined;
    ctx.rerender();
    const r = await send({ type: "confirmReprompt", id, password });
    st.busy = false;
    if (!r.ok) st.error = r.error;
    else {
      st.repromptFor = undefined;
      st.item = undefined; // refetched with the gate lifted
    }
    ctx.rerender();
  };
  return h(
    "form",
    { class: "page center", onsubmit },
    topBar(iconButton("back", t("back"), () => open(ctx, { kind: "list" }))),
    h("div", { class: "brand" }, h("div", { class: "logo" }, icon("lock")), h("h1", {}, t("repromptTitle")), h("p", {}, t("repromptHint"))),
    h("div", { class: "field" }, h("label", { for: "reprompt-password" }, h("span", {}, t("masterPassword")), input)),
    errorBox(),
    st.busy ? progress() : null,
    h("div", { class: "actions" }, h("button", { type: "submit", class: "btn filled wide", disabled: st.busy }, t("repromptConfirm"))),
  );
}

export function fieldRow(
  ctx: Ctx,
  key: string,
  ic: IconName,
  title: string,
  value: string,
  opts: { secret?: boolean; mono?: boolean; extra?: Child; copyValue?: string; menu?: MenuItem[]; display?: string } = {},
): HTMLElement {
  const shown = !opts.secret || st.reveal.has(key);
  const valueEl = h("span", { class: `value${opts.mono ? " mono" : ""}` });
  if (shown) {
    if (opts.mono && opts.secret) valueEl.append(...colorize(opts.display ?? value));
    else valueEl.textContent = opts.display ?? value;
  } else {
    valueEl.textContent = "•".repeat(Math.min(Math.max(value.length, 8), 16));
  }
  return h(
    "div",
    { class: `row field-row${opts.secret ? " elevated" : ""}` },
    icon(ic),
    h("div", copyOnClick(ctx, key, () => opts.copyValue ?? value, title), h("span", { class: "label" }, title), valueEl, opts.extra),
    h(
      "span",
      { class: "field-actions" },
      opts.secret
        ? iconButton(shown ? "eyeOff" : "eye", t(shown ? "hidePassword" : "showPassword"), () => {
            if (shown) st.reveal.delete(key);
            else st.reveal.add(key);
            ctx.rerender();
          })
        : null,
      copyButton(ctx, key, opts.copyValue ?? value, t("copyField", title)),
      moreButton(ctx, value, opts.menu),
    ),
  );
}

/** "⋮" for a value: Large Type, share as a Send, plus whatever the row adds. */
export function moreButton(ctx: Ctx, value: string, extra: MenuItem[] = []): HTMLElement {
  const items: MenuItem[] = [
    ...extra,
    { label: t("largeType"), icon: "search", onClick: () => ((st.large = value), ctx.rerender()) },
    ...(new TextEncoder().encode(value).length <= MAX_QR_BYTES ? [{ label: t("showQr"), icon: "qr" as const, onClick: () => ((st.qr = { text: value }), ctx.rerender()) }] : []),
    { label: t("shareAsSend"), icon: "send", onClick: () => ctx.shareAsSend(value) },
  ];
  const b: HTMLElement = iconButton("more", t("moreActions"), () => menu(b, t("moreActions"), items), { "aria-haspopup": "menu" });
  return b;
}

export function qrView(ctx: Ctx): HTMLElement {
  const { text, note } = st.qr!;
  return h(
    "div",
    { class: "page" },
    topBar(iconButton("back", t("back"), () => ((st.qr = undefined), ctx.rerender())), h("h1", { class: "grow" }, t("qrCode"))),
    h("div", { class: "qr-box" }, qrSvg(text, t("qrCode"))),
    note ? h("p", { class: "caption center" }, note) : null,
  );
}

/** The authenticator key as an otpauth:// URI, which is what authenticator apps scan. */
export function otpauthUri(secret: string, name: string): string {
  return secret.includes("://") ? secret : `otpauth://totp/${encodeURIComponent(name)}?secret=${encodeURIComponent(secret.replace(/\s+/g, ""))}`;
}

/** Every character on its own tile with its position, so look-alikes (O/0, l/1) can be told apart. */
export function largeTypeView(ctx: Ctx): HTMLElement {
  const text = st.large!;
  return h(
    "div",
    { class: "page" },
    topBar(iconButton("back", t("back"), () => ((st.large = undefined), ctx.rerender())), h("h1", { class: "grow" }, t("largeType"))),
    h(
      "div",
      { class: "large mono", role: "img", "aria-label": text },
      ...[...text].map((c, i) => h("span", { class: `ch${/\d/.test(c) ? " d" : /[^\p{L}\s]/u.test(c) ? " s" : ""}` }, c === " " ? "␣" : c, h("small", {}, String(i + 1)))),
    ),
  );
}

export const RING_CIRCUMFERENCE = 2 * Math.PI * 9;

/** A countdown ring for the one-time code. */
export function ring(fraction: number): SVGSVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "ring");
  svg.setAttribute("aria-hidden", "true");
  const track = document.createElementNS(NS, "circle");
  track.setAttribute("cx", "12");
  track.setAttribute("cy", "12");
  track.setAttribute("r", "9");
  track.setAttribute("class", "ring-track");
  const bar = document.createElementNS(NS, "circle");
  bar.setAttribute("cx", "12");
  bar.setAttribute("cy", "12");
  bar.setAttribute("r", "9");
  bar.setAttribute("class", "ring-bar");
  bar.setAttribute("transform", "rotate(-90 12 12)");
  bar.style.strokeDasharray = String(RING_CIRCUMFERENCE);
  bar.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - fraction));
  svg.append(track, bar);
  return svg;
}

export function totpRow(ctx: Ctx, id: string, secret: string, name: string): HTMLElement {
  if (st.totpFailed === id)
    return h("div", { class: "row" }, icon("timer"), h("div", { class: "body" }, h("span", { class: "label" }, t("oneTimeCode")), h("span", { class: "value" }, t("totpInvalid"))));
  if (!st.totp) {
    void refreshTotp(ctx, id);
    return h("div", { class: "row" }, icon("timer"), h("div", { class: "body" }, h("span", { class: "label" }, t("oneTimeCode")), h("span", { class: "value" }, "…")));
  }
  const { code, next, remaining, period } = st.totp;
  const pretty = (c: string) => (c.length === 6 ? `${c.slice(0, 3)} ${c.slice(3)}` : c);
  return h(
    "div",
    { class: `row field-row totp-row elevated${remaining <= TOTP_SOON ? " soon" : ""}` },
    icon("timer"),
    h(
      "div",
      copyOnClick(ctx, "totp", () => st.totp?.code ?? code, t("oneTimeCode")),
      h("span", { class: "label" }, t("oneTimeCode")),
      h("span", { class: "value mono totp", "data-totp": "1" }, pretty(code)),
      next ? h("span", { class: "totp-next" }, t("nextCode"), " ", h("span", { class: "mono" }, pretty(next))) : null,
    ),
    h(
      "span",
      { class: "field-actions" },
      h(
        "span",
        { class: "totp-ring", "data-remaining": String(remaining), role: "img", "aria-label": plural("secondsLeft", remaining) },
        ring(remaining / Math.max(period, 1)),
        h("span", { class: "totp-seconds", "aria-hidden": "true" }, String(remaining)),
      ),
      copyButton(ctx, "totp", code, t("copyField", t("oneTimeCode"))),
      moreButton(ctx, code, [
        ...(next ? [{ label: t("copyNextCode"), icon: "copy" as const, onClick: () => void copy(ctx, next) }] : []),
        { label: t("copyAuthKey"), icon: "copy", onClick: () => void copy(ctx, secret) },
        { label: t("showAuthQr"), icon: "qr", onClick: () => ((st.qr = { text: otpauthUri(secret, name), note: t("authQrNote") }), ctx.rerender()) },
      ]),
    ),
  );
}

/** The re-prompt grant ran out: hide the item again until the password is re-entered. */
export function hideForReprompt(ctx: Ctx, id: string) {
  clearInterval(timers.totp);
  stopRepromptWatch();
  // The large-type and QR overlays may show this item's password or TOTP key.
  Object.assign(st, { item: undefined, totp: undefined, large: undefined, qr: undefined, reveal: new Set(), copied: "", repromptFor: id });
  ctx.rerender();
}

export async function refreshTotp(ctx: Ctx, id: string) {
  const r = await send<{ code: string; next: string; period: number; remaining: number }>({ type: "totp", id });
  if (st.route.kind !== "item" || st.route.id !== id) return;
  if (!r.ok) {
    if (r.code === "reprompt") return hideForReprompt(ctx, id);
    st.totpFailed = id;
    return ctx.rerender();
  }
  st.totp = { code: r.data.code, next: r.data.next, period: r.data.period || 30, remaining: r.data.remaining };
  ctx.rerender();
  clearInterval(timers.totp);
  timers.totp = setInterval(() => {
    if (!st.totp) return;
    st.totp.remaining -= 1;
    if (st.totp.remaining <= 0) {
      clearInterval(timers.totp);
      void refreshTotp(ctx, id);
      return;
    }
    // Tick the ring and the counter without re-rendering the whole screen.
    const pill = document.querySelector<HTMLElement>("[data-remaining]");
    if (!pill) return;
    pill.setAttribute("aria-label", plural("secondsLeft", st.totp.remaining));
    pill.setAttribute("data-remaining", String(st.totp.remaining));
    pill.closest(".totp-row")?.classList.toggle("soon", st.totp.remaining <= TOTP_SOON);
    const seconds = pill.querySelector<HTMLElement>(".totp-seconds");
    if (seconds) seconds.textContent = String(st.totp.remaining);
    const bar = pill.querySelector<SVGCircleElement>(".ring-bar");
    if (bar) bar.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - st.totp.remaining / st.totp.period));
  }, 1000);
}

export const actionRow = (ic: IconName, title: string, onclick: () => void, danger = false) =>
  h("button", { type: "button", class: `row${danger ? " danger" : ""}`, disabled: st.busy, onclick }, icon(ic), h("div", { class: "body" }, h("span", { class: "title" }, title)));

export async function vaultAction(ctx: Ctx, req: Parameters<typeof send>[0], done: string, back = true, undo?: () => void) {
  st.busy = true;
  ctx.rerender();
  const r = await send<VaultList>(req);
  st.busy = false;
  st.confirmDelete = 0;
  if (!r.ok) return ((st.error = r.error), ctx.rerender());
  st.list = r.data;
  st.item = undefined;
  await refreshPageMatches(); // e.g. a restored login of this site is back under "On this site"
  if (back) open(ctx, { kind: "list" });
  else {
    // Refetch before rendering, so the item page shows the saved item instead of flashing its loading bar.
    const route = st.route;
    if (route.kind === "item") {
      const fresh = await send<Json>({ type: "getItem", id: route.id });
      if (fresh.ok) st.item = fresh.data;
    }
    ctx.rerender();
  }
  toast(ctx, t(done), undo ? { action: { label: t("undo"), run: undo } } : {});
}

/** Arm a destructive action on the first tap, run it on the second; disarms itself after a while. */
export function twoTap(ctx: Ctx, run: () => void, key = "item") {
  if (!st.confirmDelete || st.armed !== key) {
    const at = Date.now();
    st.confirmDelete = at;
    st.armed = key;
    ctx.rerender();
    setTimeout(() => {
      if (st.confirmDelete !== at) return; // disarmed, or armed again since
      st.confirmDelete = 0;
      if (st.route.kind === "item" || st.route.kind === "folders") ctx.rerender();
    }, 4000);
    return;
  }
  st.confirmDelete = 0;
  run();
}

// Same cap as Send files (MAX_SEND_FILE_BYTES in background/vault.ts).
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export async function download(ctx: Ctx, cipherId: string, attachmentId: string) {
  const r = await send<{ fileName: string; data: string }>({ type: "downloadAttachment", cipherId, attachmentId });
  if (!r.ok) return ((st.error = r.error), ctx.rerender());
  const url = URL.createObjectURL(new Blob([Uint8Array.fromBase64(r.data.data)]));
  h("a", { href: url, download: safeFileName(r.data.fileName) }).click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** The name comes from the server: keep it a plain file name (no separators, no control characters). */
export function safeFileName(name: string): string {
  const clean = name.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, "_").trim().slice(0, 100);
  return clean || "attachment";
}

export async function upload(ctx: Ctx, cipherId: string, file: File | undefined) {
  if (!file) return;
  if (file.size > MAX_ATTACHMENT_BYTES) return ((st.error = t("fileTooLarge")), ctx.rerender());
  const data = new Uint8Array(await file.arrayBuffer()).toBase64();
  await vaultAction(ctx, { type: "addAttachment", cipherId, file: { name: file.name, data } }, "saved", false);
}

/** Fill / open actions for the item, when a web page is open (a login for another site asks first) or the item has a site. */
export function quickActions(ctx: Ctx, id: string, uris: string[], login: boolean): Child {
  const onSite = login && !!st.page?.host;
  const url = uris.map(webUrl).find(Boolean);
  if (!onSite && !url) return null;
  return h(
    "div",
    { class: "quick" },
    onSite ? h("button", { type: "button", class: "btn tonal", onclick: () => void fill(ctx, id) }, icon("fill"), t("fillThisSite")) : null,
    url
      ? h(
          "a",
          {
            class: "btn text",
            href: url,
            target: "_blank",
            rel: "noopener noreferrer",
            onclick: (e: Event) => {
              e.preventDefault();
              void chrome.tabs.create({ url });
            },
          },
          icon("external"),
          t("openWebsite"),
        )
      : null,
  );
}

export async function checkBreach(ctx: Ctx, id: string, password: string) {
  st.pwned = { text: t("checking"), bad: false };
  ctx.rerender();
  let result: { text: string; bad: boolean };
  try {
    const n = await pwnedCount(password);
    result = n > 0 ? { text: t("pwnedFound", n.toLocaleString()), bad: true } : { text: t("pwnedClean"), bad: false };
  } catch {
    result = { text: t("pwnedFailed"), bad: false };
  }
  if (st.route.kind !== "item" || st.route.id !== id) return; // the user moved on
  st.pwned = result;
  ctx.rerender();
}

/** "Type it from memory": compared here, against the password the open item already holds. */
export function memoryForm(ctx: Ctx, password: string): HTMLElement {
  const input = h("input", { type: "password", autocomplete: "off", spellcheck: false, "aria-label": t("memoryTest"), "data-autofocus": "1" });
  const verdict = st.memory?.ok;
  return h(
    "form",
    {
      class: "field-card add",
      onsubmit: (e: Event) => {
        e.preventDefault();
        const ok = input.value === password;
        input.value = "";
        st.memory = { ok };
        ctx.rerender();
      },
    },
    h("p", { class: "caption" }, t("memoryHint")),
    h("div", { class: "field-card-bottom" }, input, h("button", { type: "submit", class: "btn tonal small" }, t("check"))),
    verdict === undefined ? null : h("div", { class: `notice ${verdict ? "info" : "warn"}` }, icon(verdict ? "check" : "error"), h("div", {}, t(verdict ? "memoryMatch" : "memoryMismatch"))),
  );
}

/** One row for a card's expiry: copies MMYY (what payment forms want), flags an expired or soon-to-expire card. */
export function expiryRow(ctx: Ctx, month: string, year: string): HTMLElement | undefined {
  const m = Number(month);
  const y = Number(year);
  if (!(m >= 1 && m <= 12) || !Number.isInteger(y) || y < 0) return undefined;
  const y4 = y < 100 ? 2000 + y : y;
  const mm = String(m).padStart(2, "0");
  const left = new Date(y4, m, 1).getTime() - Date.now(); // a card works through the end of its month
  const status = left <= 0 ? "expired" : left < 60 * 86_400_000 ? "expiringSoon" : "";
  return fieldRow(ctx, "expiry", "calendar", t("expiry"), `${mm}/${y4}`, {
    copyValue: `${mm}${String(y4).slice(-2)}`,
    menu: [
      { label: t("copyMonth"), icon: "copy", onClick: () => void copy(ctx, mm) },
      { label: t("copyYear"), icon: "copy", onClick: () => void copy(ctx, String(y4)) },
    ],
    extra: status ? h("span", { class: `badge ${status === "expired" ? "s0" : "s1"}` }, t(status)) : null,
  });
}

/** Mail, call, text and show-on-map shortcuts for an identity. Maps go to OpenStreetMap, not an ad network. */
export function identityActions(data: Json): Child {
  const email = str(data.email).trim();
  const phone = str(data.phone).replace(/[^\d+*#]/g, "");
  const address = ["address1", "address2", "address3", "city", "state", "postalCode", "country"].map((k) => str(data[k]).trim()).filter(Boolean).join(", ");
  const link = (ic: IconName, label: string, href: string) => h("a", { class: "row", href, target: "_blank", rel: "noopener noreferrer", onclick: (e: Event) => (e.preventDefault(), void chrome.tabs.create({ url: href })) }, icon(ic), h("div", { class: "body" }, h("span", { class: "title" }, label)), icon("external"));
  const rows = [
    email ? link("mail", t("sendEmail"), `mailto:${encodeURIComponent(email)}`) : null,
    phone ? link("phone", t("callPhone"), `tel:${phone}`) : null,
    phone ? link("phone", t("textPhone"), `sms:${phone}`) : null,
    address ? link("home", t("showOnMap"), `https://www.openstreetmap.org/search?query=${encodeURIComponent(address)}`) : null,
  ].filter(Boolean);
  return rows.length ? h("div", { class: "group" }, ...rows) : null;
}

/** A website row: open, copy, and a menu with the main page and the https upgrade. */
export function uriRow(ctx: Ctx, index: number, uri: string, match: number | null, onHttps: ((to: string) => void) | undefined): HTMLElement {
  const href = webUrl(uri);
  const insecure = isInsecureUri(uri);
  const front = mainPage(uri);
  const https = onHttps ? toHttps(uri) : undefined;
  const items: MenuItem[] = [];
  if (front) items.push({ label: t("openMainPage"), icon: "home", onClick: () => void chrome.tabs.create({ url: front }) });
  if (https) items.push({ label: t("switchToHttps"), icon: "shield", onClick: () => onHttps!(https) });
  // The site's own "change your password" page (W3C well-known URL); sites without one usually redirect home.
  if (href) items.push({ label: t("changePasswordPage"), icon: "key", onClick: () => void chrome.tabs.create({ url: new URL("/.well-known/change-password", href).href }) });
  const sub = [insecure ? t("insecureUri") : "", match !== null ? uriMatchLabel(match) : ""].filter(Boolean).join(", ");
  return h(
    "div",
    { class: "row" },
    icon(insecure ? "error" : "globe"),
    h("div", copyOnClick(ctx, `uri.${index}`, () => uri, uri), h("span", { class: "title ellipsis" }, uri), sub ? h("span", { class: `sub${insecure ? " warn" : ""}` }, sub) : null),
    h("span", { class: "field-actions" }, href ? iconButton("external", t("openWebsite"), () => void chrome.tabs.create({ url: href })) : null, copyButton(ctx, `uri.${index}`, uri, t("copyField", uri)), moreButton(ctx, uri, items)),
  );
}

export const NOTES_KEY = "formatNotes";
export const notesFormatted = (): boolean => {
  try {
    return localStorage.getItem(NOTES_KEY) === "1";
  } catch {
    return false;
  }
};

export function itemView(ctx: Ctx, id: string): HTMLElement {
  const item = st.item && st.item.id === id ? st.item : undefined;
  if (!item) {
    // The worker refuses to hand over a flagged item until the master password is re-entered.
    if (st.repromptFor === id) return repromptView(ctx, id);
    if (!st.itemLoading && st.itemFailedFor !== id) {
      st.itemLoading = true;
      void send<Json>({ type: "getItem", id }).then((r) => {
        st.itemLoading = false;
        if (r.ok) st.item = r.data;
        else if (r.code === "reprompt") st.repromptFor = id;
        else {
          st.error = r.error;
          st.itemFailedFor = id; // a failed fetch is shown, not retried in a loop
        }
        ctx.rerender();
      });
    }
    return h(
      "div",
      { class: "page" },
      topBar(iconButton("back", t("back"), () => open(ctx, { kind: "list" }))),
      errorBox(),
      st.error ? null : progress(),
    );
  }
  if (Number(item.reprompt) === 1 && !timers.reprompt)
    timers.reprompt = setInterval(async () => {
      const r = await send<boolean>({ type: "repromptGranted", id });
      if (r.ok && !r.data && st.route.kind === "item" && st.route.id === id) hideForReprompt(ctx, id);
    }, REPROMPT_CHECK_MS);
  const inTrash = !!item.deletedDate;
  const inArchive = !inTrash && !!item.archivedDate;
  const summary = [...(st.list?.items ?? []), ...(st.list?.archive ?? []), ...(st.list?.trash ?? [])].find((i) => i.id === id);
  const type = Number(item.type);
  const editable = !summary?.readOnly && !inTrash && type >= 1 && type <= 8;
  const schema = SCHEMA[type];
  const data = schema ? (obj(item[schema.obj]) ?? {}) : {};
  const rows: Child[] = [];
  const expiry = type === 3 ? expiryRow(ctx, str(data.expMonth), str(data.expYear)) : undefined;
  // Like the official clients: the passkey sits after the password as "Created <date>"; creationDate is not encrypted.
  const passkey = type === 1 && Array.isArray(data.fido2Credentials) ? obj(data.fido2Credentials[0]) : undefined;
  for (const f of schema?.fields ?? []) {
    const v = str(data[f.key]);
    if (passkey && f.key === "totp")
      rows.push(
        h("div", { class: "row field-row" }, icon("fingerprint"), h("div", { class: "body" }, h("span", { class: "label" }, t("passkey")), h("span", { class: "value" }, t("passkeyCreated", passkey.creationDate ? when(str(passkey.creationDate)) : "")))),
      );
    if (!v) continue;
    if (expiry && (f.key === "expMonth" || f.key === "expYear")) {
      if (f.key === "expMonth") rows.push(expiry);
      continue;
    }
    if (type === 1 && f.key === "totp") {
      rows.push(totpRow(ctx, id, v, str(item.name)));
      continue;
    }
    const s = type === 1 && f.key === "password" ? strength(v) : undefined;
    rows.push(fieldRow(ctx, f.key, f.icon, label(f.key), v, { secret: f.secret, mono: f.mono, display: type === 3 && f.key === "number" ? groupCardNumber(v) : undefined, extra: s ? h("span", { class: `badge s${s.level}` }, s.label) : null }));
  }
  const login = type === 1 ? data : undefined;
  const uriEntries = (Array.isArray(login?.uris) ? (login!.uris as Json[]) : [])
    .map((u) => ({ uri: str(u.uri), match: typeof u.match === "number" ? (u.match as number) : null }))
    .filter((u) => u.uri);
  const uris = uriEntries.map((u) => u.uri);
  const fields = Array.isArray(item.fields) ? (item.fields as Json[]) : [];
  const history = Array.isArray(item.passwordHistory) ? (item.passwordHistory as Json[]) : [];
  const folder = st.list?.folders.find((f) => f.id === item.folderId);
  const attachments = Array.isArray(item.attachments) ? (item.attachments as Json[]) : [];
  const org = st.list?.organizations?.find((o) => o.id === item.organizationId);
  const collections = (Array.isArray(item.collectionIds) ? (item.collectionIds as string[]) : []).map((c) => st.list?.collections?.find((x) => x.id === c)?.name).filter(Boolean);
  const date = (v: unknown) => (typeof v === "string" && v ? when(v) : "");
  const confirm = st.confirmDelete > 0 && st.armed === "item";
  const password = type === 1 ? str(data.password) : "";
  const reused = summary?.reused ?? 0;
  const formatted = notesFormatted();
  const notes = str(item.notes);
  const fixUri = (from: string, to: string) =>
    void vaultAction(ctx, { type: "saveItem", item: { ...item, login: { ...login, uris: (Array.isArray(login?.uris) ? (login!.uris as Json[]) : []).map((x) => (str(x.uri) === from ? { ...x, uri: to } : x)) } } }, "saved", false);

  return h(
    "div",
    {
      class: "page item-page",
      // A dropped file must never navigate the popup away; on an editable personal item it becomes an attachment.
      ondragover: (e: DragEvent) => e.preventDefault(),
      ondrop: (e: DragEvent) => {
        e.preventDefault();
        if (editable) void upload(ctx, id, e.dataTransfer?.files[0]);
      },
    },
    topBar(
      iconButton("back", t("back"), () => open(ctx, { kind: "list" })),
      spacer(),
      editable
        ? iconButton(item.favorite ? "star" : "starBorder", t(item.favorite ? "unfavorite" : "favorite"), () => void vaultAction(ctx, { type: "saveItem", item: { ...item, favorite: !item.favorite } }, "saved", false), {
            class: `icon-btn${item.favorite ? " fav" : ""}`,
            "aria-pressed": String(item.favorite === true),
          })
        : null,
      editable ? iconButton("edit", t("edit"), () => startEdit(ctx, item)) : null,
    ),
    h(
      "div",
      { class: "hero" },
      tile(str(item.name), type, uris, type === 3 ? str(data.brand) || cardBrand(str(data.number)) || "" : ""),
      h("div", { class: "body" }, h("h1", {}, str(item.name) || t("untitled")), h("span", { class: "sub" }, t(TYPE_LABEL[type] ?? "untitled"))),
    ),
    quickActions(ctx, id, uris, type === 1 && !inTrash),
    errorBox(),
    inTrash ? h("div", { class: "notice warn" }, icon("trash"), h("div", {}, t("inTrash"))) : inArchive ? h("div", { class: "notice" }, icon("archive"), h("div", {}, t("inArchive"))) : summary?.readOnly ? h("div", { class: "notice" }, icon("lock"), h("div", {}, t("readOnlyItem"))) : null,
    rows.length ? h("div", { class: "group" }, ...rows) : null,
    type === 4 ? identityActions(data) : null,
    reused
      ? h(
          "div",
          { class: "notice warn" },
          icon("error"),
          h("div", {}, plural("reusedNotice", reused)),
          h("button", { type: "button", class: "btn text small", onclick: () => ((st.folder = "reused"), open(ctx, { kind: "list" })) }, t("showReused")),
        )
      : null,
    login?.passwordRevisionDate ? h("p", { class: "caption" }, t("passwordChanged", date(login.passwordRevisionDate))) : null,
    ...section(
      t("websites"),
      ...uriEntries.map(({ uri: u, match }, i) => uriRow(ctx, i, u, match, editable ? (to) => fixUri(u, to) : undefined)),
    ),
    // Password tools come after what the user opened the item for: the credentials and where they go.
    password
      ? h("div", { class: "group" }, actionRow("shield", t("checkBreaches"), () => void checkBreach(ctx, id, password)), actionRow("memory", t("memoryTest"), () => ((st.memory = st.memory ? undefined : {}), ctx.rerender())))
      : null,
    st.pwned ? h("div", { class: `notice ${st.pwned.bad ? "warn" : "info"}` }, icon(st.pwned.bad ? "error" : "info"), h("div", {}, st.pwned.text)) : null,
    st.memory && password ? memoryForm(ctx, password) : null,
    ...section(
      t("customFields"),
      ...fields.map((f, i) =>
        Number(f.type) === 3
          ? h(
              "div",
              { class: "row" },
              icon("note"),
              // Which field it stands for, not its value: that is already on this screen, with its own protection.
              h("div", { class: "body" }, h("span", { class: "label" }, str(f.name) || t("untitled")), h("span", { class: "value" }, linkedKey(type, f.linkedId) ? `${t("fieldLinked")}: ${label(linkedKey(type, f.linkedId)!)}` : t("fieldLinked"))),
            )
          : Number(f.type) === 2
            ? h(
                editable ? "button" : "div",
                {
                  class: "row",
                  ...(editable ? { type: "button", disabled: st.busy, onclick: () => void vaultAction(ctx, { type: "saveItem", item: { ...item, fields: fields.map((x, j) => (j === i ? { ...x, value: str(x.value) === "true" ? "false" : "true" } : x)) } }, "saved", false) } : {}),
                },
                icon("note"),
                h("div", { class: "body" }, h("span", { class: "label" }, str(f.name)), h("span", { class: "value" }, t(str(f.value) === "true" ? "yes" : "no"))),
              )
            : fieldRow(ctx, `field.${i}`, "note", str(f.name) || t("untitled"), str(f.value), { secret: Number(f.type) === 1 }),
      ),
    ),
    ...(notes
      ? [
          h(
            "div",
            { class: "section-head" },
            sectionTitle(t("notes")),
            hasMarkup(notes)
              ? h("button", { type: "button", class: "chip small", "aria-pressed": String(formatted), onclick: () => (localStorage.setItem(NOTES_KEY, formatted ? "0" : "1"), ctx.rerender()) }, t("formatNotes"))
              : null,
          ),
          formatted ? renderMarkdown(notes) : h("div", { class: "notes" }, notes),
        ]
      : []),
    ...section(
      t("passwordHistory"),
      ...(st.reveal.has("history")
        ? history.map((p, i) => fieldRow(ctx, `history.${i}`, "key", date(p.lastUsedDate), str(p.password), { secret: true, mono: true }))
        : history.length
          ? [actionRow("history", plural("showPasswordHistory", history.length), () => (st.reveal.add("history"), ctx.rerender()))]
          : []),
    ),
    ...section(
      t("attachments"),
      ...attachments.map((a) =>
        h(
          "div",
          { class: "row" },
          icon("attach"),
          h("div", { class: "body" }, h("span", { class: "title ellipsis" }, str(a.fileName) || t("untitled")), h("span", { class: "sub" }, str(a.sizeName))),
          iconButton("download", t("downloadNamed", str(a.fileName)), () => void download(ctx, id, str(a.id))),
          editable && !inTrash
            ? iconButton(
                "trash",
                st.confirmDelete && st.armed === str(a.id) ? t("tapAgainToDelete") : t("deleteNamed", str(a.fileName)),
                () => twoTap(ctx, () => void vaultAction(ctx, { type: "deleteAttachment", cipherId: id, attachmentId: str(a.id) }, "deleted", false), str(a.id)),
                st.confirmDelete && st.armed === str(a.id) ? { class: "icon-btn danger" } : {},
              )
            : null,
        ),
      ),
      editable && !inTrash
        ? h(
            "label",
            { class: "row" },
            icon("plus"),
            h("div", { class: "body" }, h("span", { class: "title" }, t("addAttachment"))),
            h("input", { type: "file", class: "sr-only", "aria-label": t("addAttachment"), onchange: (e: Event) => void upload(ctx, id, (e.target as HTMLInputElement).files?.[0]) }),
          )
        : null,
    ),
    ...section(
      t("details"),
      org ? h("div", { class: "row" }, icon("shield"), h("div", { class: "body" }, h("span", { class: "label" }, t("organization")), h("span", { class: "value" }, org.name))) : null,
      collections.length ? h("div", { class: "row" }, icon("folder"), h("div", { class: "body" }, h("span", { class: "label" }, t("collections")), h("span", { class: "value" }, collections.join(", ")))) : null,
      folder ? h("div", { class: "row" }, icon("folder"), h("div", { class: "body" }, h("span", { class: "label" }, t("folder")), h("span", { class: "value" }, folder.name))) : null,
      item.revisionDate ? h("div", { class: "row" }, icon("edit"), h("div", { class: "body" }, h("span", { class: "label" }, t("lastEdited")), h("span", { class: "value" }, date(item.revisionDate)))) : null,
    ),
    h(
      "div",
      { class: "group" },
      !inTrash && editable && !item.organizationId && writableOrgs().length ? actionRow("shield", t("moveToOrg"), () => open(ctx, { kind: "org", id })) : null,
      !inTrash && editable && item.organizationId && writableCollections(str(item.organizationId)).length ? actionRow("folder", t("editCollections"), () => open(ctx, { kind: "org", id })) : null,
      !inTrash && !summary?.readOnly && type >= 1 && type <= 8
        ? inArchive
          ? actionRow("archive", t("unarchive"), () => void vaultAction(ctx, { type: "unarchiveItem", id }, "unarchived"))
          : actionRow("archive", t("archive"), () => void vaultAction(ctx, { type: "archiveItem", id }, "archived", true, () => void vaultAction(ctx, { type: "unarchiveItem", id }, "unarchived", false)))
        : null,
      inTrash
        ? actionRow("refresh", t("restore"), () => void vaultAction(ctx, { type: "restoreItem", id }, "restored"))
        : editable
          ? actionRow("copy", t("clone"), () => startEdit(ctx, { ...structuredClone(item), id: undefined, attachments: null, name: `${str(item.name)} ${t("copySuffix")}`, passwordHistory: null }, {}, true))
          : null,
      inTrash
        ? actionRow("trash", t(confirm ? "confirmPurge" : "deleteForever"), () => twoTap(ctx, () => void vaultAction(ctx, { type: "purgeItem", id }, "deleted")), true)
        : editable
          ? // One click: the notice's Undo is the safety net (a second click on top of it was only friction).
            actionRow("trash", t("moveToTrash"), () => void vaultAction(ctx, { type: "deleteItem", id }, "movedToTrash", true, () => void vaultAction(ctx, { type: "restoreItem", id }, "restored", false)), true)
          : null,
    ),
  );
}
