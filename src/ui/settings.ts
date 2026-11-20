// Settings tab of the popup / side panel: its rows, search, export and import. The shell (popup.ts) owns the state
// and the request bus; this module imports them from it (and popup.ts imports settingsTab and row from here).
import { AUTO_LOCK_CHOICES, CLEAR_CLIPBOARD_CHOICES, type ClearClipboardDelay, EXPORT_FORMATS, URI_MATCH, URI_MATCH_ADVANCED } from "../shared/constants.ts";
import type { ExportFormat, Request, State } from "../shared/messages.ts";
import { applyTheme, type Child, h, inPanel, leave, plural, rowOf, savedTheme, send, sessionNow, setUiPref, switchOf, t, THEMES, uiPref, when, withChevron, WIDTHS, wordsStartWith } from "./dom.ts";
import { icon } from "./icons.ts";
import { uriMatchLabel } from "./vault-edit.ts";
import { clearOpened, errorBox, hasOpened, iconButton, recentShown, resetVault, setRecentShown } from "./vault-shared.ts";
import { act, armedLogout, busyBar, disableBiometric, draft, host, inTab, render, setupBiometric, stateRequest, ui, windowId } from "./popup.ts";

let pinLock = true; // PIN setup: ask for the master password after a browser restart

export function row(title: string, sub?: string, trailing?: Child, extra: Record<string, unknown> = {}, tag: "div" | "button" = "div") {
  return h(tag, { class: "row", ...extra }, h("div", { class: "body" }, h("span", { class: "title" }, title), sub ? h("span", { class: "sub wrap" }, sub) : null), trailing);
}

function autoLockLabel(m: number): string {
  if (m < 0) return t("autoLockRestart");
  return m < 60 ? t("minutes", String(m)) : t("hours", String(m / 60));
}

function clearClipboardLabel(v: ClearClipboardDelay): string {
  const key = {
    never: "never",
    thirtySeconds: "thirtySeconds",
    oneMinute: "oneMinute",
    twoMinutes: "twoMinutes",
    fiveMinutes: "fiveMinutes",
  }[v];
  return t(key);
}

function openExternal(url: string) {
  void chrome.tabs.create({ url });
}

async function syncNow() {
  Object.assign(ui, { busy: true, busyLabel: t("syncing"), error: undefined, info: undefined });
  render();
  const r = await send<unknown>({ type: "sync", force: true });
  ui.busy = false;
  ui.busyLabel = undefined;
  if (!r.ok) ui.error = r.error;
  else {
    await stateRequest({ type: "getState" });
    ui.info = t("syncComplete");
    resetVault();
  }
  render();
}

