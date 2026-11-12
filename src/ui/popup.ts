// Popup. Talks only to the service worker through the typed message bus: no crypto, no network.
import { AUTO_LOCK_CHOICES, CLEAR_CLIPBOARD_CHOICES, type ClearClipboardDelay, EXPORT_FORMATS, TWO_FACTOR, URI_MATCH, URI_MATCH_ADVANCED } from "../shared/constants.ts";
import type { ExportFormat, LoginRequest, Request, Response, State } from "../shared/messages.ts";
import { normalizeServerUrl } from "../shared/url.ts";
import { applyTheme, type Child, h, inPanel, leave, motionOff, newSession, rowOf, savedTheme, send, sessionNow, setUiPref, t, THEMES, plural, uiPref, when, withChevron, WIDTHS, wordsStartWith } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { createBiometricCredential, getBiometricPrf, platformAuthenticatorAvailable } from "./biometric.ts";
import { passkeyRequestId, passkeyScreen, resetPasskey } from "./passkey.ts";
import { resetSend, sendScreen, startTextSend } from "./send.ts";
import { generatorScreen } from "./generator.ts";
import { navMotion } from "./motion.ts";
import { loadCommonWords } from "../shared/strength.ts";
import { clearOpened, type Ctx, hasOpened, iconButton, recentShown, refreshPageMatches, reloadList, resetVault, setIconBase, setRecentShown, toastEl, uriMatchLabel, vaultRouteKey, vaultScreen } from "./vault.ts";

// ---------- state ----------

interface Ui {
  busy: boolean;
  /** Settings → Log out was clicked once: the next click within 4 s logs out. */
  armLogout?: boolean;
  busyLabel?: string;
  error?: string;
  info?: string;
  tab: "vault" | "generator" | "send" | "settings";
  editServer: boolean;
  reveal: boolean;
  provider?: number;
  /** WebAuthn was cancelled or failed: wait for a click instead of prompting again on every render. */
  webauthnPaused?: boolean;
  /** Locked view: master password instead of the PIN. */
  usePassword?: boolean;
  /** Settings: the PIN form is open. */
  pinSetup?: boolean;
  /** Settings: the export form (master password) is open. */
  exporting?: boolean;
  exportFormat?: ExportFormat;
  /** Settings: a password-protected export waiting for its file password. */
  importing?: string;
  /** Other devices' login requests: fetched when the approval screen opens; `later` hides it for this popup. */
  requests?: LoginRequest[];
  requestsLater?: boolean;
  /** Settings: the search box's text; rows that do not mention it are hidden. */
  settingsQuery?: string;
}

let pinLock = true; // PIN setup: ask for the master password after a browser restart
const draft = { server: "", email: "", password: "", code: "", pin: "", remember: false, filePassword: "" };
const ui: Ui = { busy: false, tab: "vault", editServer: false, reveal: false };
let state: State | undefined;

/** Unlocks the screen has gone through (locks and account changes: dom.ts sessionNow). */
let unlocks = 0;

/**
 * Every State the popup shows comes through here, with when it was asked for. An answer asked before a lock never
 * opens the vault again, and one asked before an unlock never closes it (which would wipe what was done since, an
 * edited item): either way a newer answer is here already or on its way. A lock or another account also makes the
 * answers to everything else asked before it stale (dom.ts send).
 */
function setState(next: State, asked = { locks: sessionNow(), unlocks }): void {
  const open = next.phase === "unlocked";
  if (open ? asked.locks !== sessionNow() : asked.unlocks !== unlocks) return;
  if (state?.phase === "unlocked" && (!open || state.email !== next.email)) {
    newSession();
    // A master password or PIN typed in the session that ended (export, PIN setup) must not wait on the lock screen.
    draft.password = draft.pin = draft.filePassword = "";
    ui.reveal = ui.exporting = false;
    ui.importing = undefined;
  }
  else if (state && state.phase !== "unlocked" && open) unlocks++;
  state = next;
}

/** A request answered with a State, applied through setState. */
async function stateRequest(req: Request): Promise<Response<State>> {
  const asked = { locks: sessionNow(), unlocks };
  const res = await send<State>(req, true);
  if (res.ok) setState(res.data, asked);
  return res;
}

async function act(req: Request, busyLabel?: string): Promise<boolean> {
  Object.assign(ui, { busy: true, busyLabel, error: undefined, info: undefined });
  render();
  const res = await stateRequest(req);
  ui.busy = false;
  ui.busyLabel = undefined;
  if (!res.ok) ui.error = res.error;
  render();
  return res.ok;
}

// ---------- building blocks ----------

const host = (url?: string) => (url ? new URL(url).host : "");

function field(opts: {
  label: string;
  input: HTMLInputElement | HTMLSelectElement;
  trailing?: Child;
  extraClass?: string;
}) {
  const id = `f-${opts.label.replace(/\W+/g, "-").toLowerCase()}`;
  opts.input.id = id;
  return h(
    "div",
    { class: `field ${opts.extraClass ?? ""}` },
    h("label", { for: id }, h("span", {}, opts.label), opts.input),
    opts.trailing,
  );
}

