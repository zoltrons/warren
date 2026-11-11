// Save / update bar (bar.html), framed by the content script at the top of the page after a login
// was submitted. The credentials stay in the service worker; this page only shows host and username.
import type { BarInfo } from "../shared/messages.ts";
import { guardClicks, h, send as ask, t } from "./dom.ts";
import { icon } from "./icons.ts";

const app = document.getElementById("app")!;
/** The secret of the save prompt that opened this bar (see showBar); the worker checks it. */
const token = location.hash.slice(1);
guardClicks();

/** The frame fits the bar (content.ts), so an error line gets room and nothing is left blank under the buttons. */
const fit = () => parent.postMessage({ barHeight: Math.ceil((app.firstElementChild?.getBoundingClientRect().height ?? 0) + 8) }, "*");

async function act(action: "save" | "never" | "close") {
  for (const b of app.querySelectorAll("button")) b.disabled = true;
  const r = await ask({ type: "barAction", action, token });
  if (!r.ok) {
    (app.firstElementChild ?? app).append(h("p", { class: "error", role: "alert" }, icon("error"), r.error));
    fit();
  }
}

// Escape dismisses the bar like Chrome's bubble (the same as its close button).
addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !app.querySelector("button:disabled")) void act("close");
});

void ask<BarInfo | null>({ type: "barInfo", token }).then((r) => {
  if (!r.ok || !r.data) return;
  const d = r.data;
  app.replaceChildren(
    h(
      "div",
      { class: "bar" },
      h(
        "div",
        { class: "top" },
        // A key on the brand tint, as Chrome's save bubble leads with a key; the title names Warren.
        h("span", { class: "bar-mark", "aria-hidden": "true" }, icon("key")),
        h("div", { class: "body" }, h("strong", {}, t(d.kind === "add" ? "barSaveTitle" : "barUpdateTitle")), h("span", { class: "sub" }, d.host)),
        h("button", { type: "button", class: "icon-btn sm", "aria-label": t("close"), onclick: () => void act("close") }, icon("close")),
      ),
      // What is saved, as in Chrome's bubble: the username and a masked password (its value stays in the worker).
      h(
        "div",
        { class: "group" },
        d.username ? h("div", { class: "row" }, h("span", { class: "label" }, t("username")), h("span", { class: "value ellipsis" }, d.username)) : null,
        h("div", { class: "row" }, h("span", { class: "label" }, t("password")), h("span", { class: "value", "aria-hidden": "true" }, "••••••••")),
      ),
      h(
        "div",
        { class: "actions row-actions" },
        d.kind === "add" ? h("button", { type: "button", class: "btn neutral", onclick: () => void act("never") }, t("barNever")) : null,
        h("button", { type: "button", class: "btn filled", onclick: () => void act("save") }, t(d.kind === "add" ? "save" : "barUpdate")),
      ),
    ),
  );
  fit();
});
