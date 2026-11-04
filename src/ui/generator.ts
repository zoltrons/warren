// Generator tab: password / passphrase / PIN / username, forwarded email aliases, and the history screen.
// Own state (`gst`); the vault screens only reach it through `resetGenerator`, `startGeneratorPick` and `generatorScreen`.
import {
  ALIAS_INFO,
  ALIAS_VENDORS,
  type AliasField,
  type AliasSettings,
  type AliasVendor,
  defaultAliasSettings,
  missingAliasFields,
} from "../shared/alias.ts";
import type { HistoryEntry } from "../shared/messages.ts";
import { type Child, h, send, t, when, withChevron } from "./dom.ts";
import { icon } from "./icons.ts";
import { type FakeIdentity, fakeIdentity, type IdentityData } from "./identity-gen.ts";
import { actionRow, colorize, copy, copyButton, type Ctx, iconButton, sectionTitle, startEdit, strength, strengthBar, topBar } from "./vault.ts";

type Json = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v : "");

const GEN_DEFAULTS: Json = {
  type: "password", length: 20, lowercase: true, uppercase: true, numbers: true, special: true, avoidAmbiguous: false, minLowercase: 1, minUppercase: 1, minNumber: 2, minSpecial: 2,
  numWords: 5, wordSeparator: "-", capitalize: true, includeNumber: true, pinLength: 4,
  usernameType: "word", email: "", domain: "", aliasVendor: "simplelogin", identityMinAge: 18, identityMaxAge: 65, identityCountry: "",
};

/** Names and cities per country, fetched the first time the identity generator opens (about 50 KB). */
let identityData: Promise<IdentityData> | undefined;
const loadIdentityData = () =>
  (identityData ??= fetch("identity-data.json").then((r) => {
    if (!r.ok) throw new Error(`identity-data.json: ${r.status}`);
    return r.json() as Promise<IdentityData>;
  }).catch((e: unknown) => {
    identityData = undefined; // a later visit tries again
    throw e;
  }));
/** Digits and symbols scale with the length, about one in ten and never below one (20 → 2, 40 → 4). */
const scaledMin = (length: number) => Math.max(1, Math.round(length / 10));
const SEPARATORS = [["-", "sepHyphen"], [" ", "sepSpace"], [".", "sepPeriod"], [",", "sepComma"], ["_", "sepUnderscore"], ["", "sepNone"]] as const;
// Clear-text keys of older builds, moved into the encrypted store once (loadPrefs).
const LEGACY_OPTIONS = "genOptions";
const LEGACY_WORDLIST = "genWordlist";

interface GeneratorPrefs {
  options: Json;
  email: string;
  domain: string;
  /** Words in the custom passphrase list (0: the built-in list). The list itself stays in the service worker. */
  wordlist: number;
}

function legacy(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // no storage in framed pages
  }
}

/**
 * The generator's options, address and word list are kept encrypted by the service worker (they tell how the
 * user's passwords are built), so they are read once per visit; what an older build left in localStorage moves over.
 */
async function loadPrefs(ctx: Ctx) {
  gst.prefs = "loading";
  const r = await send<GeneratorPrefs>({ type: "generatorPrefs" });
  if (!r.ok || !r.data) return ((gst.prefs = undefined), (gst.error = r.ok ? undefined : r.error), ctx.rerender());
  let prefs = r.data;
  const oldOptions = legacy(LEGACY_OPTIONS);
  const oldWords = legacy(LEGACY_WORDLIST);
  if (oldOptions !== null || oldWords !== null) {
    let old: Json = {};
    try {
      const v = JSON.parse(oldOptions ?? "null");
      if (v && typeof v === "object" && !Array.isArray(v)) old = v as Json;
    } catch {
      /* damaged: dropped */
    }
    const { email, domain, ...options } = old;
    const moved = await send<GeneratorPrefs>({ type: "setGeneratorPrefs", options: { ...options, ...prefs.options }, email: prefs.email || str(email), domain: prefs.domain || str(domain) });
    const words = oldWords && !prefs.wordlist ? await send<GeneratorPrefs>({ type: "setWordlist", text: oldWords }) : undefined;
    // The clear-text copies go only once the encrypted ones are written.
    if (moved.ok && (!words || words.ok)) {
      prefs = (words?.ok ? words.data : moved.data) ?? prefs;
      try {
        localStorage.removeItem(LEGACY_OPTIONS);
        localStorage.removeItem(LEGACY_WORDLIST);
      } catch {
        /* no storage */
      }
    }
  }
  gst.gen = { ...GEN_DEFAULTS, ...prefs.options, email: prefs.email, domain: prefs.domain };
  if (gst.pickType) gst.gen.type = gst.pickType;
  gst.pickType = undefined;
  // Saved minimums below what the length calls for (older builds kept 1 at any length) are raised.
  const scaled = scaledMin(Number(gst.gen.length));
  for (const k of ["minNumber", "minSpecial"]) gst.gen[k] = Math.max(Number(gst.gen[k]) || 0, scaled);
  gst.wordlist = prefs.wordlist;
  gst.prefs = "loaded";
  void regenerate(ctx);
}