export function settingsTab(s: State): HTMLElement {
  const select = h(
    "select",
    {
      "aria-label": t("autoLock"),
      onchange: (e: Event) => void act({ type: "setSettings", autoLockMinutes: Number((e.target as HTMLSelectElement).value) }),
    },
    ...AUTO_LOCK_CHOICES.map((m) => h("option", { value: String(m), selected: m === s.settings.autoLockMinutes }, autoLockLabel(m))),
  );
  const sysLock = h("input", {
    type: "checkbox",
    checked: s.settings.lockOnSystemLock,
    "aria-label": t("lockOnSystemLock"),
    onchange: (e: Event) => void act({ type: "setSettings", lockOnSystemLock: (e.target as HTMLInputElement).checked }),
  });
  /** A row to type a website into; the worker turns it into a host name or refuses it. */
  const hostForm = (label: string, req: (host: string) => Request) =>
    h(
      "form",
      {
        class: "row",
        onsubmit: (e: Event) => {
          e.preventDefault();
          const input = (e.target as HTMLFormElement).querySelector("input")!;
          if (input.value.trim()) void act(req(input.value));
        },
      },
      h("input", { type: "text", inputmode: "url", autocomplete: "off", spellcheck: false, "aria-label": label, placeholder: "example.com" }),
      h("button", { type: "submit", class: "btn tonal small", disabled: ui.busy }, label),
    );
  const toggle = (label: string, checked: boolean, onchange: (box: HTMLInputElement) => void) =>
    switchOf(h("input", { type: "checkbox", checked, "aria-label": label, onchange: (e: Event) => onchange(e.target as HTMLInputElement) }));
  const defaultManager = (box: HTMLInputElement) => {
    if (!box.checked) return void act({ type: "setDefaultManager", enabled: false });
    // The optional "privacy" permission must be requested inside the click.
    chrome.permissions.request({ permissions: ["privacy"] }).then(
      (granted) => (granted ? void act({ type: "setDefaultManager", enabled: true }) : ((box.checked = false), (ui.error = t("errPermissionDenied")), render())),
      (err: unknown) => ((box.checked = false), (ui.error = String(err)), render()),
    );
  };
  const page = h(
    "div",
    { class: "page" },
    h("div", { class: "top" }, h("h1", {}, t("settings"))),
    settingsSearch(),
    h("p", { class: "empty settings-none", role: "status", hidden: true }, t("noMatchingSettings")),
    section(
      t("autofill"),
      h(
      "div",
      { class: "group" },
      row(t("inlineMenu"), t("inlineMenuHint"), toggle(t("inlineMenu"), s.settings.inlineMenu, (b) => void act({ type: "setSettings", inlineMenu: b.checked }))),
      s.settings.inlineMenu
        ? row(t("inlineMenuCards"), undefined, toggle(t("inlineMenuCards"), s.settings.inlineMenuCards, (b) => void act({ type: "setSettings", inlineMenuCards: b.checked })), { class: "row nested" })
        : null,
      s.settings.inlineMenu
        ? row(t("inlineMenuIdentities"), undefined, toggle(t("inlineMenuIdentities"), s.settings.inlineMenuIdentities, (b) => void act({ type: "setSettings", inlineMenuIdentities: b.checked })), { class: "row nested" })
        : null,
      row(t("showCardsOnTab"), undefined, toggle(t("showCardsOnTab"), s.settings.showCardsOnTab, (b) => void act({ type: "setSettings", showCardsOnTab: b.checked }))),
      row(t("showIdentitiesOnTab"), undefined, toggle(t("showIdentitiesOnTab"), s.settings.showIdentitiesOnTab, (b) => void act({ type: "setSettings", showIdentitiesOnTab: b.checked }))),
      row(t("quickActionMenus"), t("quickActionMenusHint"), toggle(t("quickActionMenus"), s.settings.quickActionMenus, (b) => void act({ type: "setSettings", quickActionMenus: b.checked }))),
      row(t("autoCopyTotp"), t("autoCopyTotpHint"), toggle(t("autoCopyTotp"), s.settings.autoCopyTotp, (b) => void act({ type: "setSettings", autoCopyTotp: b.checked }))),
      row(t("enableContextMenu"), undefined, toggle(t("enableContextMenu"), s.settings.contextMenu, (b) => void act({ type: "setSettings", contextMenu: b.checked }))),
      row(t("badgeCounter"), t("badgeCounterHint"), toggle(t("badgeCounter"), s.settings.badgeCounter, (b) => void act({ type: "setSettings", badgeCounter: b.checked }))),
      row(t("savePrompt"), t("savePromptHint"), toggle(t("savePrompt"), s.settings.savePrompt, (b) => void act({ type: "setSettings", savePrompt: b.checked }))),
      s.settings.neverSave.length
        ? row(plural("neverSaveSites", s.settings.neverSave.length), s.settings.neverSave.join(", "), h("button", { type: "button", class: "btn text small", onclick: () => void act({ type: "setSettings", clearNeverSave: true }) }, t("clear")))
        : null,
      ...s.settings.neverSave.map((h0) =>
        row(h0, undefined, iconButton("close", t("removeNeverSave", h0), (e) => leave(rowOf(e), () => void act({ type: "setSettings", removeNeverSave: h0 })))),
      ),
      s.settings.savePrompt ? hostForm(t("addNeverSave"), (host) => ({ type: "setSettings", addNeverSave: host })) : null,
      row(t("defaultManager"), t("defaultManagerHint"), toggle(t("defaultManager"), s.settings.defaultManager, defaultManager)),
      row(t("attentionBanner"), t("attentionBannerHint"), toggle(t("attentionBanner"), uiPref("attentionBanner") === "on", (b) => setUiPref("attentionBanner", b.checked ? "on" : "off"))),
      row(t("breachOnSave"), t("breachOnSaveHint"), toggle(t("breachOnSave"), uiPref("breachSave") === "on", (b) => setUiPref("breachSave", b.checked ? "on" : "off"))),
      row(t("autosubmit"), t("autosubmitHint"), toggle(t("autosubmit"), s.settings.autosubmit, (b) => void act({ type: "setSettings", autosubmit: b.checked }))),
      ),
    ),
    section(
      t("autofillOnPageLoad"),
      h(
      "div",
      { class: "group" },
      row(
        t("autofillOnPageLoad"),
        t("autofillOnPageLoadHint"),
        toggle(t("autofillOnPageLoad"), s.settings.autofillOnPageLoad, (b) => void act({ type: "setSettings", autofillOnPageLoad: b.checked })),
      ),
      s.settings.autofillOnPageLoad
        ? row(
            t("autofillOnPageLoadDefault"),
            t("autofillOnPageLoadDefaultHint"),
            withChevron(
              h(
                "select",
                {
                  "aria-label": t("autofillOnPageLoadDefault"),
                  onchange: (e: Event) => void act({ type: "setSettings", autofillOnPageLoadDefault: (e.target as HTMLSelectElement).value === "true" }),
                },
                h("option", { value: "true", selected: s.settings.autofillOnPageLoadDefault }, t("on")),
                h("option", { value: "false", selected: !s.settings.autofillOnPageLoadDefault }, t("off")),
              ),
            ),
          )
        : null,
      ),
    ),
    section(
      t("additionalOptions"),
      h(
      "div",
      { class: "group" },
      row(
        t("clearClipboard"),
        t("clearClipboardDesc"),
        withChevron(
          h(
            "select",
            {
              "aria-label": t("clearClipboard"),
              onchange: (e: Event) => void act({ type: "setSettings", clearClipboardDelay: (e.target as HTMLSelectElement).value as ClearClipboardDelay }),
            },
            ...CLEAR_CLIPBOARD_CHOICES.map((v) => h("option", { value: v, selected: v === s.settings.clearClipboardDelay }, clearClipboardLabel(v))),
          ),
        ),
      ),
      row(
        t("defaultUriMatchDetection"),
        t(URI_MATCH_ADVANCED.includes(s.settings.defaultUriMatch) ? "uriMatchDefaultAdvancedHint" : "uriMatchDefaultHint"),
        withChevron(
          h(
            "select",
            {
              "aria-label": t("defaultUriMatchDetection"),
              onchange: (e: Event) => void act({ type: "setSettings", defaultUriMatch: Number((e.target as HTMLSelectElement).value) }),
            },
            ...[URI_MATCH.Domain, URI_MATCH.Host, URI_MATCH.Exact, URI_MATCH.Never, URI_MATCH.StartsWith, URI_MATCH.RegularExpression].map((m) =>
              h("option", { value: String(m), selected: m === s.settings.defaultUriMatch }, uriMatchLabel(m)),
            ),
          ),
        ),
      ),
      ),
    ),
    section(
      t("blockedSites"),
      h("p", { class: "caption" }, t("blockedSitesHint")),
      h(
        "div",
        { class: "group" },
        ...s.settings.blocked.map((h0) => row(h0, undefined, iconButton("close", t("unblockSite", h0), (e) => leave(rowOf(e), () => void act({ type: "setSettings", removeBlocked: h0 }))))),
        hostForm(t("blockSite"), (host) => ({ type: "setSettings", addBlocked: host })),
      ),
    ),
    section(
      t("account"),
      h(
        "div",
        { class: "group" },
        row(s.email ?? "", t("loggedIn")),
        row(host(s.serverUrl), s.serverVersion ? t("serverVersion", s.serverVersion) : undefined),
        s.weakKdf ? h("div", { class: "notice warn" }, icon("shield"), h("div", {}, t("weakKdf"))) : null,
      ),
    h(
      "div",
      { class: "group" },
      inPanel || windowId === undefined
        ? null
        : row(t("openSidePanel"), undefined, icon("panel"), {
            type: "button",
            // sidePanel.open needs the user gesture, so no await before it.
            onclick: () => void chrome.sidePanel.open({ windowId: windowId! }).then(() => window.close(), (e: unknown) => ((ui.error = String(e)), render())),
          }, "button"),
      // The OS biometric prompt can close the action popup; setup and unlock also work in a tab.
      !inPanel && !inTab
        ? row(t("openInTab"), t("openInTabHint"), icon("external"), { type: "button", onclick: () => void chrome.tabs.create({ url: location.href }) }, "button")
        : null,
      row(ui.armLogout ? t("confirmLogOut") : t("logOut"), undefined, icon("logout"), { type: "button", class: "row danger", onclick: armedLogout }, "button"),
      ),
    ),
    section(
      t("security"),
      h(
      "div",
      { class: "group" },
      row(t("lockNow"), undefined, icon("lock"), { class: "row action-row", type: "button", onclick: () => void act({ type: "lock" }) }, "button"),
      row(t("autoLock"), undefined, withChevron(select)),
      row(
        t("timeoutAction"),
        undefined,
        withChevron(
          h(
            "select",
            { "aria-label": t("timeoutAction"), onchange: (e: Event) => void act({ type: "setSettings", timeoutAction: (e.target as HTMLSelectElement).value as "lock" | "logout" }) },
            h("option", { value: "lock", selected: s.settings.timeoutAction === "lock" }, t("lock")),
            h("option", { value: "logout", selected: s.settings.timeoutAction === "logout" }, t("logOut")),
          ),
        ),
      ),
      row(t("lockOnSystemLock"), undefined, switchOf(sysLock)),
      row(
        t("unlockWithPin"),
        t("unlockWithPinHint"),
        // Switching off before a PIN was saved only closes the setup form; there is nothing to remove yet.
        toggle(t("unlockWithPin"), !!s.pinSet || !!ui.pinSetup, (b) =>
          b.checked ? ((ui.pinSetup = true), render()) : s.pinSet ? void act({ type: "setPin" }) : ((ui.pinSetup = false), (draft.pin = ""), render()),
        ),
      ),
      ui.pinSetup && !s.pinSet ? row(t("pinLockOnRestart"), t("pinLockOnRestartHint"), toggle(t("pinLockOnRestart"), pinLock, (b) => (pinLock = b.checked))) : null,
      ui.pinSetup && !s.pinSet
        ? h(
            "form",
            {
              class: "row",
              onsubmit: async (e: Event) => {
                e.preventDefault();
                const pin = draft.pin;
                draft.pin = "";
                if (await act({ type: "setPin", pin, pinOnly: !pinLock })) ui.pinSetup = false;
                render();
              },
            },
            h("input", { type: "password", autocomplete: "off", required: true, "data-autofocus": "1", "aria-label": t("pin"), placeholder: t("pin"), value: draft.pin, oninput: (e: Event) => (draft.pin = (e.target as HTMLInputElement).value) }),
            h("button", { type: "submit", class: "btn tonal small", disabled: ui.busy }, t("setPin")),
          )
        : null,
      row(
        t("biometricUnlock"),
        t("biometricUnlockHint"),
        toggle(t("biometricUnlock"), !!s.biometric, (b) => void (b.checked ? setupBiometric() : disableBiometric())),
      ),
      ),
    ),
    section(
      t("appearance"),
      h(
        "div",
        { class: "group" },
      row(
        t("theme"),
        undefined,
        withChevron(
          h(
            "select",
            {
              "aria-label": t("theme"),
              onchange: (e: Event) => {
                localStorage.setItem("theme", (e.target as HTMLSelectElement).value);
                applyTheme();
              },
            },
            ...THEMES.map((v) => h("option", { value: v, selected: v === savedTheme() }, t(`theme_${v}`))),
          ),
        ),
      ),
      row(
        t("extensionWidth"),
        undefined,
        withChevron(
          h(
            "select",
            { "aria-label": t("extensionWidth"), onchange: (e: Event) => setUiPref("width", (e.target as HTMLSelectElement).value) },
            ...WIDTHS.map((v) => h("option", { value: v, selected: v === uiPref("width") }, t(`width_${v}`))),
          ),
        ),
      ),
      row(t("compactMode"), undefined, toggle(t("compactMode"), uiPref("compact") === "on", (b) => setUiPref("compact", b.checked ? "on" : "off"))),
      row(t("showAnimations"), undefined, toggle(t("showAnimations"), uiPref("motion") === "on", (b) => setUiPref("motion", b.checked ? "on" : "off"))),
      row(t("favicons"), t("faviconsHint"), toggle(t("favicons"), s.settings.favicons, (b) => void act({ type: "setSettings", favicons: b.checked }))),
      ),
    ),
    section(
      t("vault"),
      h(
      "div",
      { class: "group" },
      // The row is the button: its name was said twice, once as the title and once on a button beside it.
      row(t("syncNow"), s.syncedAt ? t("lastSync", when(s.syncedAt)) : t("lastSync", t("never")), icon("refresh"), { type: "button", disabled: ui.busy, onclick: () => void syncNow() }, "button"),
      row(
        t("showRecent"),
        t("showRecentHint"),
        h(
          "span",
          { class: "trailing" },
          // Only when there is something to clear: a greyed-out Clear beside the switch explained nothing.
          !hasOpened() ? null : h("button", { type: "button", class: "btn text small", onclick: () => void clearOpened().then((r) => ((r.ok ? (ui.info = t("recentCleared")) : (ui.error = r.error)), render())) }, t("clear")),
          toggle(t("showRecent"), recentShown(), (b) => (setRecentShown(b.checked), render())),
        ),
      ),
      row(t("exportVault"), t("exportHint"), icon("download"), { type: "button", disabled: ui.busy, onclick: () => ((ui.exporting = !ui.exporting), render()) }, "button"),
      ui.exporting
        ? row(
            t("exportFormat"),
            ui.exportFormat === "encrypted" ? t("exportEncryptedHint") : ui.exportFormat === "csv" ? t("exportCsvHint") : undefined,
            withChevron(
              h(
                "select",
                { "aria-label": t("exportFormat"), onchange: (e: Event) => ((ui.exportFormat = (e.target as HTMLSelectElement).value as ExportFormat), render()) },
                ...EXPORT_FORMATS.map((v) => h("option", { value: v, selected: v === (ui.exportFormat ?? "json") }, t(`exportFormat_${v}`))),
              ),
            ),
          )
        : null,
      ui.exporting
        ? h(
            "form",
            {
              class: "row stack",
              onsubmit: (e: Event) => {
                e.preventDefault();
                const password = draft.password;
                const filePassword = draft.filePassword;
                draft.password = draft.filePassword = "";
                void exportVault(password, ui.exportFormat ?? "json", filePassword);
              },
            },
            ui.exportFormat === "encrypted"
              ? h("input", { type: "password", autocomplete: "new-password", required: true, minlength: 8, "aria-label": t("filePassword"), placeholder: t("filePassword"), value: draft.filePassword, oninput: (e: Event) => (draft.filePassword = (e.target as HTMLInputElement).value) })
              : null,
            h("input", { type: "password", autocomplete: "current-password", required: true, "aria-label": t("masterPassword"), placeholder: t("masterPassword"), value: draft.password, oninput: (e: Event) => (draft.password = (e.target as HTMLInputElement).value) }),
            h("button", { type: "submit", class: "btn tonal small", disabled: ui.busy }, t("exportConfirm")),
          )
        : null,
      h(
        "label",
        { class: "row" },
        h("div", { class: "body" }, h("span", { class: "title" }, t("importVault")), h("span", { class: "sub wrap" }, t("importHint"))),
        h("input", { type: "file", accept: ".json,.csv,application/json,text/csv", class: "sr-only", "aria-label": t("importVault"), disabled: ui.busy, onchange: (e: Event) => void importVault((e.target as HTMLInputElement).files?.[0]) }),
      ),
      ui.importing
        ? h(
            "form",
            {
              class: "row",
              onsubmit: (e: Event) => {
                e.preventDefault();
                const password = draft.filePassword;
                draft.filePassword = "";
                void sendImport(ui.importing!, password);
              },
            },
            h("input", { type: "password", autocomplete: "off", required: true, "data-autofocus": "1", "aria-label": t("filePassword"), placeholder: t("filePassword"), value: draft.filePassword, oninput: (e: Event) => (draft.filePassword = (e.target as HTMLInputElement).value) }),
            h("button", { type: "submit", class: "btn tonal small", disabled: ui.busy }, t("importConfirm")),
          )
        : null,
      ),
    ),
    busyBar(),
    ui.info ? h("p", { class: "note", role: "status" }, ui.info) : null,
    section(
      t("about"),
      h(
      "div",
      { class: "group" },
      row(t("about"), chrome.runtime.getManifest().version),
      row(t("helpCenter"), undefined, icon("external"), { type: "button", onclick: () => openExternal("https://github.com/zoltrons/warren#readme") }, "button"),
      s.serverUrl ? row(t("webVault"), host(s.serverUrl), icon("external"), { type: "button", onclick: () => openExternal(`${s.serverUrl}/#/`) }, "button") : null,
    ),
    h("p", { class: "note" }, t("disclaimer")),
    ),
    errorBox(),
  );
  filterSettings(page, ui.settingsQuery ?? "");
  return page;
}