function bound(key: "server" | "email" | "password" | "code" | "pin", props: Record<string, unknown>) {
  return h("input", {
    ...props,
    value: draft[key],
    disabled: ui.busy,
    oninput: (e: Event) => (draft[key] = (e.target as HTMLInputElement).value),
  });
}

function passwordField(autocomplete: string) {
  const input = bound("password", {
    type: ui.reveal ? "text" : "password",
    autocomplete,
    required: true,
    spellcheck: false,
    "data-autofocus": draft.email || autocomplete === "current-password" ? "1" : undefined,
  });
  const toggle = h(
    "button",
    {
      type: "button",
      class: "icon-btn",
      "aria-label": t(ui.reveal ? "hidePassword" : "showPassword"),
      onclick: () => {
        ui.reveal = !ui.reveal;
        render();
      },
    },
    icon(ui.reveal ? "eyeOff" : "eye"),
  );
  return field({ label: t("masterPassword"), input, trailing: toggle });
}

function errorBox(): Child {
  return ui.error ? h("div", { class: "error", role: "alert" }, icon("error"), h("div", {}, ui.error)) : null;
}

function busyBar(): Child {
  return ui.busy ? h("div", {}, h("div", { class: "progress" }), ui.busyLabel ? h("p", { class: "note" }, ui.busyLabel) : null) : null;
}

function submitButton(label: string) {
  return h("button", { type: "submit", class: "btn filled wide", disabled: ui.busy }, label);
}

function brand(title: string, subtitle?: Child) {
  return h("div", { class: "brand" }, h("img", { class: "logo", src: "icons/warren-128.png", alt: "" }), h("h1", {}, title), subtitle ? h("p", {}, subtitle) : null);
}

// ---------- views ----------

function setupView(): HTMLElement {
  const onsubmit = (e: Event) => {
    e.preventDefault();
    let url: string;
    try {
      url = normalizeServerUrl(draft.server);
    } catch (err) {
      ui.error = (err as Error).message;
      render();
      return;
    }
    void act({ type: "setServer", url }, t("busyCheckingServer")).then((ok) => {
      if (ok) ui.editServer = false;
    });
  };
  return h(
    "form",
    { class: "page center", onsubmit, novalidate: true },
    brand(t("appName"), t("setupSubtitle")),
    field({
      label: t("serverUrl"),
      input: bound("server", {
        type: "url",
        placeholder: "https://vault.example.com",
        autocomplete: "url",
        required: true,
        spellcheck: false,
        "data-autofocus": "1",
      }),
    }),
    errorBox(),
    busyBar(),
    h(
      "div",
      { class: "actions" },
      submitButton(t("continue")),
      state?.serverUrl
        ? h("button", { type: "button", class: "btn text", onclick: () => ((ui.editServer = false), (ui.error = undefined), render()) }, t("cancel"))
        : null,
    ),
    h("p", { class: "note" }, t("setupHint")),
    h("p", { class: "note" }, t("testingNote")),
  );
}

function serverChip() {
  return h(
    "button",
    {
      type: "button",
      class: "btn text small server-link",
      disabled: ui.busy,
      "aria-label": t("changeServer"),
      onclick: () => {
        draft.server = state?.serverUrl ?? "";
        ui.editServer = true;
        ui.error = undefined;
        render();
      },
    },
    host(state?.serverUrl),
    icon("chevronDown"),
  );
}

function loginView(): HTMLElement {
  const onsubmit = (e: Event) => {
    e.preventDefault();
    const password = draft.password;
    draft.password = "";
    void act({ type: "login", email: draft.email, password }, t("busyLoggingIn"));
  };
  return h(
    "form",
    { class: "page center", onsubmit },
    brand(t("loginTitle")),
    serverChip(),
    field({
      label: t("email"),
      input: bound("email", { type: "email", autocomplete: "username", required: true, spellcheck: false, "data-autofocus": draft.email ? undefined : "1" }),
    }),
    passwordField("current-password"),
    errorBox(),
    busyBar(),
    h(
      "div",
      { class: "actions" },
      submitButton(t("logIn")),
      h("button", { type: "button", class: "btn text", disabled: ui.busy, onclick: () => void act({ type: "deviceLogin", email: draft.email }, t("busyRequesting")) }, t("logInWithDevice")),
      h("button", { type: "button", class: "btn text", disabled: ui.busy, onclick: () => void act({ type: "ssoStart" }, t("busyOpeningSso")) }, t("logInSso")),
    ),
    h("p", { class: "note" }, t("ssoHint")),
  );
}

// ---------- log in with device ----------

/** While the request waits, ask every few seconds whether another device approved it. */
let devicePoll: ReturnType<typeof setTimeout> | undefined;