/** One word per line; empty lines and lines starting with # ; - / are comments. */
function parseWordlist(text: string): string[] {
  const words = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const w = line.trim();
    if (w && w.length <= 24 && !/^[#;\-/]/.test(w)) words.add(w);
  }
  return [...words].slice(0, 100_000);
}

/** What the worker gets; the service worker adds the custom word list for a passphrase. */
function genOptions(): Json {
  const { email: _email, domain: _domain, ...o } = gst.gen;
  if (o.type === "pin") o.length = o.pinLength;
  if (o.type === "username") Object.assign(o, { email: gst.gen.email, domain: gst.gen.domain });
  return o;
}

const gst = {
  gen: { ...GEN_DEFAULTS } as Json,
  /** The encrypted options: being read, or read for this visit. Nothing is generated before. */
  prefs: undefined as "loading" | "loaded" | undefined,
  /** Words in the custom passphrase list (0: built-in). */
  wordlist: 0,
  generated: "",
  /** The fake identity on screen (type "identity"); `generated` holds its full name. */
  identity: undefined as FakeIdentity | undefined,
  /** [code, name] of the countries the identity generator knows, once its data is loaded. */
  identityCountries: [] as [string, string][],
  /** Forwarded email alias settings for the service selected in the generator (kept by the worker). */
  alias: undefined as AliasSettings | undefined,
  /** Which service's settings are being read right now (a switch mid-flight must not land). */
  aliasLoadingFor: undefined as AliasVendor | undefined,
  /** An alias request is in flight: a double-click must not create two addresses. */
  aliasBusy: false,
  /** Ready-made password variants shown under the generator. */
  suggestions: [] as string[],
  /** Generator history screen, while open. */
  history: undefined as HistoryEntry[] | undefined,
  error: undefined as string | undefined,
  /** "Custom" was picked in the passphrase separator list (kept even while the typed value matches a preset). */
  customSeparator: false,
  /** The type a field's generator opened on before the saved options arrived (see startGeneratorPick). */
  pickType: undefined as string | undefined,
  /** The password options' "Minimum counts" section is expanded. */
  minimumsOpen: false,
};

export function resetGenerator(): void {
  Object.assign(gst, { gen: { ...GEN_DEFAULTS }, prefs: undefined, wordlist: 0, generated: "", identity: undefined, suggestions: [], history: undefined, alias: undefined, aliasLoadingFor: undefined, aliasBusy: false, error: undefined, customSeparator: false, pickType: undefined });
}

/** The edit form's generator: which field it fills, and how the value gets back to the form. */
export interface GeneratorPick {
  field: "password" | "username";
  use(value: string): void;
  /** Username only: keep the value in a custom field instead, which fills the page field of that name. */
  addField?(name: string, value: string): void;
  back(): void;
}

/** A generated email address (an alias, a plus or catch-all address) or a plain username. */
const customFieldName = (value: string) => (value.includes("@") ? "Email" : "Username");

const PICK_TYPES = { password: ["password", "passphrase", "pin"], username: ["username", "alias"] };

/** Opens the generator on a type that fits the field, with a value made for it. */
export function startGeneratorPick(field: GeneratorPick["field"]): void {
  if (!PICK_TYPES[field].includes(str(gst.gen.type))) gst.gen.type = PICK_TYPES[field][0];
  // The saved options may still be on their way: they must not turn a username pick back into a password.
  if (gst.prefs !== "loaded") gst.pickType = str(gst.gen.type);
  Object.assign(gst, { generated: "", suggestions: [], error: undefined });
}

const errorBox = (): Child => (gst.error ? h("div", { class: "error", role: "alert" }, icon("error"), h("div", {}, gst.error)) : null);


async function regenerate(ctx: Ctx) {
  if (gst.prefs !== "loaded") return; // the saved options are not here yet
  if (gst.gen.type === "alias") {
    // Any option change or chip click lands here. It must not call the forwarding service: that
    // creates a real alias in the user's account. Only the generate / refresh buttons do (generateAliasNow).
    gst.suggestions = [];
    gst.error = undefined;
    gst.generated = "";
    ctx.rerender();
    return;
  }
  if (gst.gen.type === "identity") {
    // Made here: a made-up person is no secret, and the worker has nothing to add.
    try {
      const data = await loadIdentityData();
      if (gst.gen.type !== "identity") return;
      gst.identity = fakeIdentity(data, str(gst.gen.identityCountry), Number(gst.gen.identityMinAge) || 18, Number(gst.gen.identityMaxAge) || 65);
      Object.assign(gst, { generated: `${gst.identity.firstName} ${gst.identity.lastName}`, suggestions: [], error: undefined });
      gst.identityCountries = Object.entries(data).map(([code, c]) => [code, c.country] as [string, string]);
    } catch (e) {
      gst.error = e instanceof Error ? e.message : String(e);
    }
    ctx.rerender();
    return;
  }
  const r = await send<string>({ type: "generate", options: genOptions() });
  gst.generated = r.ok ? r.data : "";
  gst.error = r.ok ? undefined : r.error;
  gst.suggestions = [];
  ctx.rerender();
  if (!r.ok || gst.gen.type !== "password") return;
  // Three ready-made variants next to the configured one: a short site-friendly one and two long ones.
  const variants = [{ length: 16, special: false }, { length: 24 }, { length: 32 }];
  const all = await Promise.all(variants.map((v) => send<string>({ type: "generate", options: { ...genOptions(), ...v } })));
  if (gst.gen.type !== "password") return;
  gst.suggestions = all.flatMap((x) => (x.ok ? [x.data] : []));
  ctx.rerender();
}

/**
 * One alias request at a time. The answer is dropped when the user has switched service meanwhile:
 * an address from the previous service must not be shown (or saved into a login) as the new one.
 */
async function generateAliasNow(ctx: Ctx) {
  const alias = gst.alias;
  if (!alias || gst.aliasBusy || missingAliasFields(alias).length) return;
  gst.aliasBusy = true;
  try {
    const r = await send<string>({ type: "generateAlias", vendor: alias.vendor });
    if (gst.alias?.vendor !== alias.vendor) return;
    gst.generated = r.ok ? r.data : "";
    gst.error = r.ok ? undefined : r.error;
  } finally {
    gst.aliasBusy = false;
    ctx.rerender();
  }
}

/** Loads the selected service's settings from the worker once per generator visit. */
async function loadAlias(ctx: Ctx, vendor: AliasVendor) {
  gst.aliasLoadingFor = vendor;
  const r = await send<AliasSettings>({ type: "aliasSettings", vendor });
  if (gst.aliasLoadingFor !== vendor) return; // another service was selected meanwhile
  gst.aliasLoadingFor = undefined;
  if (str(gst.gen.aliasVendor) !== vendor) return;
  // Even a failed read leaves a value, so the screen does not request it again on every render.
  gst.alias = r.ok ? r.data : defaultAliasSettings(vendor);
  if (!r.ok) gst.error = r.error;
  ctx.rerender();
}

async function importWordlist(ctx: Ctx, file: File | undefined) {
  if (!file) return;
  const words = parseWordlist(await file.slice(0, 2 * 1024 * 1024).text());
  if (words.length < 100) return ((gst.error = t("wordlistTooShort")), ctx.rerender());
  const r = await send<GeneratorPrefs>({ type: "setWordlist", text: words.join("\n") });
  if (!r.ok) return ((gst.error = r.error), ctx.rerender());
  gst.wordlist = r.data.wordlist;
  gst.error = undefined;
  void regenerate(ctx);
}

async function openHistory(ctx: Ctx) {
  const r = await send<HistoryEntry[]>({ type: "generatorHistory" });
  if (r.ok) gst.history = r.data;
  else gst.error = r.error;
  ctx.rerender();
}

function historyScreen(ctx: Ctx, list: HistoryEntry[]): HTMLElement {
  const close = () => ((gst.history = undefined), ctx.rerender());
  return h(
    "div",
    { class: "page" },
    topBar(iconButton("back", t("back"), close), h("h1", { class: "grow" }, t("generatorHistory"))),
    list.length
      ? h(
          "div",
          { class: "group", role: "list" },
          ...list.map((e) =>
            h(
              "div",
              { class: "row", role: "listitem" },
              h("div", { class: "body" }, h("span", { class: "title mono" }, e.value), h("span", { class: "sub" }, when(e.date))),
              iconButton("copy", t("copyField", e.value), () => void copy(ctx, e.value)),
            ),
          ),
        )
      : h("div", { class: "empty" }, icon("timer"), h("strong", {}, t("generatorHistoryEmpty"))),
    list.length
      ? h(
          "button",
          {
            type: "button",
            class: "btn text",
            onclick: async () => ((await send({ type: "generatorHistoryClear" })).ok ? ((gst.history = []), ctx.rerender()) : undefined),
          },
          t("clear"),
        )
      : null,
    errorBox(),
  );
}

export function generatorScreen(ctx: Ctx, pick?: GeneratorPick): HTMLElement {
  if (gst.history) return historyScreen(ctx, gst.history);
  if (gst.prefs === undefined && !gst.error) void loadPrefs(ctx);
  if (gst.prefs === "loaded" && gst.gen.type !== "alias" && !gst.generated && !gst.error) void regenerate(ctx);
  const g = gst.gen;
  const set = (k: string, v: unknown) => {
    g[k] = v;
    if (k === "length") g.minNumber = g.minSpecial = scaledMin(Number(v));
    const { email, domain, ...options } = g;
    const change = k === "email" || k === "domain" ? { email: str(email), domain: str(domain) } : { options };
    void send({ type: "setGeneratorPrefs", ...change }).then((r) => {
      if (!r.ok) ((gst.error = r.error), ctx.rerender());
    });
    void regenerate(ctx);
  };
  const toggle = (k: string, label: string) =>
    h(
      "label",
      { class: "row" },
      h("div", { class: "body" }, h("span", { class: "title" }, label)),
      h("span", { class: "switch" }, h("input", { type: "checkbox", checked: g[k] === true, onchange: (e: Event) => set(k, (e.target as HTMLInputElement).checked) }), h("span")),
    );
  const slider = (k: string, label: string, min: number, max: number) => {
    // A number box, not a label: typing 64 beats dragging to it.
    const badge = h("input", {
      type: "number",
      class: "value-badge",
      min,
      max,
      value: String(g[k]),
      "aria-label": label,
      onchange: () => {
        const v = Math.round(Number(badge.value));
        set(k, Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : g[k]); // regenerate re-renders: clamped value, new minimums
      },
      onkeydown: (e: KeyboardEvent) => e.key === "Enter" && badge.blur(),
    }) as HTMLInputElement;
    const input = h("input", { type: "range", min, max, value: String(g[k]), "aria-label": label });
    // The filled part of the track is a CSS gradient driven by --fill.
    const paint = (v: number) => {
      const ratio = max === min ? 0 : (v - min) / (max - min);
      input.style.setProperty("--fill", `${Math.round(Math.min(Math.max(ratio, 0), 1) * 100)}%`);
    };
    paint(Number(g[k]));
    input.addEventListener("input", () => {
      const v = Number(input.value);
      badge.value = String(v);
      paint(v);
    });
    input.addEventListener("change", () => set(k, Number(input.value)));
    return h("div", { class: "row slider-row" }, h("div", { class: "body" }, h("span", { class: "title" }, label)), input, stepper(k, label, min, max, badge));
  };
  // −/+ for exact values: a 5–128 slider is too coarse to hit one number.
  const stepper = (k: string, label: string, min: number, max: number, badge: HTMLElement = h("span", { class: "value-badge" }, String(g[k]))) => {
    const v = Number(g[k]);
    return h(
      "span",
      { class: "stepper", role: "group", "aria-label": label },
      iconButton("remove", t("decrease", label), () => set(k, Math.max(min, v - 1)), { disabled: v <= min }),
      badge,
      iconButton("plus", t("increase", label), () => set(k, Math.min(max, v + 1)), { disabled: v >= max }),
    );
  };
  const stepRow = (k: string, label: string, min: number, max: number) =>
    h("div", { class: "row" }, h("div", { class: "body" }, h("span", { class: "title" }, label)), stepper(k, label, min, max));
  // Character sets as one row of chips; the last one switched on cannot be switched off.
  const SETS = [["uppercase", "A–Z"], ["lowercase", "a–z"], ["numbers", "0–9"], ["special", "!@#$%"]] as const;
  const onSets = SETS.filter(([k]) => g[k] === true).length;
  const setChip = ([k, label]: (typeof SETS)[number]) =>
    h("button", { type: "button", class: "chip mono", "aria-pressed": String(g[k] === true), disabled: g[k] === true && onSets === 1, onclick: () => set(k, g[k] !== true) }, label);
  g.email ||= ctx.email() ?? "";
  const chip = (type: string, label: string, key = "type") => h("button", { type: "button", class: "chip", "aria-pressed": String(g[key] === type), onclick: () => set(key, type) }, label);
  const text = (k: string, label: string, props: Record<string, unknown> = {}) =>
    h(
      "label",
      { class: "row" },
      h("div", { class: "body" }, h("span", { class: "title" }, label)),
      h("input", { ...props, value: str(g[k]), "aria-label": label, spellcheck: false, onchange: (e: Event) => set(k, (e.target as HTMLInputElement).value) }),
    );
  const custom = g.type === "passphrase" && gst.wordlist >= 100;
  // Common separators to pick from; typing one is the last resort.
  const sepCustom = gst.customSeparator || !SEPARATORS.some(([v]) => v === g.wordSeparator);
  const separatorRow = () =>
    h(
      "div",
      { class: "row" },
      h("div", { class: "body" }, h("span", { class: "title" }, t("separator"))),
      withChevron(
        h(
          "select",
          {
            "aria-label": t("separator"),
            onchange: (e: Event) => {
              const v = (e.target as HTMLSelectElement).value;
              gst.customSeparator = v === "custom";
              if (v === "custom") ctx.rerender();
              else set("wordSeparator", v);
            },
          },
          ...SEPARATORS.map(([v, key]) => h("option", { value: v, selected: !sepCustom && v === g.wordSeparator }, t(key))),
          h("option", { value: "custom", selected: sepCustom }, t("separatorCustom")),
        ),
      ),
    );
  // The worker keeps the alias settings, encrypted (a token is a secret; no localStorage).
  const aliasVendor: AliasVendor = (ALIAS_VENDORS as readonly string[]).includes(str(g.aliasVendor)) ? (g.aliasVendor as AliasVendor) : "simplelogin";
  if (g.type === "alias" && gst.alias === undefined && gst.aliasLoadingFor !== aliasVendor) void loadAlias(ctx, aliasVendor);
  const aliasReady = !!gst.alias && gst.alias.vendor === aliasVendor && missingAliasFields(gst.alias).length === 0;
  const switchAlias = (v: AliasVendor) => {
    gst.alias = undefined;
    gst.generated = "";
    gst.error = undefined;
    set("aliasVendor", v);
  };
  let options: HTMLElement;
  if (g.type === "password")
    options = h(
      "div",
      { class: "group" },
      slider("length", t("length"), 5, 128),
      h("div", { class: "row" }, h("div", { class: "body" }, h("span", { class: "title" }, t("include"))), h("div", { class: "chips", role: "group", "aria-label": t("include") }, ...SETS.map(setChip))),
      toggle("avoidAmbiguous", t("avoidAmbiguous")),
      h(
        "details",
        { class: "row-details", open: gst.minimumsOpen, ontoggle: (e: Event) => (gst.minimumsOpen = (e.target as HTMLDetailsElement).open) },
        h("summary", { class: "row" }, h("div", { class: "body" }, h("span", { class: "title" }, t("minimums"))), icon("chevronDown")),
        g.uppercase === true ? stepRow("minUppercase", t("minUppercase"), 0, 9) : null,
        g.lowercase === true ? stepRow("minLowercase", t("minLowercase"), 0, 9) : null,
        g.numbers === true ? stepRow("minNumber", t("minDigits"), 0, 20) : null,
        g.special === true ? stepRow("minSpecial", t("minSymbols"), 0, 20) : null,
      ),
    );
  else if (g.type === "passphrase")
    options = h(
      "div",
      { class: "group" },
      slider("numWords", t("words"), 3, 20),
      separatorRow(),
      sepCustom ? text("wordSeparator", t("separatorCustom"), { type: "text", class: "small-input", maxLength: 3, "data-autofocus": "1" }) : null,
      toggle("capitalize", t("capitalize")),
      toggle("includeNumber", t("includeNumber")),
      h(
        "div",
        { class: "row" },
        h("div", { class: "body" }, h("span", { class: "title" }, t("wordlist")), h("span", { class: "sub" }, custom ? t("wordlistCustom", String(gst.wordlist)) : t("wordlistDefault"))),
        custom
          ? iconButton("close", t("wordlistReset"), async () => {
              const r = await send({ type: "setWordlist", text: "" });
              if (r.ok) gst.wordlist = 0;
              else gst.error = r.error;
              void regenerate(ctx);
            })
          : null,
        h("label", { class: "btn text small" }, t("wordlistImport"), h("input", { type: "file", class: "sr-only", accept: ".txt,.wordlist,text/plain", onchange: (e: Event) => void importWordlist(ctx, (e.target as HTMLInputElement).files?.[0]) })),
      ),
    );
  else if (g.type === "pin") options = h("div", { class: "group" }, slider("pinLength", t("length"), 3, 12));
  else if (g.type === "identity") {
    const p = gst.identity;
    const line = (key: string, title: string, value: string, sub?: string) =>
      h("div", { class: "row" }, h("div", { class: "body" }, h("span", { class: "label" }, title), h("span", { class: "value" }, value), sub ? h("span", { class: "sub" }, sub) : null), copyButton(ctx, `id.${key}`, value, t("copyField", title)));
    const country = h(
      "div",
      { class: "row" },
      h("div", { class: "body" }, h("span", { class: "title" }, t("field_country"))),
      withChevron(
        h(
          "select",
          { "aria-label": t("field_country"), onchange: (e: Event) => set("identityCountry", (e.target as HTMLSelectElement).value) },
          h("option", { value: "", selected: !g.identityCountry }, t("anyCountry")),
          ...gst.identityCountries.map(([code, name]) => h("option", { value: code, selected: g.identityCountry === code }, name)),
        ),
      ),
    );
    options = h(
      "div",
      { class: "stack" },
      p
        ? h(
            "div",
            { class: "group" },
            line("first", t("field_firstName"), p.firstName),
            line("last", t("field_lastName"), p.lastName),
            line("birth", t("birthDate"), p.birthDate, t("ageYears", String(p.age))),
            line("user", t("field_username"), p.username),
            line("city", t("field_city"), p.city),
            line("country", t("field_country"), p.country),
          )
        : null,
      h("div", { class: "group" }, country, stepRow("identityMinAge", t("minAge"), 13, Number(g.identityMaxAge)), stepRow("identityMaxAge", t("maxAge"), Number(g.identityMinAge), 99)),
    );
  }
  else if (g.type === "alias") {
    const info = ALIAS_INFO[aliasVendor];
    const saved = gst.alias;
    // `typing`: saved as it is typed, since closing the popup fires no change event and would lose a
    // pasted key. A re-render would take the focus, so that and any error wait for the change event.
    const save = (patch: Partial<AliasSettings>, typing = false) => {
      if (!saved) return;
      // gst.alias, not `saved`: a field typed into before the last re-render must not undo another.
      const next = { ...(gst.alias ?? saved), ...patch, vendor: aliasVendor };
      gst.alias = next;
      // The address on screen was made with the old settings, and making a new one is the user's
      // click, not a side effect of typing a key.
      gst.generated = "";
      gst.error = undefined;
      void (async () => {
        const r = await send({ type: "setAliasSettings", settings: next });
        if (typing) return;
        if (!r.ok) gst.error = r.error;
        ctx.rerender();
      })();
    };
    const input = (field: AliasField, label: string, hint: string, props: Record<string, unknown>) =>
      h(
        "label",
        { class: "row" },
        h("div", { class: "body" }, h("span", { class: "title" }, label), h("span", { class: "sub wrap" }, hint)),
        h("input", {
          ...props,
          value: saved ? str(saved[field]) : "",
          disabled: !saved, // edits before the settings arrive would be dropped
          "aria-label": label,
          spellcheck: false,
          autocomplete: "off",
          oninput: (e: Event) => save({ [field]: (e.target as HTMLInputElement).value } as Partial<AliasSettings>, true),
          onchange: (e: Event) => save({ [field]: (e.target as HTMLInputElement).value } as Partial<AliasSettings>),
        }),
      );
    options = h(
      "div",
      {},
      h(
        "div",
        { class: "group" },
        h(
          "div",
          { class: "row" },
          h("div", { class: "body" }, h("span", { class: "title" }, t("aliasService")), h("span", { class: "sub wrap" }, t("aliasServiceHint"))),
          withChevron(
            h(
              "select",
              { "aria-label": t("aliasService"), onchange: (e: Event) => switchAlias((e.target as HTMLSelectElement).value as AliasVendor) },
              ...ALIAS_VENDORS.map((v) => h("option", { value: v, selected: v === aliasVendor }, ALIAS_INFO[v].name)),
            ),
          ),
        ),
        input("token", t("aliasApiKey"), t("aliasApiKeyHint"), { type: "password" }),
        info.fields.includes("domain") ? input("domain", t("aliasDomain"), t("aliasDomainHint"), { type: "text", placeholder: "example.com" }) : null,
        info.selfHost ? input("baseUrl", t("aliasBaseUrl"), t("aliasBaseUrlHint"), { type: "text", placeholder: info.baseUrl }) : null,
        info.fields.includes("prefix")
          ? h(
              "label",
              { class: "row" },
              h("div", { class: "body" }, h("span", { class: "title" }, t("aliasWebsitePrefix")), h("span", { class: "sub wrap" }, t("aliasWebsitePrefixHint"))),
              h("span", { class: "switch" }, h("input", { type: "checkbox", checked: saved?.prefix === true, disabled: !saved, "aria-label": t("aliasWebsitePrefix"), onchange: (e: Event) => save({ prefix: (e.target as HTMLInputElement).checked }) }), h("span")),
            )
          : null,
      ),
      info.help
        ? h("button", { type: "button", class: "btn text small", onclick: () => void chrome.tabs.create({ url: info.help! }) }, t("aliasGetToken", info.name))
        : null,
    );
  } else
    options = h(
      "div",
      {},
      h("div", { class: "chips", role: "group", "aria-label": t("usernameType") }, chip("word", t("usernameWord"), "usernameType"), chip("plus", t("usernamePlus"), "usernameType"), chip("catchall", t("usernameCatchAll"), "usernameType"), chip("subdomain", t("usernameSubdomain"), "usernameType")),
      h(
        "div",
        { class: "group" },
        ...(g.usernameType === "plus" || g.usernameType === "subdomain"
          ? [text("email", t("email"), { type: "email", disabled: gst.prefs !== "loaded" })]
          : g.usernameType === "catchall"
            ? [text("domain", t("domain"), { placeholder: "example.com", disabled: gst.prefs !== "loaded" })]
            : [toggle("capitalize", t("capitalize")), toggle("includeNumber", t("includeNumber"))]),
      ),
    );
  return h(
    "div",
    { class: "page" },
    topBar(pick ? iconButton("back", t("back"), pick.back) : null, h("h1", { class: "grow" }, t("generator")), iconButton("timer", t("generatorHistory"), () => void openHistory(ctx))),
    h(
      "div",
      { class: "chips scroll", role: "group", "aria-label": t("generator") },
      ...[
        chip("password", t("typePassword")),
        chip("passphrase", t("typePassphrase")),
        chip("pin", t("typePin")),
        chip("username", t("username")),
        chip("alias", t("forwardedEmailShort")),
        chip("identity", t("typeIdentity")),
      ].filter((_, i) => !pick || (pick.field === "password" ? i < 3 : i === 3 || i === 4)),
    ),
    g.type === "alias" && !gst.generated ? null : h(
      "div",
      { class: "generated" },
      h(
        "div",
        { class: "generated-row" },
        h(
          "output",
          { class: g.type === "identity" ? "plain" : "mono", "aria-live": "polite", "aria-label": t("generatedValue") },
          ...(gst.generated ? colorize(gst.generated) : ["…"]),
        ),
        h(
          "div",
          { class: "trailing" },
          iconButton("refresh", t("regenerate"), () => void (g.type === "alias" ? generateAliasNow(ctx) : regenerate(ctx))),
          iconButton(
            "copy",
            t("copyField", t("generatedValue")),
            () => {
              void copy(ctx, gst.generated);
              if (g.type !== "identity") void send({ type: "generatorHistoryAdd", value: gst.generated });
            },
            { disabled: !gst.generated },
          ),
        ),
      ),
      g.type === "identity"
        ? null
        : h("div", { class: "generated-foot" }, gst.generated && g.type !== "alias" ? strengthBar(gst.generated) : null, gst.generated && g.type !== "alias" ? h("span", { class: "meter-label" }, strength(gst.generated).label) : null),
    ),
    options,
    g.type === "alias" && !gst.generated
      ? aliasReady
        ? h("button", { type: "button", class: "btn filled wide", onclick: () => void generateAliasNow(ctx) }, t("generateEmail"))
        : h("p", { class: "caption" }, t("aliasNotConfigured"))
      : null,
    gst.suggestions.length
      ? h(
          "div",
          {},
          sectionTitle(t("suggestions")),
          h("div", { class: "group", role: "list" }, ...gst.suggestions.map((v, i) => h("div", { class: "row", role: "listitem" }, h("div", { class: "body" }, h("span", { class: "title mono ellipsis" }, ...colorize(v)), h("span", { class: "sub" }, t("characters", String(v.length)))), copyButton(ctx, `sug.${i}`, v, t("copyField", t("generatedValue")))))),
        )
      : null,
    pick && gst.generated
      ? h(
          "div",
          { class: "editor-footer" },
          h("button", { type: "button", class: "btn filled wide", onclick: () => pick.use(gst.generated) }, icon("check"), t(pick.field === "password" ? "usePassword" : "useUsername")),
          // Named for what it is: custom fields fill page fields by id, name or label, so "Email" lands in an email box.
          pick.addField ? h("button", { type: "button", class: "btn tonal wide", onclick: () => pick.addField!(customFieldName(gst.generated), gst.generated) }, icon("plus"), t("addAsCustomField", customFieldName(gst.generated))) : null,
        )
      : null,
    !pick && g.type === "identity" && gst.identity
      ? actionRow("plus", t("createIdentityWithThis"), () => {
          const p = gst.identity!;
          ctx.goto("vault");
          // Bitwarden identities have no birth date: it goes in a custom field, with the age it gives today.
          startEdit(
            ctx,
            {
              type: 4, favorite: false, reprompt: 0, folderId: null, organizationId: null,
              name: `${p.firstName} ${p.lastName}`,
              identity: { firstName: p.firstName, lastName: p.lastName, username: p.username, city: p.city, country: p.country },
              fields: [{ name: t("birthDate"), value: p.birthDate, type: 0, linkedId: null }, { name: t("age"), value: String(p.age), type: 0, linkedId: null }],
            },
            {},
            true,
          );
        })
      : !pick && gst.generated
      ? actionRow("plus", t(g.type === "alias" ? "createLoginWithEmail" : g.type === "username" ? "createLoginWithUsername" : "createLoginWithPassword"), () => {
          ctx.goto("vault");
          startEdit(ctx, undefined, { data: { [g.type === "username" || g.type === "alias" ? "username" : "password"]: gst.generated } });
        })
      : null,
    errorBox(),
  );
}