/** One titled block of settings; the search hides a whole block when nothing in it matches. */
function section(title: string, ...children: Child[]): HTMLElement {
  return h("section", { class: "settings-section", "aria-label": title }, h("h2", { class: "section-title" }, title), ...children);
}

function settingsSearch(): HTMLElement {
  const input = h("input", {
    type: "search",
    id: "settings-search",
    autocomplete: "off",
    spellcheck: false,
    "aria-label": t("searchSettings"),
    "aria-keyshortcuts": "/",
    title: t("searchShortcutHint"),
    placeholder: t("searchSettings"),
    value: ui.settingsQuery ?? "",
    oninput: () => apply(input.value),
    // Escape clears a query first, like the vault search; with none it is left to the page.
    onkeydown: (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !input.value) return;
      e.stopPropagation();
      apply("");
    },
  });
  // Filtered in place: a re-render would move the caret.
  const apply = (q: string) => {
    ui.settingsQuery = q;
    input.value = q;
    clear.hidden = !q;
    filterSettings(input.closest(".page")!, q);
  };
  const clear = h(
    "button",
    { type: "button", class: "icon-btn sm", "aria-label": t("clearSearch"), title: t("clearSearch"), hidden: !ui.settingsQuery, onclick: () => (apply(""), input.focus()) },
    icon("close"),
  );
  return h("div", { class: "search" }, icon("search"), input, clear);
}