function pollDeviceLogin(): void {
  if (devicePoll !== undefined) return;
  devicePoll = setTimeout(async () => {
    // Cancelled (Back) while this waited: nothing to ask.
    if (state?.phase !== "deviceLogin") return void (devicePoll = undefined);
    const r = await stateRequest({ type: "deviceLoginCheck" });
    devicePoll = undefined;
    if (!r.ok) {
      ui.error = r.error;
      await stateRequest({ type: "getState" });
    }
    render();
  }, 3000);
}

function deviceLoginView(s: State): HTMLElement {
  pollDeviceLogin();
  return h(
    "div",
    { class: "page" },
    h(
      "div",
      { class: "top" },
      h("button", { type: "button", class: "icon-btn", "aria-label": t("back"), onclick: () => void act({ type: "twoFactorCancel" }) }, icon("back")),
      h("h1", {}, t("logInWithDevice")),
    ),
    h("p", { class: "caption" }, t("deviceLoginHint", s.email ?? "")),
    h("div", { class: "field" }, h("label", {}, h("span", {}, t("fingerprintPhrase")), h("output", { class: "phrase" }, s.fingerprint ?? ""))),
    errorBox(),
    h("div", {}, h("div", { class: "progress" }), h("p", { class: "note" }, t("deviceLoginWaiting"))),
  );
}

/** Approval of another device's login: the phrase must match what that device shows. */
function loginRequestView(s: State): HTMLElement {
  const r = ui.requests?.[0];
  if (!ui.requests && !ui.busy) void loadRequests();
  const answer = (approve: boolean) => async () => {
    Object.assign(ui, { busy: true, error: undefined });
    render();
    const res = await send<LoginRequest[]>({ type: "answerLoginRequest", id: r!.id, approve, fingerprint: r!.fingerprint });
    ui.busy = false;
    if (res.ok) ui.requests = res.data;
    else ui.error = res.error;
    await refreshState();
  };
  return h(
    "div",
    { class: "page" },
    h(
      "div",
      { class: "top" },
      h("button", { type: "button", class: "icon-btn", "aria-label": t("back"), onclick: () => ((ui.requestsLater = true), render()) }, icon("back")),
      h("h1", {}, t("loginRequestTitle")),
    ),
    ...(r
      ? [
          h("p", { class: "caption" }, t("loginRequestQuestion", s.email ?? "")),
          h("div", { class: "field" }, h("label", {}, h("span", {}, t("fingerprintPhrase")), h("output", { class: "phrase" }, r.fingerprint))),
          h("div", { class: "group" }, row(r.device, t("loginRequestDevice")), row(r.ip, t("loginRequestIp")), row(when(r.createdAt), t("loginRequestTime"))),
        ]
      : []),
    errorBox(),
    busyBar(),
    r
      ? h(
          "div",
          { class: "actions" },
          h("button", { type: "button", class: "btn filled wide", disabled: ui.busy, onclick: answer(true) }, t("confirmLogin")),
          h("button", { type: "button", class: "btn text", disabled: ui.busy, onclick: answer(false) }, t("denyLogin")),
        )
      : null,
  );
}

async function loadRequests(): Promise<void> {
  ui.busy = true;
  const res = await send<LoginRequest[]>({ type: "loginRequests" });
  ui.busy = false;
  if (res.ok) ui.requests = res.data;
  else ((ui.error = res.error), (ui.requests = []));
  await refreshState();
}

async function refreshState(): Promise<void> {
  await stateRequest({ type: "getState" });
  render();
}

// WebAuthn runs in the server's webauthn-connector.html (the credential is bound to the server's
// origin, which an extension page cannot claim). It reports back with postMessage "success|<json>".
let webauthnFrame: HTMLIFrameElement | undefined;
const b64 = (s: string) => new TextEncoder().encode(s).toBase64();

function webauthnBox(s: State): Child {
  if (ui.busy) return null;
  if (ui.webauthnPaused || !s.twoFactor?.webauthn || !s.serverUrl) {
    webauthnFrame = undefined;
    return h("button", { type: "button", class: "btn tonal wide", onclick: () => ((ui.webauthnPaused = false), (ui.error = undefined), render()) }, icon("key"), t("useSecurityKey"));
  }
  const options = JSON.parse(s.twoFactor.webauthn) as { extensions?: { appid?: string } };
  // The legacy U2F appid must be https; browsers reject the whole request otherwise (plain-http servers).
  if (!s.serverUrl.startsWith("https:")) delete options.extensions?.appid;
  const data = JSON.stringify({ data: JSON.stringify(options), headerText: "", btnText: t("useSecurityKey"), btnReturnText: "" });
  const params = new URLSearchParams({ data: b64(data), parent: location.href, v: "2" });
  webauthnFrame = h("iframe", {
    class: "webauthn",
    title: t("providerWebAuthn"),
    // The server's page gets no top navigation: one click in it must not swap this window for a page of the
    // server's that asks for the master password (the official clients sandbox the connector the same way).
    sandbox: "allow-scripts allow-same-origin",
    allow: "publickey-credentials-get *",
    src: `${s.serverUrl}/webauthn-connector.html?${params}`,
  });
  return h(
    "div",
    { class: "actions" },
    webauthnFrame,
    // The OS security-key dialog takes focus, which closes the action popup; a tab survives it.
    inPanel ? null : h("button", { type: "button", class: "btn text", onclick: () => void chrome.tabs.create({ url: location.href }) }, t("openInTab")),
  );
}

