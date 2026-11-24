// Popup. Talks only to the service worker through the typed message bus: no crypto, no network.
import { TWO_FACTOR, URI_MATCH_ADVANCED } from "../shared/constants.ts";
import type { ExportFormat, LoginRequest, Request, Response, State } from "../shared/messages.ts";
import { normalizeServerUrl } from "../shared/url.ts";
import { type Child, h, inPanel, motionOff, newSession, send, sessionNow, t, when, switchOf } from "./dom.ts";
import { icon, type IconName } from "./icons.ts";
import { createBiometricCredential, getBiometricPrf, platformAuthenticatorAvailable } from "./biometric.ts";
import { passkeyRequestId, passkeyScreen, resetPasskey } from "./passkey.ts";
import { resetSend, sendScreen, startTextSend } from "./send.ts";
import { generatorScreen } from "./generator.ts";
import { navMotion } from "./motion.ts";
import { loadCommonWords } from "../shared/strength.ts";
import { vaultScreen } from "./vault.ts";
import { row, settingsTab } from "./settings.ts";
import { closeEmergency, emergencyOpen, emergencyScreen } from "./emergency.ts";
import { uriMatchLabel } from "./vault-edit.ts";
import { type Ctx, refreshPageMatches, reloadList, resetVault, setIconBase, toastEl, vaultRouteKey } from "./vault-shared.ts";

// ---------- state ----------

export interface Ui {
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

export const draft = { server: "", email: "", password: "", code: "", pin: "", remember: false, filePassword: "" };
export const ui: Ui = { busy: false, tab: "vault", editServer: false, reveal: false };
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
    closeEmergency(); // a grantor's items and a typed takeover password belong to the session that ended
  }
  else if (state && state.phase !== "unlocked" && open) unlocks++;
  state = next;
}

/** A request answered with a State, applied through setState. */
export async function stateRequest(req: Request): Promise<Response<State>> {
  const asked = { locks: sessionNow(), unlocks };
  const res = await send<State>(req, true);
  if (res.ok) setState(res.data, asked);
  return res;
}

export async function act(req: Request, busyLabel?: string): Promise<boolean> {
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

export const host = (url?: string) => (url ? new URL(url).host : "");

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

export function errorBox(): Child {
  return ui.error ? h("div", { class: "error", role: "alert" }, icon("error"), h("div", {}, ui.error)) : null;
}

export function busyBar(): Child {
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
      ? h("label", { class: "check check-card", for: "remember" }, h("div", { class: "body" }, t("rememberDevice")), switchOf(remember))
      : null,
    errorBox(),
    busyBar(),
    typed ? submitButton(t("continue")) : null,
  );
}

export async function setupBiometric(): Promise<void> {
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

export async function disableBiometric(): Promise<void> {
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
    h("div", { class: "actions apart" }, h("button", { type: "button", class: "btn text small quiet", disabled: ui.busy, onclick: armedLogout }, ui.armLogout ? t("confirmLogOut") : t("logOut"))),
  );
}

/** Logging out drops the local vault, PIN and biometric setup: one stray click must not do it, so it takes two. */
export function armedLogout() {
  // Disarmed on use, so the next session starts unarmed (ui outlives a logout).
  if (ui.armLogout) return void ((ui.armLogout = false), act({ type: "logout" }));
  ui.armLogout = true;
  render();
  setTimeout(() => ui.armLogout && ((ui.armLogout = false), render()), 4000);
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


function unlockedView(s: State): DocumentFragment {
  // Detail screens (item, editor, folders, passkey approval) drop the tab bar: they are a
  // drill-down with their own back action, exactly like the reference app.
  const detail = !!passkeyRequestId || (ui.tab === "vault" && vaultRouteKey() !== "list");
  const frag = document.createDocumentFragment();
  frag.append(
    ...[
      ui.tab === "settings" ? (emergencyOpen() ? emergencyScreen(vaultCtx) : settingsTab(s)) : ui.tab === "generator" ? generatorScreen(vaultCtx) : ui.tab === "send" ? sendScreen(vaultCtx) : vaultScreen(vaultCtx),
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
export function render(): void {
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
export let windowId: number | undefined;
if (!inPanel) void chrome.windows.getCurrent().then((w) => (windowId = w.id));
// `getCurrent()` is undefined in the action popup: only there can the system prompt close the window.
export let inTab = true;
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
        autofillOnPageLoad: false, autofillOnPageLoadDefault: true, autosubmit: false, inlineMenuCards: true, inlineMenuIdentities: true, signupUsernames: "private", contextMenu: true,
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
  // The stored vault changed: a push sync (new revision) or an item saved anywhere. A sync that found nothing new
  // only writes `syncedAt`. Also refreshes this site's matches.
  if (area === "local" && changes.vault && state?.phase === "unlocked") void reloadList();
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
  void stateRequest({ type: "getState", passive: true }).then((r) => r.ok && render());
});