/**
 * Shows the settings rows whose words start with the words of `query` (wordsStartWith; a block whose title
 * matches stays whole) and hides the blocks left empty.
 */
function filterSettings(page: ParentNode, query: string): void {
  const q = query.trim();
  // Each text piece on its own, so a title and the description under it stay two words ("fields Show", not
  // "fieldsShow"); a select's options all count, so "dark" finds Theme.
  const textOf = (el: Element) => {
    const parts: string[] = [];
    const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    while (walk.nextNode()) parts.push(walk.currentNode.nodeValue ?? "");
    return parts.join(" ");
  };
  let shown = 0;
  for (const sec of page.querySelectorAll<HTMLElement>(".settings-section")) {
    const whole = !q || wordsStartWith(textOf(sec.querySelector(".section-title") ?? sec), q);
    let any = whole;
    for (const el of sec.querySelectorAll<HTMLElement>(".group > *, .caption, .note")) {
      const labels = [...el.querySelectorAll("[aria-label]")].map((x) => x.getAttribute("aria-label")).join(" ");
      const hit = whole || wordsStartWith(`${textOf(el)} ${labels}`, q);
      el.hidden = !hit;
      any ||= hit;
    }
    // A card whose rows all went would still draw its empty border.
    for (const group of sec.querySelectorAll<HTMLElement>(".group")) group.hidden = ![...group.children].some((c) => !(c as HTMLElement).hidden);
    sec.hidden = !any;
    if (any) shown++;
  }
  const none = page.querySelector<HTMLElement>(".settings-none");
  if (none) none.hidden = shown > 0;
}