window.addEventListener("message", (ev: MessageEvent) => {
  if (!webauthnFrame || ev.source !== webauthnFrame.contentWindow || typeof ev.data !== "string") return;
  if (!state?.serverUrl || ev.origin !== new URL(state.serverUrl).origin) return;
  const [kind, ...rest] = ev.data.split("|");
  if (kind === "success") void submitWebAuthn(rest.join("|"));
  else if (kind === "error") {
    ui.webauthnPaused = true;
    ui.error = rest.join("|");
    render();
  }
});

async function submitWebAuthn(token: string) {
  webauthnFrame = undefined;
  if (await act({ type: "twoFactorSubmit", provider: TWO_FACTOR.WebAuthn, token, remember: draft.remember }, t("busyVerifying"))) return;
  // A failed attempt makes the server issue a new challenge; pick it up before the next try.
  await stateRequest({ type: "getState" });
  ui.webauthnPaused = true;
  render();
}

function twoFactorView(s: State): HTMLElement {
  const offered = s.twoFactor?.providers ?? [];
  const duo = s.twoFactor?.duo?.provider;
  const supported: number[] = [TWO_FACTOR.Authenticator, TWO_FACTOR.Email, TWO_FACTOR.YubiKey, TWO_FACTOR.WebAuthn, TWO_FACTOR.Duo, TWO_FACTOR.OrganizationDuo].filter(
    (p) => offered.includes(p) && (p !== TWO_FACTOR.WebAuthn || !!s.twoFactor?.webauthn) && ((p !== TWO_FACTOR.Duo && p !== TWO_FACTOR.OrganizationDuo) || p === duo),
  );
  if (ui.provider === undefined || !supported.includes(ui.provider)) ui.provider = supported[0];
  const typed = supported.length > 0 && ui.provider !== TWO_FACTOR.WebAuthn && ui.provider !== duo;
  const chip = (p: number, label: string, ic: IconName) =>
    h(
      "button",
      {
        type: "button",
        class: "chip",
        "aria-pressed": String(ui.provider === p),
        disabled: ui.busy,
        onclick: () => ((ui.provider = p), render()),
      },
      icon(ic),
      label,
    );
  const onsubmit = (e: Event) => {
    e.preventDefault();
    if (ui.provider === undefined) return;
    const token = draft.code;
    draft.code = "";
    void act({ type: "twoFactorSubmit", provider: ui.provider, token, remember: draft.remember }, t("busyVerifying"));
  };
  const remember = h("input", {
    type: "checkbox",
    checked: draft.remember,
    id: "remember",
    onchange: (e: Event) => (draft.remember = (e.target as HTMLInputElement).checked),
  });
  return h(
    "form",
    { class: "page", onsubmit },
    h(
      "div",
      { class: "top" },
      h("button", { type: "button", class: "icon-btn", "aria-label": t("back"), onclick: () => void act({ type: "twoFactorCancel" }) }, icon("back")),
      h("h1", {}, t("twoFactorTitle")),
    ),
    h("p", { class: "caption" }, t("twoFactorSubtitle", s.email ?? "")),
    supported.length
      ? h(
          "div",
          { class: "chips segmented", role: "group", "aria-label": t("twoFactorMethod") },
          offered.includes(TWO_FACTOR.Authenticator) ? chip(TWO_FACTOR.Authenticator, t("providerAuthenticator"), "phone") : null,
          offered.includes(TWO_FACTOR.Email) ? chip(TWO_FACTOR.Email, t("providerEmail"), "mail") : null,
          offered.includes(TWO_FACTOR.YubiKey) ? chip(TWO_FACTOR.YubiKey, t("providerYubiKey"), "key") : null,
          supported.includes(TWO_FACTOR.WebAuthn) ? chip(TWO_FACTOR.WebAuthn, t("providerWebAuthn"), "key") : null,
          duo !== undefined && supported.includes(duo) ? chip(duo, t("providerDuo"), "shield") : null,
        )
      : h("div", { class: "error" }, icon("error"), h("div", {}, t("twoFactorUnsupported"))),
    ui.provider === TWO_FACTOR.Email
      ? h(
          "button",
          {
            type: "button",
            class: "btn tonal wide",
            disabled: ui.busy,
            onclick: async () => {
              if (await act({ type: "twoFactorSendEmail" }, t("busySendingEmail"))) {
                ui.info = t("emailSent", s.twoFactor?.emailHint ?? s.email ?? "");
                render();
              }
            },
          },
          icon("mail"),
          t("sendEmailCode", s.twoFactor?.emailHint ?? ""),
        )
      : null,
    ui.info ? h("p", { class: "note", role: "status" }, ui.info) : null,
    ui.provider === TWO_FACTOR.WebAuthn ? webauthnBox(s) : null,
    ui.provider === TWO_FACTOR.YubiKey ? h("p", { class: "note" }, t("yubiKeyHint")) : null,
    duo !== undefined && ui.provider === duo
      ? h(
          "div",
          { class: "stack" },
          h("p", { class: "note" }, t("duoHint")),
          h("button", { type: "button", class: "btn filled wide", disabled: ui.busy, onclick: () => void act({ type: "twoFactorDuo", remember: draft.remember }) }, icon("external"), t("launchDuo")),
        )
      : null,
    typed
      ? field({
          label: t("verificationCode"),
          extraClass: ui.provider === TWO_FACTOR.YubiKey ? undefined : "code",
          // A YubiKey OTP is 44 modhex letters typed by the key itself.
          input: bound(
            "code",
            ui.provider === TWO_FACTOR.YubiKey
              ? { autocomplete: "off", spellcheck: false, required: true, "data-autofocus": "1" }
              : { inputMode: "numeric", autocomplete: "one-time-code", required: true, "data-autofocus": "1" },
          ),
        })
      : null,
    supported.length
      ? h("label", { class: "check check-card", for: "remember" }, h("div", { class: "body" }, t("rememberDevice")), h("span", { class: "switch" }, remember, h("span")))
      : null,
    errorBox(),
    busyBar(),
    typed ? submitButton(t("continue")) : null,
  );
}

