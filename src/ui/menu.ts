// Inline menu (menu.html), framed by the content script under a login / card / identity field.
// An extension page, so the website cannot read the list. Fill happens in the service worker.
import type { MenuData } from "../shared/messages.ts";
import { guardClicks, h, send as ask, t } from "./dom.ts";
import { icon } from "./icons.ts";
import { tile } from "./vault.ts";

const app = document.getElementById("app")!;
/** The secret of the document that opened this menu (see content.ts); the worker checks it. */
const nonce = location.hash.slice(1);

function row(icn: Node, title: string, sub: string, onclick: () => void, label = title, role?: string) {
  return h("button", { type: "button", class: "row", "aria-label": label, role, onclick }, icn, h("div", { class: "body" }, h("span", { class: "title" }, title), sub ? h("span", { class: "sub" }, sub) : null));
}

async function render() {
  const r = await ask<MenuData>({ type: "inlineList", nonce });
  if (!r.ok) return app.replaceChildren(h("div", { class: "note", role: "alert" }, icon("error"), r.error));
  const d = r.data;
  if (d.locked)
    return app.replaceChildren(h("div", { class: "group" }, row(icon("lock"), t("unlockToFill"), t("appName"), () => void ask({ type: "inlineOpen", nonce }))));
  // A website waiting on a conditional passkey request: the stored passkey is one click away.
  const passkey = d.passkey
    ? row(
        icon("fingerprint"),
        t("passkeySignInTitle"),
        t("appName"),
        async () => {
          const p = await ask({ type: "inlinePasskey", nonce });
          if (!p.ok) app.replaceChildren(h("div", { class: "note", role: "alert" }, icon("error"), p.error));
        },
        t("passkeySignInTitle"),
        "option",
      )
    : null;
  const create = d.create ? row(icon("plus"), t("createAccount"), t("appName"), () => void ask({ type: "inlineNewLogin", nonce }), t("createAccount"), "option") : null;
  const alias = d.alias
    ? row(icon("mail"), t("inlineAlias"), t("appName"), async () => {
        const r = await ask({ type: "inlineAlias", nonce });
        if (!r.ok) app.replaceChildren(h("div", { class: "note", role: "alert" }, icon("error"), r.error));
      }, t("inlineAlias"), "option")
    : null;
  app.replaceChildren(
    h(
      "div",
      { class: "group", role: "listbox", "aria-label": t("appName") },
      passkey,
      create,
      alias,
      ...d.items.map((i) => {
        const name = i.name || t("untitled");
        // Logins lead with the account, as Chrome's dropdown does; the item name says where it is from.
        const [title, sub] = d.kind === "login" && i.sub ? [i.sub, name] : [name, i.sub];
        return row(tile("", i.type), title, sub, async () => {
          const f = await ask({ type: "inlineFill", id: i.id, nonce });
          if (!f.ok) app.replaceChildren(h("div", { class: "note", role: "alert" }, icon("error"), f.error));
        }, [title, sub].filter(Boolean).join(", "), "option"); // the visible text is the name (WCAG 2.5.3)
      }),
    ),
    // Pinned under the list, like Chrome's "Manage passwords…": the frame height counts it (content.ts).
    h("div", { class: "menu-foot" }, row(icon("key"), t("managePasswords"), "", () => void ask({ type: "inlineOpen", nonce }))),
  );
}

// Keyboard: the field's ArrowDown focuses this frame (content.ts) and the first row takes it; the arrows move between
// rows, Enter fills (a click, still behind guardClicks), Escape or ArrowUp on the first row goes back to the field.
const rows = () => [...app.querySelectorAll<HTMLElement>("button.row")];
addEventListener("focus", () => {
  if (!app.contains(document.activeElement)) rows()[0]?.focus();
});
// The focused option is the selected one (listbox semantics), and is what the filled highlight marks.
addEventListener("focusin", () => {
  for (const r of rows()) if (r.getAttribute("role") === "option") r.setAttribute("aria-selected", String(r === document.activeElement));
});
addEventListener("keydown", (e) => {
  const list = rows();
  const at = list.indexOf(document.activeElement as HTMLElement);
  const next = e.key === "Escape" ? -1 : ({ ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: list.length - 1 } as Record<string, number>)[e.key];
  if (next === undefined) return;
  e.preventDefault();
  if (next < 0) return parent.postMessage("warren:back", "*");
  list[Math.min(next, list.length - 1)]?.focus();
});

guardClicks();
void render();