async function exportVault(password: string, format: ExportFormat, filePassword: string) {
  Object.assign(ui, { busy: true, error: undefined, info: undefined });
  render();
  const r = await send<string>({ type: "exportVault", password, format, ...(format === "encrypted" ? { filePassword } : {}) });
  ui.busy = false;
  if (r.ok) {
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 14);
    const csv = format === "csv";
    const url = URL.createObjectURL(new Blob([r.data], { type: csv ? "text/csv" : "application/json" }));
    h("a", { href: url, download: `warren_export_${stamp}${format === "encrypted" ? "_encrypted" : ""}.${csv ? "csv" : "json"}` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    ui.exporting = false;
  } else ui.error = r.error;
  render();
}

async function importVault(file: File | undefined) {
  if (!file) return;
  Object.assign(ui, { busy: true, error: undefined, info: undefined });
  render();
  const asked = sessionNow();
  const text = await file.text();
  // A lock or another account while the file was read: the import was meant for the session before.
  if (asked !== sessionNow()) return void ((ui.busy = false), render());
  // A password-protected export: ask for its file password first (the worker opens it).
  let protectedFile = false;
  try {
    protectedFile = text.trimStart().startsWith("{") && (JSON.parse(text) as { passwordProtected?: unknown }).passwordProtected === true;
  } catch {
    /* the worker reports what is wrong with it */
  }
  if (protectedFile) return void ((ui.busy = false), (ui.importing = text), render());
  await sendImport(text);
}

async function sendImport(text: string, password?: string) {
  Object.assign(ui, { busy: true, error: undefined, info: undefined });
  render();
  const r = await send<{ imported: number; skipped: number }>({ type: "importVault", text, ...(password ? { password } : {}) });
  ui.busy = false;
  if (r.ok || !password) ui.importing = undefined;
  if (r.ok) {
    ui.info = t("imported", String(r.data.imported)) + (r.data.skipped ? ` ${t("importSkipped", String(r.data.skipped))}` : "");
    resetVault(); // the list reloads with the new items
  } else ui.error = r.error;
  render();
}