async function setupBiometric(): Promise<void> {
  const email = state?.email;
  if (!email) return;
  Object.assign(ui, { busy: true, busyLabel: t("busyBiometric"), error: undefined, info: undefined });
  render();
  try {
    const credential = await createBiometricCredential(email);
    if (await act({ type: "setBiometric", ...credential })) {
      ui.info = t("biometricEnabled");
      render();
    }
  } catch (e) {
    Object.assign(ui, { busy: false, busyLabel: undefined, error: (e as Error).message });
    render();
  }
}

async function disableBiometric(): Promise<void> {
  if (await act({ type: "removeBiometric" })) {
    ui.info = t("biometricRemoved");
    render();
  }
}

/** Locked screen: biometric assertion, then the PRF-wrapped user key in the crypto worker. */
async function unlockBiometric(bio: { credentialId: string; prfSalt: string }): Promise<void> {
  Object.assign(ui, { busy: true, busyLabel: t("busyVerifying"), error: undefined, info: undefined });
  render();
  try {
    const prf = await getBiometricPrf(bio.credentialId, bio.prfSalt);
    await act({ type: "unlockBiometric", prf });
  } catch (e) {
    Object.assign(ui, { busy: false, busyLabel: undefined, error: (e as Error).message });
    render();
  }
}

function lockedView(s: State): HTMLElement {
  const withPin = !!s.pinUnlock && !ui.usePassword;
  const onsubmit = (e: Event) => {
    e.preventDefault();
    const [password, pin] = [draft.password, draft.pin];
    draft.password = draft.pin = "";
    void act(withPin ? { type: "unlockPin", pin } : { type: "unlock", password }, t("busyUnlocking"));
  };
  const pinField = () =>
    field({ label: t("pin"), input: bound("pin", { type: "password", autocomplete: "off", required: true, spellcheck: false, "data-autofocus": "1" }) });
  const switchMethod = s.pinUnlock
    ? h("button", { type: "button", class: "btn text", disabled: ui.busy, onclick: () => ((ui.usePassword = !ui.usePassword), (ui.error = undefined), render()) }, t(withPin ? "useMasterPassword" : "usePin"))
    : null;
  return h(
    "form",
    { class: "page center", onsubmit },
    h(
      "div",
      { class: "brand" },
      h("div", { class: "logo" }, icon("lock")),
      h("h1", {}, t("lockedTitle")),
      h("p", {}, s.email ?? ""),
      h("p", { class: "host" }, host(s.serverUrl)),
    ),
    s.biometric
      ? h(
          "div",
          { class: "actions" },
          h(
            "button",
            { type: "button", class: "btn tonal wide", disabled: ui.busy, onclick: () => void unlockBiometric(s.biometric!) },
            icon("fingerprint"),
            t("unlockWithBiometrics"),
          ),
          !inPanel && !inTab
            ? h("button", { type: "button", class: "btn text", disabled: ui.busy, onclick: () => void chrome.tabs.create({ url: location.href }) }, t("openInTab"))
            : null,
        )
      : null,
    withPin ? pinField() : passwordField("current-password"),
    errorBox(),
    busyBar(),
    h(
      "div",
      { class: "actions" },
      submitButton(t("unlock")),
      switchMethod,
    ),
    // Leaving the account is not an unlock method: set apart and quieter.
    h("div", { class: "actions apart" }, h("button", { type: "button", class: "btn text small quiet", disabled: ui.busy, onclick: () => void act({ type: "logout" }) }, t("logOut"))),
  );
}

