// 1Password's .1pux export: a ZIP whose export.data is JSON (accounts → vaults → items). The layout is 1Password's
// published 1PUX format; nothing here is copied code. Logins and passwords become logins, credit cards cards,
// identities identities; every other category (documents, licences, routers, ...) becomes a secure note whose
// fields are custom fields. Concealed values stay hidden fields. Trashed items are left out. With more than one
// vault, each vault becomes a folder.
import type { Imported } from "./import-csv.ts";
import { readZipEntry } from "./zip.ts";

type Json = Record<string, unknown>;
const o = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const a = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");

const MAX_DATA = 64 * 1024 * 1024;

export async function onePuxToExport(zip: Uint8Array): Promise<Imported> {
  const data = await readZipEntry(zip, (n) => n === "export.data" || n.endsWith("/export.data"), MAX_DATA);
  if (!data) throw new Error("This is not a 1Password .1pux export");
  return onePuxDataToExport(JSON.parse(new TextDecoder().decode(data)) as unknown);
}

/** One field's value as text, and whether 1Password conceals it. */
function valueOf(v: unknown): { text: string; concealed: boolean; kind: string } {
  const [kind, raw] = Object.entries(o(v))[0] ?? ["", ""];
  if (kind === "email") return { text: typeof raw === "string" ? raw : s(o(raw).email_address), concealed: false, kind };
  if (kind === "address") {
    const ad = o(raw);
    return { text: [ad.street, ad.city, ad.state, ad.zip, ad.country].map(s).filter(Boolean).join(", "), concealed: false, kind };
  }
  if (kind === "date" && typeof raw === "number") return { text: new Date(raw * 1000).toISOString().slice(0, 10), concealed: false, kind };
  return { text: s(raw), concealed: kind === "concealed" || kind === "totp", kind };
}

interface Field {
  id: string;
  title: string;
  text: string;
  concealed: boolean;
  kind: string;
  raw: unknown;
}

export function onePuxDataToExport(doc: unknown): Imported {
  const vaults = a(o(doc).accounts).flatMap((acc) => a(o(acc).vaults));
  if (!vaults.length) throw new Error("This is not a 1Password .1pux export");
  const folders = vaults.length > 1 ? vaults.map((v, i) => ({ id: String(i), name: s(o(o(v).attrs).name) || "--" })) : [];
  const items: Json[] = [];
  vaults.forEach((vault, vi) => {
    for (const raw of a(o(vault).items)) {
      const it = o(raw);
      if (it.trashed === true || it.state === "trashed") continue;
      items.push(item(it, folders.length ? String(vi) : null));
    }
  });
  return { folders, items };
}

function item(it: Json, folderId: string | null): Json {
  const details = o(it.details);
  const overview = o(it.overview);
  const category = s(it.categoryUuid);
  const fields: Field[] = a(details.sections).flatMap((sec) =>
    a(o(sec).fields).map((f) => ({ id: s(o(f).id), title: s(o(f).title), ...valueOf(o(f).value), raw: o(o(f).value) })),
  );
  const taken = new Set<Field>();
  const take = (pred: (f: Field) => boolean): string => {
    const f = fields.find((x) => !taken.has(x) && x.text && pred(x));
    if (f) taken.add(f);
    return f?.text ?? "";
  };
  const byId = (...ids: string[]) => take((f) => ids.includes(f.id));
  const common: Json = {
    name: s(overview.title) || "--",
    notes: s(details.notesPlain) || null,
    favorite: Number(it.favIndex) > 0,
    reprompt: 0,
    folderId,
  };
  let typed: Json;
  if (category === "001" || category === "005") {
    const loginFields = a(details.loginFields).map(o);
    const designated = (d: string) => loginFields.find((f) => f.designation === d);
    const user = designated("username");
    const pass = designated("password");
    const extra = loginFields.filter((f) => f !== user && f !== pass && s(f.value) && f.fieldType !== "B" && f.fieldType !== "I");
    const urls = a(overview.urls).map((u) => s(o(u).url)).filter(Boolean);
    if (!urls.length && s(overview.url)) urls.push(s(overview.url));
    typed = {
      type: 1,
      login: { username: s(user?.value) || null, password: s(pass?.value) || s(details.password) || null, totp: take((f) => f.kind === "totp") || null, uris: urls.map((uri) => ({ uri, match: null })) },
      passwordHistory: a(details.passwordHistory).map((p) => ({ password: s(o(p).value), lastUsedDate: new Date(Number(o(p).time) * 1000 || Date.now()).toISOString() })).filter((p) => p.password).slice(0, 5),
      loginExtra: extra.map((f) => ({ name: s(f.name) || s(f.designation) || s(f.id), value: s(f.value), type: f.fieldType === "P" ? 1 : 0 })),
    };
  } else if (category === "002") {
    const expiry = byId("expiry");
    typed = {
      type: 3,
      card: {
        cardholderName: byId("cardholder") || null,
        brand: byId("type") || null,
        number: byId("ccnum") || null,
        code: byId("cvv") || null,
        expMonth: expiry.length === 6 ? String(Number(expiry.slice(4))) : null,
        expYear: expiry.length === 6 ? expiry.slice(0, 4) : null,
      },
    };
  } else if (category === "004") {
    const address = fields.find((f) => f.kind === "address" && !taken.has(f));
    if (address) taken.add(address);
    const ad = o(o(address?.raw).address);
    typed = {
      type: 4,
      identity: {
        firstName: byId("firstname") || null,
        middleName: byId("initial") || null,
        lastName: byId("lastname") || null,
        company: byId("company") || null,
        email: byId("email") || take((f) => f.kind === "email") || null,
        phone: byId("defphone", "cellphone", "homephone", "busphone") || take((f) => f.kind === "phone") || null,
        username: byId("username") || null,
        address1: s(ad.street) || null,
        city: s(ad.city) || null,
        state: s(ad.state) || null,
        postalCode: s(ad.zip) || null,
        country: s(ad.country).toUpperCase() || null,
      },
    };
  } else typed = { type: 2, secureNote: { type: 0 } };
  const { loginExtra, ...rest } = typed as Json & { loginExtra?: unknown[] };
  const custom = fields.filter((f) => !taken.has(f) && f.text).map((f) => ({ name: f.title || f.id, value: f.text, type: f.concealed ? 1 : 0 }));
  return { ...common, ...rest, fields: [...a(loginExtra), ...custom] };
}