function navButton(tab: Ui["tab"], label: string, ic: IconName) {
  return h(
    "button",
    {
      type: "button",
      "aria-current": ui.tab === tab ? "page" : undefined,
      onclick: () => {
        ui.tab = tab;
        ui.pinSetup = false;
        ui.settingsQuery = undefined;
        // The "On this site" matches depend on settings edited in another tab; refresh on return.
        if (tab === "vault") void refreshPageMatches().then(render, render);
        else render();
      },
    },
    h("span", { class: "pill" }, icon(ic)),
    h("span", { class: "label" }, label),
  );
}

function row(title: string, sub?: string, trailing?: Child, extra: Record<string, unknown> = {}, tag: "div" | "button" = "div") {
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

function settingsTab(s: State): HTMLElement {
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
    h("span", { class: "switch" }, h("input", { type: "checkbox", checked, "aria-label": label, onchange: (e: Event) => onchange(e.target as HTMLInputElement) }), h("span"));
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
      // Logging out drops the local vault and asks for the password again: one stray click must not do it.
      row(ui.armLogout ? t("confirmLogOut") : t("logOut"), undefined, icon("logout"), {
        type: "button",
        class: "row danger",
        onclick: () => {
          // Disarmed on use, so the next session starts unarmed (ui outlives a logout).
          if (ui.armLogout) return void ((ui.armLogout = false), act({ type: "logout" }));
          ui.armLogout = true;
          render();
          setTimeout(() => ui.armLogout && ((ui.armLogout = false), render()), 4000);
        },
      }, "button"),
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
      row(t("lockOnSystemLock"), undefined, h("span", { class: "switch" }, sysLock, h("span"))),
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

function unlockedView(s: State): DocumentFragment {
  // Detail screens (item, editor, folders, passkey approval) drop the tab bar: they are a
  // drill-down with their own back action, exactly like the reference app.
  const detail = !!passkeyRequestId || (ui.tab === "vault" && vaultRouteKey() !== "list");
  const frag = document.createDocumentFragment();
  frag.append(
    ...[
      ui.tab === "settings" ? settingsTab(s) : ui.tab === "generator" ? generatorScreen(vaultCtx) : ui.tab === "send" ? sendScreen(vaultCtx) : vaultScreen(vaultCtx),
      detail
        ? null
        : h(
            "nav",
            { class: "nav", "aria-label": t("navigation") },
            navButton("vault", t("vault"), "home"),
            navButton("generator", t("generator"), "generator"),
            navButton("send", t("send"), "send"),
            navButton("settings", t("settings"), "settings"),
          ),
      toastEl() || "",
    ].filter((x): x is Exclude<typeof x, null> => x !== null),
  );
  return frag;
}

// ---------- render ----------

/** The child-index chain from #app down to `el`, with its tag, for finding "the same" control after a re-render. */
function pathOf(el: Element | null): { steps: number[]; tag: string } | undefined {
  if (!el || el === document.body || !app.contains(el)) return;
  const steps: number[] = [];
  for (let at: Element = el; at !== app; at = at.parentElement!) steps.unshift([...at.parentElement!.children].indexOf(at));
  return { steps, tag: el.tagName };
}
function atPath(p: { steps: number[]; tag: string }): HTMLElement | null {
  let at: Element | undefined = app;
  for (const i of p.steps) at = at?.children[i];
  return at?.tagName === p.tag && (at as HTMLElement).tabIndex >= 0 ? (at as HTMLElement) : null;
}

const app = document.getElementById("app")!;
const vaultCtx: Ctx = {
  rerender: () => render(),
  lock: () => void act({ type: "lock" }),
  email: () => state?.email,
  settings: () => state?.settings,
  goto: (tab, settingsQuery) => {
    ui.tab = tab;
    ui.settingsQuery = settingsQuery;
    render();
  },
  afterRender: (fn) => (swapPending ? afterSwap.push(fn) : fn()),
  shareAsSend: (text) => {
    startTextSend(text);
    ui.tab = "send";
    render();
  },
};
let firstRender = true;

/**
 * One scroll position per screen, so coming back from an item lands where the user left. Besides the offset it keeps a
 * row (`data-item`: the focused one in view, else the first in view) and where it sat in the viewport: rows can change
 * height between renders (off-screen rows have an estimated one, popup.css; the item just opened joins "Recently
 * opened"), so that row is put back exactly and the offset is only the fallback.
 */
const scrollMemory = new Map<string, { y: number; anchor?: { id: string; top: number; y: number } }>();

function scrollAnchor(): { id: string; top: number; y: number } | undefined {
  if (!window.scrollY) return undefined; // at the top the screen stays at the top
  const at = (el: HTMLElement) => ({ id: el.dataset.item!, top: el.getBoundingClientRect().top, y: el.getBoundingClientRect().top + window.scrollY });
  const inView = (el: HTMLElement) => { const b = el.getBoundingClientRect(); return b.bottom > 0 && b.top < innerHeight; };
  const active = document.activeElement as HTMLElement | null;
  if (active?.dataset.item && inView(active)) return at(active);
  for (const el of app.querySelectorAll<HTMLElement>("[data-item]")) if (el.getBoundingClientRect().top >= 0) return at(el);
  return undefined;
}

function restoreScroll(key: string) {
  const mem = scrollMemory.get(key);
  window.scrollTo(0, mem?.y ?? 0);
  const a = mem?.anchor;
  if (!a) return;
  // The copy nearest its old place, when an item is listed twice (a favorite, a recent one).
  let best: HTMLElement | undefined;
  let gap = Infinity;
  for (const el of app.querySelectorAll<HTMLElement>(`[data-item="${CSS.escape(a.id)}"]`)) {
    const d = Math.abs(el.getBoundingClientRect().top + window.scrollY - a.y);
    if (d < gap) [best, gap] = [el, d];
  }
  if (best) window.scrollTo(0, best.getBoundingClientRect().top + window.scrollY - a.top);
}
let lastScreen = "";

function screenKey(): string {
  if (!state) return "boot";
  if (state.phase === "setup" || ui.editServer) return "setup";
  if (state.phase !== "unlocked") return state.phase;
  if (passkeyRequestId) return "passkey";
  if (state.loginRequests && !ui.requestsLater) return "loginRequest";
  return ui.tab === "vault" ? `vault:${vaultRouteKey()}` : ui.tab;
}

let renderSeq = 0;
/** A screen change is waiting for its transition frame; what must run on its DOM waits with it (Ctx.afterRender). */
let swapPending = false;
const afterSwap: (() => void)[] = [];
function render(): void {
  if (!state) return;
  const s = state;
  if (s.phase !== "twoFactor") ui.webauthnPaused = false;
  setIconBase(s.settings.favicons && s.serverUrl ? `${s.serverUrl}/icons` : undefined);
  if (s.phase !== "unlocked") {
    ui.tab = "vault"; // a new session always starts on the vault
    resetVault(); // and holds no decrypted data from the previous one
    resetSend();
    resetPasskey(); // nor a master password typed for a passkey request
    scrollMemory.clear(); // a locked or logged-out screen never restores a vault position
    ui.requests = undefined;
  }
  let view: Node;
  if (s.phase === "setup" || ui.editServer) view = setupView();
  else if (s.phase === "loggedOut") view = loginView();
  else if (s.phase === "twoFactor") view = twoFactorView(s);
  else if (s.phase === "deviceLogin") view = deviceLoginView(s);
  else if (s.phase === "locked") view = lockedView(s);
  else if (passkeyRequestId) view = passkeyScreen(vaultCtx);
  else if (s.loginRequests && !ui.requestsLater) view = loginRequestView(s);
  else view = unlockedView(s);

  const key = screenKey();
  const seq = ++renderSeq;
  const swap = () => {
    // A newer render (a lock, say) already replaced the screen: this one must not land on top of it.
    if (seq !== renderSeq) return;
    if (lastScreen) scrollMemory.set(lastScreen, { y: window.scrollY, anchor: scrollAnchor() });
    const focused = document.activeElement?.id;
    // A control without an id (copy, reveal, ±, a switch) is found again by where it sat, on the same screen only,
    // so a keyboard user is not thrown back to the top after every in-place action.
    const path = !focused && lastScreen === key ? pathOf(document.activeElement) : undefined;
    // A sideways chip row keeps its position on the same screen (picking a chip re-renders it).
    const chipsLeft = lastScreen === key ? app.querySelector(".chips.scroll")?.scrollLeft : undefined;
    app.replaceChildren(view);
    // Classes instead of :has() on html/#app, which made every DOM change re-check the whole list (popup.css).
    document.documentElement.classList.toggle("centered", !!app.querySelector(".page.center"));
    app.classList.toggle("has-nav", !!app.querySelector(":scope > .nav"));
    const chips = app.querySelector(".chips.scroll");
    if (chips && chipsLeft) chips.scrollLeft = chipsLeft;
    const again = focused ? document.getElementById(focused) : path ? atPath(path) : null;
    // A new screen without a field to type in: its heading takes focus, so a screen reader announces where it is.
    const heading = lastScreen !== key ? app.querySelector<HTMLElement>("h1") : null;
    heading?.setAttribute("tabindex", "-1");
    ((again ?? app.querySelector("[data-autofocus]") ?? heading) as HTMLElement | null)?.focus({ preventScroll: true });
    restoreScroll(key);
    lastScreen = key;
    swapPending = false;
    for (const fn of afterSwap.splice(0)) fn();
  };
  const nav = navMotion(lastScreen, key);
  if (!nav || !document.startViewTransition || motionOff()) swap();
  else {
    document.documentElement.dataset.nav = nav;
    swapPending = true;
    // A newer screen change skips this one; its swap still runs (and steps aside if stale), only the animation is dropped.
    document.startViewTransition(swap).ready.catch(() => {});
  }
  if (firstRender) {
    firstRender = false;
    performance.mark("warren:first-render");
  }
}

// Escape on a sub-screen (item, editor, a Send form) goes back, as its top-left button does; the editor's own
// unsaved-changes check still applies. An open menu takes the Escape itself, and a search box clears first.
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || e.defaultPrevented || document.querySelector(":popover-open")) return;
  const back = app.querySelector<HTMLElement>(".top > button.icon-btn:first-child");
  if (!back) return;
  e.preventDefault();
  back.click();
});

// "/" jumps to the screen's search box (vault, settings), as on most sites with one; typing in a field is left alone.
document.addEventListener("keydown", (e) => {
  if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
  const target = e.target as HTMLElement | null;
  if (target?.closest("input, textarea, select, [contenteditable]")) return;
  const search = app.querySelector<HTMLInputElement>("input[type=search]");
  if (!search) return;
  e.preventDefault();
  search.focus();
  search.select();
});

// Test-only hook for tools/smoke-biometric.mjs (no Vaultwarden needed); compiled out of releases.
declare const E2E: boolean;
if (typeof E2E !== "undefined" && E2E) Object.assign(globalThis, { warrenBiometric: { createBiometricCredential, getBiometricPrf, platformAuthenticatorAvailable } });

// Fetched up front so the side panel button can call sidePanel.open synchronously in its click.
let windowId: number | undefined;
if (!inPanel) void chrome.windows.getCurrent().then((w) => (windowId = w.id));
// `getCurrent()` is undefined in the action popup: only there can the system prompt close the window.
let inTab = true;
if (!inPanel)
  void chrome.tabs.getCurrent().then((tab) => {
    inTab = !!tab;
    render();
  });

// The full weak-word list for the strength labels, after the first paint (the inline menu never needs it).
requestIdleCallback(() => void loadCommonWords(), { timeout: 500 });

void stateRequest({ type: "getState" }).then((res) => {
  if (!res.ok) {
    state = {
      phase: "setup",
      settings: {
        autoLockMinutes: 15, timeoutAction: "lock", lockOnSystemLock: true, inlineMenu: true, savePrompt: true, neverSave: [], blocked: [],
        defaultManager: false, favicons: false, autoCopyTotp: true, defaultUriMatch: 0, clearClipboardDelay: "oneMinute",
        autofillOnPageLoad: false, autofillOnPageLoadDefault: true, autosubmit: false, inlineMenuCards: true, inlineMenuIdentities: true, contextMenu: true,
        showCardsOnTab: true, showIdentitiesOnTab: true, quickActionMenus: false, badgeCounter: true,
      },
    };
    ui.error = res.error;
  }
  draft.email = state?.email ?? "";
  ui.error ??= state?.ssoError;
  render();
});

/**
 * The worker owns the session (auto-lock, a lock from another window): follow it. Without this an open
 * side panel would keep showing decrypted item names after the vault locked.
 */
chrome.storage.onChanged.addListener((changes, area) => {
  // A push sync stored a newer vault: the open list follows (a sync this popup started updates it itself).
  const vault = area === "local" ? changes.vault : undefined;
  if (vault && state?.phase === "unlocked" && (vault.newValue as { revision?: number } | undefined)?.revision !== (vault.oldValue as { revision?: number } | undefined)?.revision)
    void reloadList();
  if (area !== "session" || !changes.session || !state) return;
  const next = changes.session.newValue as { unlocked?: unknown; loginRequests?: unknown[] } | undefined;
  // A real lock while this screen already shows one (an unlock still in flight): the answers asked before it are stale.
  if ((changes.session.oldValue as { unlocked?: unknown } | undefined)?.unlocked === true && next?.unlocked === false && state.phase !== "unlocked") newSession();
  // A login request pushed while the popup is open shows at once.
  const requestsChanged = (next?.loginRequests?.length ?? 0) !== (state.loginRequests ?? 0);
  // loggedOut -> locked (SSO finished in another tab) leaves `unlocked` false, so a logged-out view always refreshes.
  if (!requestsChanged && (typeof next?.unlocked !== "boolean" || (next.unlocked === (state.phase === "unlocked") && state.phase !== "loggedOut"))) return;
  // A lock applies at once (the render drops the decrypted view); the state asked for then fills in the rest.
  if (next?.unlocked === false && state.phase === "unlocked") {
    setState({ ...state, phase: "locked" });
    render();
  }
  // Applies unless setState finds the screen has moved past it since it was asked.
  void stateRequest({ type: "getState" }).then((r) => r.ok && render());
});
